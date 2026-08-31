<#
    GRCON Flow — remoção da ponte local do Outlook.

    Remove a tarefa agendada, a configuração e a credencial deste computador.
    Não toca em nenhuma outra automação do Outlook nem em nada dentro do
    Outlook: as pastas, os e-mails já processados e o histórico permanecem.

    Depois de desinstalar, revogue a ponte no painel do GRCON Flow para que a
    credencial deixe de ser aceita pelo servidor.
#>

[CmdletBinding()]
param(
    [switch] $ManterRegistro
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$NOME_DA_TAREFA = 'GRCON Flow - Ponte Outlook'
$RAIZ = Join-Path $env:LOCALAPPDATA 'GRCON Flow\ponte'

# Procura apenas pelo nome exato. Uma automação antiga de Outlook com outro
# nome não é candidata a remoção nem é listada aqui.
$tarefa = Get-ScheduledTask -TaskName $NOME_DA_TAREFA -ErrorAction SilentlyContinue
if ($tarefa) {
    Unregister-ScheduledTask -TaskName $NOME_DA_TAREFA -Confirm:$false
    Write-Host "Tarefa '$NOME_DA_TAREFA' removida." -ForegroundColor Green
} else {
    Write-Host "Nenhuma tarefa '$NOME_DA_TAREFA' encontrada." -ForegroundColor Yellow
}

foreach ($arquivo in @('credencial.txt', 'config.json', 'GrconFlowPonte.ps1')) {
    $caminho = Join-Path $RAIZ $arquivo
    if (Test-Path -LiteralPath $caminho) { Remove-Item -LiteralPath $caminho -Force }
}

if (-not $ManterRegistro) {
    $log = Join-Path $RAIZ 'ponte.log'
    if (Test-Path -LiteralPath $log) { Remove-Item -LiteralPath $log -Force }
}

if ((Test-Path -LiteralPath $RAIZ) -and -not (Get-ChildItem -LiteralPath $RAIZ -Force)) {
    Remove-Item -LiteralPath $RAIZ -Force
}

Write-Host ''
Write-Host 'Ponte removida deste computador.' -ForegroundColor Green
Write-Host 'Revogue a ponte em Painel -> Entradas externas para encerrar a credencial no servidor.'
