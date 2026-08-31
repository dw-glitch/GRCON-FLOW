<#
    GRCON Flow — ponte local do Outlook clássico.

    Lê a pasta "GRCON Flow" da caixa de entrada, envia as mensagens ao endpoint
    HTTPS do GRCON Flow e move cada uma para "Processados" ou "Erros".

    Três decisões explicam quase todo o código:

    1. A varredura é periódica, não instantânea. O evento ItemAdd do Outlook
       pode perder itens quando muitos e-mails são arrastados de uma vez, então
       o que vale é olhar a pasta de tempos em tempos.
    2. Nada é movido enquanto a pasta é percorrida. Mover durante a iteração
       reindexa a coleção e faz o laço pular mensagens; por isso o script
       primeiro coleta tudo e só depois move.
    3. Uma falha de rede nunca perde e-mail. Se o envio não confirmar, a
       mensagem fica onde está e a próxima execução tenta de novo — a proteção
       contra duplicidade no servidor cuida do reenvio.

    Não envia e-mails, não abre o Outlook e não olha nenhuma outra pasta.
#>

[CmdletBinding()]
param(
    [string] $ConfigPath = (Join-Path $env:LOCALAPPDATA 'GRCON Flow\ponte\config.json'),
    [switch] $Verificar
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$MAX_POR_LOTE = 100
$MAX_BYTES_LOTE = 2400000
$MAX_CARACTERES_CORPO = 20000

# ---------------------------------------------------------------------------
# Registro local
# ---------------------------------------------------------------------------

# O log guarda o suficiente para explicar uma falha e nada além disso: nunca
# assunto, corpo, remetente ou credencial.
function Write-Registro {
    param(
        [Parameter(Mandatory)] [string] $Mensagem,
        [ValidateSet('info', 'erro')] [string] $Nivel = 'info'
    )
    $pasta = Split-Path -Parent $script:CaminhoDoLog
    if (-not (Test-Path -LiteralPath $pasta)) {
        New-Item -ItemType Directory -Path $pasta -Force | Out-Null
    }
    $linha = '{0} [{1}] {2}' -f (Get-Date).ToString('s'), $Nivel, $Mensagem
    Add-Content -LiteralPath $script:CaminhoDoLog -Value $linha -Encoding utf8
    if ($Verificar) { Write-Host $linha }
    # Um log que cresce sem limite acaba sendo o único efeito visível da ponte.
    $arquivo = Get-Item -LiteralPath $script:CaminhoDoLog
    if ($arquivo.Length -gt 1MB) {
        $conteudo = Get-Content -LiteralPath $script:CaminhoDoLog -Tail 2000
        Set-Content -LiteralPath $script:CaminhoDoLog -Value $conteudo -Encoding utf8
    }
}

# ---------------------------------------------------------------------------
# Configuração e credencial
# ---------------------------------------------------------------------------

function Get-Configuracao {
    param([Parameter(Mandatory)] [string] $Caminho)
    if (-not (Test-Path -LiteralPath $Caminho)) {
        throw "Configuração não encontrada em $Caminho. Execute Instalar.ps1 primeiro."
    }
    $dados = Get-Content -LiteralPath $Caminho -Raw -Encoding utf8 | ConvertFrom-Json
    foreach ($campo in @('bridge_id', 'submitted_by_email', 'endpoint', 'pasta', 'pasta_processados', 'pasta_erros')) {
        if (-not $dados.PSObject.Properties.Name.Contains($campo) -or -not $dados.$campo) {
            throw "Configuração incompleta: falta '$campo'."
        }
    }
    if ($dados.PSObject.Properties.Name -contains 'secret') {
        throw 'A configuração não pode conter o segredo. Reinstale a ponte.'
    }
    return $dados
}

# O segredo é protegido pelo DPAPI do Windows e amarrado a este usuário e a
# esta máquina. Copiar o arquivo para outro computador não o torna utilizável.
function Get-Segredo {
    param([Parameter(Mandatory)] [string] $Caminho)
    if (-not (Test-Path -LiteralPath $Caminho)) {
        throw "Credencial não encontrada em $Caminho. Execute Instalar.ps1 novamente."
    }
    $protegido = Get-Content -LiteralPath $Caminho -Raw -Encoding utf8
    $seguro = ConvertTo-SecureString -String $protegido.Trim()
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($seguro)
    )
}

# ---------------------------------------------------------------------------
# Outlook
# ---------------------------------------------------------------------------

