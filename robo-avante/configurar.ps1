# Farol Contábil - configuração do robô do Avante Web (CPUSIS)
# Roda uma vez no computador da CPUSIS: guarda o login do Avante (criptografado neste computador),
# abre o Edge para você digitar o código de 2 fatores, lista as empresas do Painel do Parceiro,
# liga cada empresa à pasta do cliente no Drive e agenda o robô para toda noite.
param([switch]$SoFuncoes)
$ErrorActionPreference = 'Stop'
$BASE = $PSScriptRoot
$SO_FUNCOES_ROBO = [bool]$SoFuncoes
. (Join-Path $BASE 'instalar.ps1') -SoFuncoes -Origem (Join-Path $BASE 'processador')
$VERSAO_ROBO = '1.0'
$TAREFA_ROBO = 'Farol Robô Avante (CPUSIS)'
$TAREFA_PROC = 'Farol Processador XML manuais (CPUSIS)'
Add-Type -AssemblyName System.Security

function Guardar-Segredo([string]$texto) {
  $b = [Security.Cryptography.ProtectedData]::Protect($UTF8.GetBytes($texto), $UTF8.GetBytes('farol-robo-avante'), 'LocalMachine')
  [IO.File]::WriteAllBytes((Join-Path $BASE 'segredo.bin'), $b)
}
function Ler-Segredo {
  $arq = Join-Path $BASE 'segredo.bin'; if (-not (Test-Path $arq)) { return '' }
  return $UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($arq), $UTF8.GetBytes('farol-robo-avante'), 'LocalMachine'))
}
function Node-Robo([string[]]$argumentos) {
  $env:FAROL_AVANTE_SENHA = Ler-Segredo
  try { & (Join-Path $BASE 'node\node.exe') (Join-Path $BASE 'robo.js') @argumentos 2>&1 | ForEach-Object { Write-Host ('      ' + $_) }; return $LASTEXITCODE }
  finally { Remove-Item Env:FAROL_AVANTE_SENHA -ErrorAction SilentlyContinue }
}
function Achar-Edge { foreach ($p in @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe")) { if ($p -and (Test-Path $p)) { return $p } }; return '' }

function Configurar {
  Clear-Host
  Write-Host ''
  Write-Host ('  FAROL CONTÁBIL  |  robô do Avante Web ' + $VERSAO_ROBO + '  (CPUSIS)') -ForegroundColor White
  Write-Host '  Baixa os XML e os relatórios financeiros dos clientes do Avante e manda para o Farol.'
  Write-Host '  O robô SÓ CONSULTA E BAIXA: nunca altera nada no Avante.'
  if (-not (Ser-Admin)) { Erro 'abra como administrador (botão direito > Executar como administrador).'; return $false }
  if (-not (Achar-Edge)) { Erro 'o Microsoft Edge não está instalado neste computador. Instale o Edge e rode de novo.'; return $false }

  $arqCfg = Join-Path $BASE 'config.json'
  $antigo = $null; if (Test-Path $arqCfg) { try { $antigo = Get-Content $arqCfg -Raw -Encoding UTF8 | ConvertFrom-Json } catch { } }

  # 1) receptor do Farol
  Titulo '1. Conexão com o Farol'
  $senha = $(if ($antigo) { [string]$antigo.senha } else { '' })
  while ($true) {
    if (-not $senha) { $senha = PerguntarSenha 'Senha do receptor (a mesma dos agentes)' }
    try { $r = Chamar-Receptor @{ acao = 'ping'; senha = $senha } 60; if ($r.ok) { Ok 'conectado ao Farol'; break }; Erro ([string]$r.erro); $senha = '' }
    catch { Erro ('sem acesso ao Google: ' + $_.Exception.Message); if (-not (SimNao 'Tentar de novo?')) { return $false } }
  }
  $estrutura = @(); try { $e = Chamar-Receptor @{ acao = 'estrutura'; senha = $senha } 180; if ($e.ok) { $estrutura = @($e.contabilidades) } } catch { }

  # 2) login do Avante (fica criptografado só neste computador)
  Titulo '2. Login do Avante (Painel do Parceiro)'
  $usuario = $(if ($antigo) { [string]$antigo.usuarioAvante } else { '' })
  if (-not $usuario -or -not (Test-Path (Join-Path $BASE 'segredo.bin')) -or (SimNao 'Trocar o login do Avante?' $false)) {
    $usuario = Perguntar 'E-mail do login do Avante' $usuario
    Guardar-Segredo (PerguntarSenha 'Senha do Avante')
    Ok 'login guardado criptografado neste computador'
  }
  $cfgRobo = [ordered]@{ versao = $VERSAO_ROBO; receptorUrl = $RECEPTOR_URL; senha = $senha; usuarioAvante = $usuario; diasMesAnterior = 10; financeiro = $true; tipos = @('NFe', 'NFCe', 'CTe', 'MDFe', 'NFe Entradas'); empresas = @($(if ($antigo) { $antigo.empresas })) }
  [IO.File]::WriteAllText($arqCfg, ($cfgRobo | ConvertTo-Json -Depth 6), $UTF8)

  # 3) entra no painel (o Edge abre: digite o código de 2 fatores se pedir) e lista as empresas
  Titulo '3. Empresas do Painel do Parceiro'
  Info 'O Edge vai abrir. Se o Avante pedir o código de 2 fatores, digite no Edge. É só desta vez.'
  if ((Node-Robo @('--listar')) -ne 0 -or -not (Test-Path (Join-Path $BASE 'empresas.json'))) { Erro 'não consegui entrar no Painel do Parceiro (veja as mensagens acima).'; return $false }
  $lista = @(Get-Content (Join-Path $BASE 'empresas.json') -Raw -Encoding UTF8 | ConvertFrom-Json)
  for ($i = 0; $i -lt $lista.Count; $i++) {
    $ja = @($cfgRobo.empresas | Where-Object { $_.cnpj -eq $lista[$i].cnpj }).Count
    Write-Host ('   ' + ($i + 1).ToString().PadLeft(2) + ') ' + (Formatar-Cnpj $lista[$i].cnpj) + '  ' + $lista[$i].nome + $(if ($ja) { '  [já configurada]' } else { '' }))
  }
  $sel = @(); while (-not $sel.Count) { $sel = @(Ler-Selecao (Perguntar 'Quais empresas o robô deve buscar? (ex.: 1,3-5; Enter = todas)' '') $lista.Count) }

  # 4) para onde vai cada empresa no Drive
  Titulo '4. Para onde vão os arquivos no Drive'
  $nomesContab = @($estrutura | ForEach-Object { [string]$_.nome })
  $escolhidas = @($sel | ForEach-Object { $lista[$_] })
  $novas = @()
  foreach ($a in $escolhidas) {
    $antE = @($cfgRobo.empresas | Where-Object { $_.cnpj -eq $a.cnpj }) | Select-Object -First 1
    $nomeLimpo = Nome-Pasta (($a.nome -replace '\s*-\s*[\d]+\s*$', ''))
    Write-Host ''; Write-Host ('  >> ' + (Formatar-Cnpj $a.cnpj) + '  ' + $nomeLimpo) -ForegroundColor White
    if ($antE -and (SimNao ('Manter ' + $antE.contabilidade + ' / ' + $antE.cliente + $(if ($antE.subpasta) { ' / ' + $antE.subpasta } else { '' }) + '?') $true)) { $novas += $antE; continue }
    $ic = $(if ($nomesContab.Count) { Escolher 'Contabilidade' $nomesContab -1 'outra (digitar o nome)' } else { -1 })
    if ($ic -ge 0) { $contab = $nomesContab[$ic]; $clientes = @($estrutura[$ic].clientes | ForEach-Object { [string]$_.nome }) } else { $contab = Nome-Pasta (Perguntar 'Nome da contabilidade (pasta no Drive)'); $clientes = @() }
    if ($clientes.Count) { $icl = Escolher ('Cliente dentro de ' + $contab) $clientes ([array]::IndexOf($clientes, $nomeLimpo)) ('cliente novo (sugestão: ' + $nomeLimpo + ')'); $cliente = $(if ($icl -ge 0) { $clientes[$icl] } else { Nome-Pasta (Perguntar 'Nome do cliente' $nomeLimpo) }) }
    else { $cliente = Nome-Pasta (Perguntar 'Nome do cliente (pasta no Drive)' $nomeLimpo) }
    $sub = Nome-Pasta (Perguntar 'Subpasta (MATRIZ, FILIAL... Enter = sem subpasta)' (Sugerir-Subpasta ([pscustomobject]@{ cnpj = $a.cnpj }) @($lista | ForEach-Object { [pscustomobject]@{ cnpj = $_.cnpj } })))
    $novas += [ordered]@{ cnpj = $a.cnpj; nome = $nomeLimpo; contabilidade = $contab; cliente = $cliente; subpasta = $sub; ativo = $true }
    Ok ($contab + ' / ' + $cliente + $(if ($sub) { ' / ' + $sub } else { '' }))
  }
  $cfgRobo.empresas = @($novas)
  [IO.File]::WriteAllText($arqCfg, ($cfgRobo | ConvertTo-Json -Depth 6), $UTF8)
  try { & icacls.exe $BASE /grant '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /T /C /Q | Out-Null; & icacls.exe $arqCfg /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' ("$env:USERDOMAIN\$env:USERNAME" + ':F') /C /Q | Out-Null } catch { }
  Ok ('configuração gravada: ' + $novas.Count + ' empresa(s)')

  # 5) tarefas: robô à 1h30 (com o usuário deste computador, por causa do Edge) e processador dos XML às 4h30
  Titulo '5. Agendamento'
  Info 'O robô usa o Edge com o login deste usuário do Windows.'
  Info 'Para rodar mesmo com o Windows bloqueado ou sem ninguém logado, informe a senha deste usuário do Windows.'
  $senhaWin = PerguntarSenha ('Senha do Windows do usuário ' + $env:USERNAME + ' (Enter = rodar só com o usuário logado)')
  $acao = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $BASE 'rodar.ps1') + '"') -WorkingDirectory $BASE
  $quando = New-ScheduledTaskTrigger -Daily -At '01:30'
  $conf = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Hours 8) -MultipleInstances IgnoreNew
  $usr = "$env:USERDOMAIN\$env:USERNAME"
  if ($senhaWin) { Register-ScheduledTask -TaskName $TAREFA_ROBO -Action $acao -Trigger $quando -Settings $conf -User $usr -Password $senhaWin -RunLevel Highest -Force | Out-Null; Ok 'robô agendado para 1h30, mesmo sem ninguém logado' }
  else { Register-ScheduledTask -TaskName $TAREFA_ROBO -Action $acao -Trigger $quando -Settings $conf -Principal (New-ScheduledTaskPrincipal -UserId $usr -LogonType Interactive -RunLevel Highest) -Force | Out-Null; Aviso 'robô agendado para 1h30 - só roda com este usuário logado no Windows (pode deixar a tela bloqueada)' }
  # processador dos XML enviados à mão (gera os resumos do portal dos XML do robô e de quem manda à mão)
  $proc = Join-Path $BASE 'processador'
  $cp = [ordered]@{ receptorUrl = $RECEPTOR_URL; senha = $senha; sistema = 'lc'; vigia = $false; empresas = @() }
  [IO.File]::WriteAllText((Join-Path $proc 'config.json'), ($cp | ConvertTo-Json -Depth 4), $UTF8)
  try { & icacls.exe (Join-Path $proc 'config.json') /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' /C /Q | Out-Null } catch { }
  $acaoP = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $proc 'lcxml.ps1') + '" -Manuais')
  $quandoP = @((New-ScheduledTaskTrigger -Daily -At '04:30'), (New-ScheduledTaskTrigger -Daily -At '12:30'))
  Register-ScheduledTask -TaskName $TAREFA_PROC -Action $acaoP -Trigger $quandoP -Principal (New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest) -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 5) -MultipleInstances IgnoreNew) -Force | Out-Null
  Ok 'processador dos XML agendado para 4h30 e 12h30 (monta os resumos do portal)'

  # 6) teste
  Titulo '6. Teste'
  if (SimNao 'Fazer um teste agora com a primeira empresa, só baixando para a pasta "saida" (sem enviar)?' $true) {
    $cfgT = $cfgRobo | ConvertTo-Json -Depth 6 | ConvertFrom-Json; $cfgT.empresas = @($cfgT.empresas | Select-Object -First 1)
    Copy-Item $arqCfg ($arqCfg + '.completo') -Force
    [IO.File]::WriteAllText($arqCfg, ($cfgT | ConvertTo-Json -Depth 6), $UTF8)
    try { [void](Node-Robo @('--so-baixar', '--visivel')) } finally { Move-Item ($arqCfg + '.completo') $arqCfg -Force }
    Info ('Confira os arquivos em ' + (Join-Path $BASE 'saida'))
  }
  if (SimNao 'Enviar agora para o Farol (mês atual de todas as empresas)?' $false) {
    Start-ScheduledTask -TaskName $TAREFA_ROBO; Ok 'robô iniciado em segundo plano (log em C:\FarolRobo\logs)'
  }
  return $true
}

if ($SO_FUNCOES_ROBO) { return }
$ok = $false
try { $ok = Configurar } catch { Erro $_.Exception.Message }
Write-Host ''
if ($ok) { Write-Host '  Pronto! O robô roda toda noite à 1h30. Os arquivos aparecem no portal depois do processador (4h30).' -ForegroundColor Green }
else { Write-Host '  A configuração não terminou. Mande um print desta tela para a CPUSIS.' -ForegroundColor Red }
Write-Host ''
Read-Host '  Pressione Enter para fechar' | Out-Null
