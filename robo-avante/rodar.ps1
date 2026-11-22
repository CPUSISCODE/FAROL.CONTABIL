# Farol Contábil - roda o robô do Avante (chamado pela tarefa agendada). Repasse argumentos, ex.: rodar.ps1 --meses 2026-09,2026-10
$ErrorActionPreference = 'Stop'
$BASE = $PSScriptRoot
Add-Type -AssemblyName System.Security
$utf8 = New-Object System.Text.UTF8Encoding($false)
$arq = Join-Path $BASE 'segredo.bin'
if (Test-Path $arq) { $env:FAROL_AVANTE_SENHA = $utf8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($arq), $utf8.GetBytes('farol-robo-avante'), 'LocalMachine')) }
try { & (Join-Path $BASE 'node\node.exe') (Join-Path $BASE 'robo.js') @args; exit $LASTEXITCODE }
finally { Remove-Item Env:FAROL_AVANTE_SENHA -ErrorAction SilentlyContinue }
