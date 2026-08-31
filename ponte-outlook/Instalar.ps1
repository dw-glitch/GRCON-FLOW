<#
    GRCON Flow — instalação da ponte local do Outlook.

    Cria a credencial deste computador, grava a configuração e registra a tarefa
    agendada. Ao final imprime o código de pareamento, que é colado no painel
    para ativar a ponte.

    O segredo em si nunca sai daqui: ele é criptografado pelo Windows e o
    servidor recebe apenas a verificação (SHA-256). Não exige administrador e
    pode ser desfeito por completo com Desinstalar.ps1.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $EmailDaQualidade,
    [string] $Endpoint = 'https://hbfcqkbjrcmpdljlklol.supabase.co/functions/v1/flow-external-intake',
    [string] $Rotulo = "Outlook de $env:COMPUTERNAME",
    [string] $Pasta = 'GRCON Flow',
    [string] $PastaProcessados = 'Processados',
    [string] $PastaErros = 'Erros',
    [switch] $Substituir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$NOME_DA_TAREFA = 'GRCON Flow - Ponte Outlook'
$RAIZ = Join-Path $env:LOCALAPPDATA 'GRCON Flow\ponte'
$CONFIG = Join-Path $RAIZ 'config.json'
$CREDENCIAL = Join-Path $RAIZ 'credencial.txt'
$SCRIPT = Join-Path $RAIZ 'GrconFlowPonte.ps1'

function Parar {
    param([Parameter(Mandatory)] [string] $Motivo)
    Write-Host ''
    Write-Host "Instalação interrompida: $Motivo" -ForegroundColor Red
    exit 1
}

if ($EmailDaQualidade -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') {
    Parar 'informe um e-mail válido da equipe da Qualidade.'
}
$EmailDaQualidade = $EmailDaQualidade.Trim().ToLowerInvariant()

# Uma política corporativa que bloqueia scripts precisa aparecer agora, e não
# em silêncio daqui a um minuto, quando a tarefa agendada falhar sozinha.
$politica = Get-ExecutionPolicy
if ($politica -in @('Restricted', 'AllSigned')) {
    Parar ("a política de execução do PowerShell é '$politica' e impede rodar a ponte. " +
        'Peça ao setor responsável para permitir scripts locais neste usuário.')
}

if (-not (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) {
    Parar 'este Windows não expõe o agendador de tarefas ao PowerShell.'
}

# Só olhamos a tarefa com o nome exato do GRCON Flow. Automações antigas de
# Outlook que existam nesta máquina não são tocadas nem listadas.
$tarefaExistente = Get-ScheduledTask -TaskName $NOME_DA_TAREFA -ErrorAction SilentlyContinue
if ($tarefaExistente -and -not $Substituir) {
    Parar ("já existe uma ponte instalada ($NOME_DA_TAREFA). " +
        'Rode novamente com -Substituir para trocar a credencial deste computador.')
}

New-Item -ItemType Directory -Path $RAIZ -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'GrconFlowPonte.ps1') -Destination $SCRIPT -Force

# Credencial nova a cada instalação: trocar de computador exige nova conexão.
$bytes = New-Object byte[] 48
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$segredo = [Convert]::ToBase64String($bytes)

$sha = [Security.Cryptography.SHA256]::Create()
$hash = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($segredo)) | ForEach-Object { $_.ToString('x2') })

# ConvertFrom-SecureString usa o DPAPI: o arquivo só é legível por este usuário
# neste computador. Copiá-lo para outra máquina não o torna utilizável.
ConvertTo-SecureString -String $segredo -AsPlainText -Force |
    ConvertFrom-SecureString |
    Set-Content -LiteralPath $CREDENCIAL -Encoding utf8
$segredo = $null

[ordered]@{
    bridge_id          = [guid]::NewGuid().ToString()
    submitted_by_email = $EmailDaQualidade
    endpoint           = $Endpoint
    pasta              = $Pasta
    pasta_processados  = $PastaProcessados
    pasta_erros        = $PastaErros
} | ConvertTo-Json | Set-Content -LiteralPath $CONFIG -Encoding utf8

$configuracao = Get-Content -LiteralPath $CONFIG -Raw -Encoding utf8 | ConvertFrom-Json

# A varredura é de um minuto porque o evento instantâneo do Outlook pode perder
# itens quando muitos e-mails chegam juntos. -WindowStyle Hidden mantém o
# trabalho invisível; nenhuma janela de console aparece durante o expediente.
$acao = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument (
    '-NoProfile -NonInteractive -WindowStyle Hidden -File "{0}" -ConfigPath "{1}"' -f $SCRIPT, $CONFIG
)
$gatilho = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 1)
$ajustes = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask -TaskName $NOME_DA_TAREFA -Action $acao -Trigger $gatilho -Settings $ajustes `
    -Description 'Envia ao GRCON Flow os e-mails da pasta GRCON Flow do Outlook clássico.' `
    -Force | Out-Null

$pareamento = [ordered]@{
    bridge_id          = $configuracao.bridge_id
    secret_hash        = $hash
    submitted_by_email = $configuracao.submitted_by_email
    label              = $Rotulo
} | ConvertTo-Json -Compress

Write-Host ''
Write-Host 'Ponte instalada.' -ForegroundColor Green
Write-Host ''
Write-Host 'No Outlook clássico, confirme que a caixa de entrada tem esta estrutura:'
Write-Host ("  {0}" -f $Pasta)
Write-Host ("    {0}" -f $PastaProcessados)
Write-Host ("    {0}" -f $PastaErros)
Write-Host ''
Write-Host 'Agora abra o GRCON Flow em Painel -> Entradas externas e cole o código abaixo'
Write-Host 'em "Código de pareamento". Ele não contém o segredo desta máquina.'
Write-Host ''
Write-Host $pareamento
Write-Host ''
