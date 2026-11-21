# Farol Contábil - atualizador do agente (CPUSIS)
# Troca só o programa (lcxml.ps1) pela versão nova. Configuração, empresas, senhas e logs ficam como estão.
param([string]$Novo)
$ErrorActionPreference = 'Stop'
function Ok($t) { Write-Host ('  OK  ' + $t) -ForegroundColor Green }
function Aviso($t) { Write-Host ('  !!  ' + $t) -ForegroundColor Yellow }
function Versao($arq) { try { $m = Select-String -Path $arq -Pattern "\`$VERSAO\s*=\s*'([\d.]+)'" -List; if ($m) { return $m.Matches[0].Groups[1].Value } } catch { }; return '?' }

Write-Host ''
Write-Host '  FAROL CONTÁBIL  |  atualizador do agente  (CPUSIS)' -ForegroundColor White
$vNova = Versao $Novo
Write-Host ('  Versão nova: ' + $vNova)
Write-Host ''

# 1) onde o agente está instalado: pelas tarefas agendadas e pela pasta padrão
$pastas = @{}
$tarefas = @()
try { $tarefas = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { ($_.Actions | ForEach-Object { $_.Arguments }) -match 'lcxml\.ps1' }) } catch { Aviso ('não consegui ler as tarefas agendadas: ' + $_.Exception.Message) }
foreach ($t in $tarefas) {
  foreach ($a in $t.Actions) {
    if ($a.Arguments -match '-File\s+"?([^"]*lcxml\.ps1)"?') { $p = Split-Path $matches[1] -Parent; if (-not $pastas.ContainsKey($p)) { $pastas[$p] = @() }; $pastas[$p] += $t.TaskName }
  }
}
foreach ($p in @('C:\LCXML', 'C:\Program Files\LCXML', 'C:\LC XML')) { if ($p -and [IO.File]::Exists([IO.Path]::Combine($p, 'config.json')) -and -not $pastas.ContainsKey($p)) { $pastas[$p] = @() } }
if (-not $pastas.Count) { Aviso 'não achei nenhuma instalação do agente neste computador. Use o instalador.'; exit 1 }
if ($pastas.Count -gt 1) { Aviso ('este computador tem ' + $pastas.Count + ' instalações do agente - todas serão atualizadas:') }

$erros = 0
foreach ($p in $pastas.Keys) {
  $alvo = Join-Path $p 'lcxml.ps1'
  Write-Host ''
  Write-Host ('  Pasta: ' + $p) -ForegroundColor White
  if ($pastas[$p].Count) { Write-Host ('  Tarefas: ' + ($pastas[$p] -join ', ')) }
  $emps = ''; try { $cfg = Get-Content (Join-Path $p 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json; $emps = (@($cfg.empresas) | ForEach-Object { $_.cliente + $(if ($_.subpasta) { ' / ' + $_.subpasta } else { '' }) }) -join ', ' } catch { }
  if ($emps) { Write-Host ('  Empresas: ' + $emps) }
  $vAnt = $(if (Test-Path $alvo) { Versao $alvo } else { '(sem programa)' })
  Write-Host ('  Versão atual: ' + $vAnt)
  try {
    if (Test-Path $alvo) { Copy-Item $alvo ($alvo + '.anterior') -Force }
    Copy-Item $Novo $alvo -Force
    try { Unblock-File $alvo } catch { }
    $e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($alvo, [ref]$null, [ref]$e)
    if ($e.Count) { throw ('o arquivo novo não abriu: ' + $e[0].Message) }
    # teste de leitura pelo PowerShell (pega bloqueio de antivírus)
    $teste = & powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { [void][scriptblock]::Create((Get-Content -LiteralPath '$alvo' -Raw)); 'ok' } catch { `$_.Exception.Message }" 2>&1
    if ("$teste" -ne 'ok') { throw ('o Windows bloqueou o arquivo novo: ' + $teste) }
    Ok ('atualizado: ' + $vAnt + ' -> ' + (Versao $alvo))
  } catch {
    $erros++
    Aviso ('ERRO: ' + $_.Exception.Message)
    if (Test-Path ($alvo + '.anterior')) { Copy-Item ($alvo + '.anterior') $alvo -Force; Aviso 'voltei a versão anterior (o envio continua funcionando)' }
  }
  # a tarefa precisa rodar como SYSTEM para conseguir se atualizar sozinha nas próximas vezes
  foreach ($tn in $pastas[$p]) {
    try {
      $t = Get-ScheduledTask -TaskName $tn -ErrorAction Stop
      if ($t.Principal.UserId -notmatch 'SYSTEM|SISTEMA') {
        Set-ScheduledTask -TaskName $tn -Principal (New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest) | Out-Null
        Ok ('tarefa "' + $tn + '" passou a rodar como SYSTEM (antes: ' + $t.Principal.UserId + ')')
      }
    } catch { Aviso ('não consegui conferir a tarefa "' + $tn + '": ' + $_.Exception.Message) }
  }
  # permissão de gravação na pasta para o SYSTEM e administradores (a falta dela impede a atualização automática)
  try { & icacls.exe $p /grant '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /T /C /Q | Out-Null; Ok 'permissões da pasta conferidas' } catch { }
}
Write-Host ''
if ($erros) { Write-Host '  Terminou com erro - mande um print desta tela para a CPUSIS.' -ForegroundColor Red }
else { Write-Host '  Pronto! Na próxima rodada da noite o agente já roda na versão nova e passa a se atualizar sozinho.' -ForegroundColor Green }
Write-Host ''
Read-Host '  Pressione Enter para fechar' | Out-Null
