<#
    GRCON Flow — teste de compatibilidade da ponte.

    Confere, sem instalar nada e sem mover nenhum e-mail, se este computador
    consegue rodar a ponte: versão do Windows, política de execução, Outlook
    clássico aberto, pastas criadas e acesso HTTPS ao GRCON Flow.

    É seguro rodar quantas vezes quiser: nada é gravado, enviado ou alterado.
#>

[CmdletBinding()]
param(
    [string] $Endpoint = 'https://hbfcqkbjrcmpdljlklol.supabase.co/functions/v1/flow-external-intake',
    [string] $Pasta = 'GRCON Flow'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$resultados = @()

function Registrar {
    param(
        [Parameter(Mandatory)] [string] $Item,
        [Parameter(Mandatory)] [bool] $Ok,
        [Parameter(Mandatory)] [string] $Detalhe
    )
    $script:resultados += [pscustomobject]@{ Verificação = $Item; Situação = $(if ($Ok) { 'ok' } else { 'atenção' }); Detalhe = $Detalhe }
}

Registrar 'PowerShell' ($PSVersionTable.PSVersion.Major -ge 5) ("versão $($PSVersionTable.PSVersion)")

$politica = Get-ExecutionPolicy
Registrar 'Política de execução' ($politica -notin @('Restricted', 'AllSigned')) `
    "$politica (Restricted e AllSigned impedem a ponte)"

Registrar 'Agendador de tarefas' ([bool](Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) `
    'necessário para a varredura de um minuto'

# A automação COM existe no Outlook clássico e não no novo Outlook. Este é o
# ponto que decide se a ponte é viável neste computador.
$outlook = $null
try { $outlook = [Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application') } catch { }
Registrar 'Outlook clássico aberto' ([bool]$outlook) `
    $(if ($outlook) { 'automação disponível' } else { 'abra o Outlook clássico e rode de novo' })

if ($outlook) {
    try {
        $entrada = $outlook.GetNamespace('MAPI').GetDefaultFolder(6)
        $monitorada = $null
        foreach ($item in $entrada.Folders) { if ($item.Name -eq $Pasta) { $monitorada = $item } }
        Registrar "Pasta '$Pasta'" ([bool]$monitorada) `
            $(if ($monitorada) { "$($monitorada.Items.Count) mensagem(ns) aguardando" } else { 'crie a pasta na caixa de entrada' })
        if ($monitorada) {
            foreach ($nome in @('Processados', 'Erros')) {
                $sub = $null
                foreach ($item in $monitorada.Folders) { if ($item.Name -eq $nome) { $sub = $item } }
                Registrar "Subpasta '$nome'" ([bool]$sub) `
                    $(if ($sub) { 'pronta' } else { "crie '$nome' dentro de $Pasta" })
            }
        }
    } catch {
        Registrar 'Leitura das pastas' $false 'o Outlook recusou a automação nesta sessão'
    }
}

# O endpoint recusa quem não tem credencial: um 401 é a resposta correta e
# prova que a rede da empresa deixa o computador falar com o GRCON Flow.
try {
    $resposta = Invoke-WebRequest -Method Post -Uri $Endpoint -TimeoutSec 30 `
        -Body '{}' -ContentType 'application/json' -SkipHttpErrorCheck
    Registrar 'Acesso HTTPS ao GRCON Flow' ($resposta.StatusCode -in @(401, 400, 422)) `
        "resposta HTTP $($resposta.StatusCode) — sem credencial, recusar é o esperado"
} catch {
    Registrar 'Acesso HTTPS ao GRCON Flow' $false `
        'a rede bloqueou a conexão; verifique proxy ou filtro de saída'
}

$tarefa = Get-ScheduledTask -TaskName 'GRCON Flow - Ponte Outlook' -ErrorAction SilentlyContinue
Registrar 'Instalação anterior' $true `
    $(if ($tarefa) { 'já existe uma ponte instalada; use -Substituir para trocar' } else { 'nenhuma; o nome está livre' })

$resultados | Format-Table -AutoSize
Write-Host ''
if ($resultados | Where-Object { $_.Situação -ne 'ok' }) {
    Write-Host 'Resolva os itens marcados como atenção antes de instalar.' -ForegroundColor Yellow
} else {
    Write-Host 'Este computador está pronto para a ponte.' -ForegroundColor Green
}