# Só usamos uma instância que já esteja aberta. Iniciar o Outlook por conta
# própria assustaria quem está no computador e abriria uma segunda sessão.
function Get-OutlookAberto {
    try {
        return [Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application')
    } catch {
        return $null
    }
}

function Get-SubPasta {
    param(
        [Parameter(Mandatory)] $Pai,
        [Parameter(Mandatory)] [string] $Nome
    )
    foreach ($pasta in $Pai.Folders) {
        if ($pasta.Name -eq $Nome) { return $pasta }
    }
    return $null
}

# O Exchange devolve um endereço X.500 no SenderEmailAddress. Sem converter
# para SMTP, o contato do solicitante ficaria ilegível na solicitação.
function Get-EnderecoSmtp {
    param([Parameter(Mandatory)] $Item)
    try {
        if ($Item.SenderEmailType -eq 'SMTP' -and $Item.SenderEmailAddress) {
            return $Item.SenderEmailAddress
        }
    } catch { }
    try {
        $acesso = $Item.PropertyAccessor
        $smtp = $acesso.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x39FE001E')
        if ($smtp) { return $smtp }
    } catch { }
    try {
        $remetente = $Item.Sender
        if ($remetente) {
            $usuario = $remetente.GetExchangeUser()
            if ($usuario -and $usuario.PrimarySmtpAddress) { return $usuario.PrimarySmtpAddress }
        }
    } catch { }
    return ''
}

function Get-IdentificadorDaMensagem {
    param([Parameter(Mandatory)] $Item)
    try {
        $acesso = $Item.PropertyAccessor
        $id = $acesso.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x1035001E')
        if ($id) { return $id }
    } catch { }
    # Sem Message-ID da internet, o EntryID identifica a mensagem nesta caixa.
    return $Item.EntryID
}

function ConvertTo-Entrada {
    param([Parameter(Mandatory)] $Item)

    $corpo = ''
    try { $corpo = [string]$Item.Body } catch { $corpo = '' }
    if ($corpo.Length -gt $MAX_CARACTERES_CORPO) { $corpo = $corpo.Substring(0, $MAX_CARACTERES_CORPO) }

    $anexos = @()
    try {
        foreach ($anexo in $Item.Attachments) {
            # Nesta fase só os metadados viajam. O arquivo continua no Outlook,
            # o que mantém banco e Storage fora do caminho do lote.
            $anexos += [ordered]@{
                name         = [string]$anexo.FileName
                size         = [int]$anexo.Size
                content_type = ''
                inline       = $false
            }
            if ($anexos.Count -ge 30) { break }
        }
    } catch { }

    $recebido = (Get-Date).ToUniversalTime()
    try { $recebido = ([datetime]$Item.ReceivedTime).ToUniversalTime() } catch { }

    return [ordered]@{
        external_id      = [string](Get-IdentificadorDaMensagem -Item $Item)
        source_item_id   = [string]$Item.EntryID
        sender_name      = [string]$Item.SenderName
        sender_email     = [string](Get-EnderecoSmtp -Item $Item)
        subject          = [string]$Item.Subject
        body_text        = $corpo
        received_at      = $recebido.ToString('o')
        attachment_count = $anexos.Count
        attachments      = $anexos
    }
}

# ---------------------------------------------------------------------------
# Envio
# ---------------------------------------------------------------------------

function Send-Lote {
    param(
        [Parameter(Mandatory)] $Configuracao,
        [Parameter(Mandatory)] [string] $Segredo,
        [Parameter(Mandatory)] [array] $Entradas
    )
    $corpo = [ordered]@{
        source             = 'outlook'
        submitted_by_email = $Configuracao.submitted_by_email
        items              = $Entradas
    } | ConvertTo-Json -Depth 6 -Compress

    $cabecalhos = @{
        'x-grcon-flow-bridge-id' = $Configuracao.bridge_id
        'x-grcon-flow-secret'    = $Segredo
        'content-type'           = 'application/json; charset=utf-8'
    }
    return Invoke-RestMethod -Method Post -Uri $Configuracao.endpoint -Headers $cabecalhos `
        -Body ([Text.Encoding]::UTF8.GetBytes($corpo)) -TimeoutSec 90
}

# O lote é dividido por quantidade e por tamanho. Um único e-mail com corpo
# longo pode estourar o limite de bytes muito antes dos cem itens.
function Split-EmLotes {
    param([Parameter(Mandatory)] [array] $Entradas)
    $lotes = @()
    $atual = @()
    $bytes = 0
    foreach ($entrada in $Entradas) {
        $tamanho = [Text.Encoding]::UTF8.GetByteCount(($entrada | ConvertTo-Json -Depth 6 -Compress))
        if ($atual.Count -gt 0 -and (($atual.Count -ge $MAX_POR_LOTE) -or (($bytes + $tamanho) -gt $MAX_BYTES_LOTE))) {
            $lotes += , $atual
            $atual = @()
            $bytes = 0
        }
        $atual += $entrada
        $bytes += $tamanho
    }
    if ($atual.Count -gt 0) { $lotes += , $atual }
    return $lotes
}

# ---------------------------------------------------------------------------
# Execução
# ---------------------------------------------------------------------------

function Invoke-Ponte {
    $configuracao = Get-Configuracao -Caminho $ConfigPath
    $segredo = Get-Segredo -Caminho (Join-Path (Split-Path -Parent $ConfigPath) 'credencial.txt')

    $outlook = Get-OutlookAberto
    if (-not $outlook) {
        Write-Registro 'outlook_fechado: nada a fazer nesta execução.'
        return
    }

    $namespace = $outlook.GetNamespace('MAPI')
    $entrada = $namespace.GetDefaultFolder(6)  # olFolderInbox
    $pasta = Get-SubPasta -Pai $entrada -Nome $configuracao.pasta
    if (-not $pasta) {
        Write-Registro ("pasta_ausente: crie '{0}' na caixa de entrada." -f $configuracao.pasta) -Nivel erro
        return
    }
    $processados = Get-SubPasta -Pai $pasta -Nome $configuracao.pasta_processados
    $erros = Get-SubPasta -Pai $pasta -Nome $configuracao.pasta_erros
    if (-not $processados -or -not $erros) {
        Write-Registro 'subpastas_ausentes: crie Processados e Erros dentro da pasta monitorada.' -Nivel erro
        return
    }

    if ($pasta.Items.Count -eq 0) {
        # Pasta vazia não gera chamada: é o que mantém o consumo do plano
        # gratuito perto de zero nos dias sem movimento.
        return
    }

    # Primeiro colhe, depois move. Mover durante a iteração faria o laço pular
    # mensagens justamente quando várias são arrastadas de uma vez.
    $coletados = @()
    $indice = 1
    while ($indice -le $pasta.Items.Count -and $coletados.Count -lt $MAX_POR_LOTE) {
        $item = $pasta.Items.Item($indice)
        $indice++
        try {
            if ($item.Class -ne 43) { continue }  # olMail
            $coletados += [pscustomobject]@{ Item = $item; Entrada = (ConvertTo-Entrada -Item $item) }
        } catch {
            Write-Registro 'item_ilegivel: uma mensagem não pôde ser lida e ficou na pasta.' -Nivel erro
        }
    }
    if ($coletados.Count -eq 0) { return }

    $porEntryId = @{}
    foreach ($coletado in $coletados) { $porEntryId[$coletado.Entrada.source_item_id] = $coletado.Item }

    $aceitos = 0
    $duplicados = 0
    $invalidos = 0
    foreach ($lote in (Split-EmLotes -Entradas ($coletados | ForEach-Object { $_.Entrada }))) {
        try {
            $resposta = Send-Lote -Configuracao $configuracao -Segredo $segredo -Entradas $lote
        } catch {
            # Sem confirmação, nada se move. O e-mail continua na pasta e a
            # próxima execução tenta de novo.
            Write-Registro ('envio_falhou: {0} mensagem(ns) permanecem na pasta.' -f $lote.Count) -Nivel erro
            continue
        }

        foreach ($resultado in @($resposta.items)) {
            $item = $porEntryId[[string]$resultado.source_item_id]
            if (-not $item) { continue }
            try { $item.Move($processados) | Out-Null } catch {
                Write-Registro 'mover_falhou: a mensagem foi recebida mas não saiu da pasta.' -Nivel erro
            }
            if ($resultado.duplicate) { $duplicados++ } else { $aceitos++ }
        }
        foreach ($falha in @($resposta.errors)) {
            $item = $porEntryId[[string]$falha.source_item_id]
            if (-not $item) { continue }
            try { $item.Move($erros) | Out-Null } catch { }
            $invalidos++
        }
    }

    Write-Registro ('lote: aceitos={0} duplicados={1} invalidos={2}' -f $aceitos, $duplicados, $invalidos)
}

# Duas execuções simultâneas moveriam a mesma mensagem duas vezes. O mutex é
# por usuário e some sozinho se o processo morrer.
$script:CaminhoDoLog = Join-Path (Split-Path -Parent $ConfigPath) 'ponte.log'
$mutex = New-Object System.Threading.Mutex($false, 'Local\GRCON-Flow-Ponte-Outlook')
if (-not $mutex.WaitOne(0)) {
    Write-Registro 'execucao_em_andamento: esta rodada foi ignorada.'
    return
}
try {
    Invoke-Ponte
} catch {
    Write-Registro ('falha: {0}' -f $_.Exception.GetType().Name) -Nivel erro
    exit 1
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
