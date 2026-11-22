# Farol Contábil - instalador do agente (CPUSIS)
# Instala o agente (lcxml.ps1) num servidor com LC Sistemas (MySQL) ou Gestores (PostgreSQL):
# conecta no banco SÓ PARA LEITURA, acha as empresas pelos próprios XML, deixa escolher a contabilidade
# e o cliente no Drive, grava a configuração e cria a tarefa agendada.
# A senha do receptor NÃO fica gravada neste instalador: é digitada na instalação (ou lida do conexao.txt ao lado do .exe).
param([string]$Origem = $PSScriptRoot, [string]$PastaExe = '', [switch]$SoFuncoes)
$ErrorActionPreference = 'Stop'
$RECEPTOR_URL = 'https://script.google.com/macros/s/AKfycbwySsHymDOemTCxV-Oe-j4B0xHK1OIOtBDF-KjIdhHA0cf9YmLoUcP3AnRVpgW1AZLU/exec'
$TAREFA = 'LC XML Contabilidade (CPUSIS)'
$TAREFA_VIGIA = 'LC XML Vigia MySQL (CPUSIS)'
$PASTA_PADRAO = 'C:\LCXML'
$UTF8 = New-Object System.Text.UTF8Encoding($false)
$UTF8_ESTRITO = New-Object System.Text.UTF8Encoding($false, $true)
$LATIN1 = [System.Text.Encoding]::GetEncoding(28591)

function Titulo($t) { Write-Host ''; Write-Host ('  ' + $t) -ForegroundColor Cyan; Write-Host ('  ' + ('-' * $t.Length)) -ForegroundColor DarkCyan }
function Ok($t) { Write-Host ('  OK  ' + $t) -ForegroundColor Green }
function Aviso($t) { Write-Host ('  !!  ' + $t) -ForegroundColor Yellow }
function Erro($t) { Write-Host ('  XX  ' + $t) -ForegroundColor Red }
function Info($t) { Write-Host ('      ' + $t) }
function Perguntar([string]$t, [string]$padrao = '') {
  $p = '  ' + $t + $(if ($padrao) { ' [' + $padrao + ']' } else { '' }) + ': '
  $r = Read-Host $p
  if ([string]::IsNullOrWhiteSpace($r)) { return $padrao }
  return $r.Trim()
}
function PerguntarSenha([string]$t) {
  $s = Read-Host ('  ' + $t) -AsSecureString
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
function SimNao([string]$t, [bool]$padrao = $true) {
  while ($true) {
    $r = (Perguntar ($t + ' (S/N)') $(if ($padrao) { 'S' } else { 'N' })).ToUpper()
    if ($r -in @('S', 'SIM')) { return $true }
    if ($r -in @('N', 'NAO', 'NÃO')) { return $false }
  }
}
# menu numerado; devolve o índice escolhido (0..n-1), ou -1 para "outro"
function Escolher([string]$t, [string[]]$opcoes, [int]$padrao = 0, [string]$outro = '') {
  Write-Host ''
  Write-Host ('  ' + $t) -ForegroundColor White
  for ($i = 0; $i -lt $opcoes.Count; $i++) { Write-Host ('   ' + ($i + 1).ToString().PadLeft(2) + ') ' + $opcoes[$i]) }
  if ($outro) { Write-Host ('    0) ' + $outro) }
  while ($true) {
    $r = Perguntar 'Número' $(if ($padrao -ge 0 -and $opcoes.Count) { [string]($padrao + 1) } else { '' })
    if ($outro -and $r -eq '0') { return -1 }
    $n = 0
    if ([int]::TryParse($r, [ref]$n) -and $n -ge 1 -and $n -le $opcoes.Count) { return ($n - 1) }
    Aviso 'digite um dos números da lista'
  }
}

# ---------------------------------------------------------------- texto dos XML (o banco guarda em hex)
function Hex-ParaTexto([string]$h) {
  $h = ($h -replace '[^0-9A-Fa-f]', '')
  if (-not $h -or ($h.Length % 2)) { return '' }
  $b = New-Object byte[] ($h.Length / 2)
  for ($i = 0; $i -lt $b.Length; $i++) { $b[$i] = [Convert]::ToByte($h.Substring(2 * $i, 2), 16) }
  try { $t = $UTF8_ESTRITO.GetString($b) } catch { $t = $LATIN1.GetString($b) }
  return $t.TrimStart([char]0xFEFF)
}
# CNPJ, razão social e fantasia do emitente de um XML de NF-e/NFC-e
function Emitente-DoXml([string]$x) {
  $r = @{ cnpj = ''; nome = ''; fantasia = '' }
  if ($x -match '(?s)<emit>(.*?)</emit>') {
    $e = $matches[1]
    if ($e -match '<CNPJ>(\d{14})</CNPJ>') { $r.cnpj = $matches[1] } elseif ($e -match '<CPF>(\d{11})</CPF>') { $r.cnpj = $matches[1] }
    if ($e -match '<xNome>([^<]*)</xNome>') { $r.nome = [System.Net.WebUtility]::HtmlDecode($matches[1]).Trim() }
    if ($e -match '<xFant>([^<]*)</xFant>') { $r.fantasia = [System.Net.WebUtility]::HtmlDecode($matches[1]).Trim() }
  }
  return $r
}
function Formatar-Cnpj([string]$c) { if ($c -match '^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$') { return ('{0}.{1}.{2}/{3}-{4}' -f $matches[1], $matches[2], $matches[3], $matches[4], $matches[5]) }; return $c }
function Nome-Pasta([string]$s) { return (($s -replace '[\\/:*?"<>|]', ' ') -replace '\s+', ' ').Trim().ToUpper() }
# sugestão de subpasta: só quando há mais de uma empresa com a mesma raiz de CNPJ (matriz e filiais)
function Sugerir-Subpasta($emp, $todas) {
  if (-not $emp.cnpj -or $emp.cnpj.Length -ne 14) { return '' }
  $mesma = @($todas | Where-Object { $_.cnpj -and $_.cnpj.Length -eq 14 -and $_.cnpj.Substring(0, 8) -eq $emp.cnpj.Substring(0, 8) })
  if ($mesma.Count -lt 2) { return '' }
  if ($emp.cnpj.Substring(8, 4) -eq '0001') { return 'MATRIZ' }
  $filiais = @($mesma | Where-Object { $_.cnpj.Substring(8, 4) -ne '0001' } | Sort-Object { $_.cnpj })
  if ($filiais.Count -eq 1) { return 'FILIAL' }
  return ('FILIAL ' + ([array]::IndexOf(@($filiais | ForEach-Object { $_.cnpj }), $emp.cnpj) + 1))
}
# "1,3-5" -> 0,2,3,4  (vazio = todos)
function Ler-Selecao([string]$r, [int]$total) {
  if ([string]::IsNullOrWhiteSpace($r) -or $r.Trim().ToUpper() -in @('T', 'TODAS', 'TODOS')) { return @(0..($total - 1)) }
  $sel = @()
  foreach ($parte in ($r -split '[,; ]+')) {
    if ($parte -match '^(\d+)-(\d+)$') { foreach ($n in ([int]$matches[1])..([int]$matches[2])) { $sel += ($n - 1) } }
    elseif ($parte -match '^\d+$') { $sel += ([int]$parte - 1) }
  }
  return @($sel | Where-Object { $_ -ge 0 -and $_ -lt $total } | Select-Object -Unique)
}

# ---------------------------------------------------------------- receptor (Google)
function Chamar-Receptor($obj, [int]$timeout = 120) {
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072 } catch { }
  $json = $obj | ConvertTo-Json -Depth 6 -Compress
  $r = Invoke-RestMethod -Uri $RECEPTOR_URL -Method Post -Body ($UTF8.GetBytes($json)) -ContentType 'application/json; charset=utf-8' -TimeoutSec $timeout
  if ($r -is [string]) { $r = $r | ConvertFrom-Json }
  return $r
}
function Senha-DoConexao([string]$pasta) {
  foreach ($nome in @('conexao.txt', 'conexão.txt')) {
    $arq = Join-Path $pasta $nome
    if ($pasta -and (Test-Path -LiteralPath $arq)) {
      foreach ($l in (Get-Content -LiteralPath $arq -Encoding UTF8)) {
        if ($l -match '^\s*"?senha"?\s*[:=]\s*"?([^"]+?)"?\s*,?\s*$') { return $matches[1].Trim() }
      }
    }
  }
  return ''
}

# ---------------------------------------------------------------- bancos de dados (sempre só leitura)
function Rodar([string]$exe, [string[]]$argv, [string]$entrada, [hashtable]$amb) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.Arguments = ($argv | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = $UTF8
  if ($amb) { foreach ($k in $amb.Keys) { $psi.EnvironmentVariables[$k] = [string]$amb[$k] } }
  $p = [System.Diagnostics.Process]::Start($psi)
  $p.StandardInput.WriteLine($entrada); $p.StandardInput.Close()
  $errT = $p.StandardError.ReadToEndAsync()
  $saida = $p.StandardOutput.ReadToEnd()
  if (-not $p.WaitForExit(180000)) { try { $p.Kill() } catch { }; throw 'o banco não respondeu em 3 minutos' }
  $err = (($errT.Result -split "`n") | Where-Object { $_.Trim() -and $_ -notmatch 'Using a password' }) -join ' '
  if ($p.ExitCode -ne 0) { throw $err }
  return @($saida -split "`r?`n" | Where-Object { $_ -ne '' })
}
function Sql-Mysql($c, [string]$sql, [string]$banco = '') {
  $a = @(('--host=' + $c.host), ('--port=' + $c.porta), ('--user=' + $c.usuario), '--batch', '--skip-column-names', '--default-character-set=utf8', '--connect-timeout=20')
  if ($c.senha) { $a += ('--password=' + $c.senha) }
  if ($banco) { $a += ('--database=' + $banco) }
  return (Rodar $c.exe $a ($sql + ';') $null)
}
function Sql-Pg($c, [string]$sql, [string]$banco = '') {
  $b = $(if ($banco) { $banco } else { 'postgres' })
  $a = @('-X', '-q', '-A', '-t', '-F', "`t", '-v', 'ON_ERROR_STOP=1', '-h', [string]$c.host, '-p', [string]$c.porta, '-U', [string]$c.usuario, '-d', $b)
  $amb = @{ PGPASSWORD = [string]$c.senha; PGCLIENTENCODING = 'UTF8'; PGCONNECT_TIMEOUT = '20'; PGAPPNAME = 'FarolContabil-instalador' }
  return (Rodar $c.exe $a ("SET default_transaction_read_only = on;`n" + $sql.TrimEnd(';') + ';') $amb)
}
# qual parte da conexão está errada, pela mensagem do banco
function Tipo-Erro([string]$m) {
  if ($m -match 'Access denied|authentication failed|password|senha|autentica|1045|28P01|role .* does not exist|papel .* n.o existe') { return 'login' }
  if ($m -match "Can't connect|could not connect|Connection refused|timeout|timed out|2003|2005|Unknown MySQL server host|could not translate host|n.o foi poss.vel conectar") { return 'servidor' }
  if ($m -match 'Unknown database|database .* does not exist|banco de dados .* n.o existe|1049|3D000') { return 'banco' }
  return 'outro'
}
function Achar-Exe([string]$nome, [string[]]$servicos) {
  $cands = @()
  foreach ($s in $servicos) {
    try {
      Get-CimInstance Win32_Service -ErrorAction Stop | Where-Object { $_.Name -match $s -or $_.DisplayName -match $s } | ForEach-Object {
        if ($_.PathName -match '^"?([^"]+\\bin)\\[^\\"]+\.exe') { $cands += (Join-Path $matches[1] $nome) }
      }
    } catch { }
  }
  foreach ($raiz in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, 'C:\', 'D:\')) {
    if (-not $raiz -or -not (Test-Path $raiz)) { continue }
    foreach ($padrao in @('MySQL\*\bin', 'MariaDB*\bin', 'PostgreSQL\*\bin', 'LC*\MySQL*\bin', 'LC*\mysql\bin', 'xampp\mysql\bin', 'wamp*\bin\mysql\*\bin', 'Gestores*\PostgreSQL\*\bin', 'Brajan*\PostgreSQL\*\bin')) {
      try { Get-ChildItem -Path (Join-Path $raiz $padrao) -Filter $nome -ErrorAction SilentlyContinue | ForEach-Object { $cands += $_.FullName } } catch { }
    }
  }
  $ok = @($cands | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique)
  if ($ok.Count) { return ($ok | Sort-Object { (Get-Item -LiteralPath $_).VersionInfo.FileVersion } -Descending | Select-Object -First 1) }
  return ''
}

# empresas do LC (id_empresa) com CNPJ e nome tirados do XML mais recente de cada uma
function Empresas-Lc($c, [string]$banco) {
  $ids = @{}
  $q = @(
    "SELECT id_empresa, MAX(id) FROM nfe WHERE xml IS NOT NULL AND xml<>'' AND dados_dataemissao>=DATE_SUB(CURDATE(), INTERVAL 400 DAY) GROUP BY id_empresa",
    "SELECT n.id_empresa, MAX(n.id) FROM nfce n JOIN nfcexml x ON x.id_nfce=n.id WHERE x.xml IS NOT NULL AND x.xml<>'' AND n.ide_dhemi>=DATE_SUB(CURDATE(), INTERVAL 400 DAY) GROUP BY n.id_empresa"
  )
  foreach ($i in 0..1) {
    try { foreach ($l in (Sql-Mysql $c $q[$i] $banco)) { $p = $l -split "`t"; if ($p[0] -match '^\d+$' -and -not $ids.ContainsKey($p[0])) { $ids[$p[0]] = @{ tab = $i; id = $p[1] } } } }
    catch { Aviso ('não consegui ler ' + $(if ($i) { 'as NFC-e' } else { 'as NF-e' }) + ': ' + $_.Exception.Message) }
  }
  $lista = @()
  foreach ($k in ($ids.Keys | Sort-Object { [int]$_ })) {
    $sql = $(if ($ids[$k].tab -eq 0) { "SELECT HEX(xml) FROM nfe WHERE id=$($ids[$k].id)" } else { "SELECT HEX(xml) FROM nfcexml WHERE id_nfce=$($ids[$k].id) AND xml IS NOT NULL AND xml<>'' LIMIT 1" })
    $em = @{ cnpj = ''; nome = ''; fantasia = '' }
    try { $h = @(Sql-Mysql $c $sql $banco); if ($h.Count) { $em = Emitente-DoXml (Hex-ParaTexto $h[0]) } } catch { }
    $lista += [pscustomobject]@{ id = [int]$k; cnpj = $em.cnpj; nome = $em.nome; fantasia = $em.fantasia }
  }
  return $lista
}
# filiais do Gestores (cod_filial) com CNPJ e nome tirados do XML mais recente de cada uma
function Empresas-Gestores($c, [string]$banco) {
  $fil = @()
  foreach ($q in @("SELECT DISTINCT cod_filial FROM mv_venda WHERE modelo='65' AND xml IS NOT NULL AND data>=current_date-400", "SELECT DISTINCT cod_filial FROM mv_nota_saida WHERE modelo='55' AND arquivo_xml IS NOT NULL AND data_emissao>=current_date-400")) {
    try { foreach ($l in (Sql-Pg $c $q $banco)) { if ($l.Trim() -match '^\d+$') { $fil += [int]$l.Trim() } } } catch { Aviso ('não consegui ler as filiais: ' + $_.Exception.Message) }
  }
  $lista = @()
  foreach ($f in ($fil | Sort-Object -Unique)) {
    $em = @{ cnpj = ''; nome = ''; fantasia = '' }
    foreach ($q in @("SELECT upper(encode(xml,'hex')) FROM mv_venda WHERE cod_filial=$f AND modelo='65' AND xml IS NOT NULL ORDER BY data DESC LIMIT 1",
                     "SELECT upper(encode(arquivo_xml,'hex')) FROM mv_nota_saida WHERE cod_filial=$f AND modelo='55' AND arquivo_xml IS NOT NULL ORDER BY data_emissao DESC LIMIT 1")) {
      if ($em.cnpj) { break }
      try { $h = @(Sql-Pg $c $q $banco); if ($h.Count) { $em = Emitente-DoXml (Hex-ParaTexto $h[0]) } } catch { }
    }
    $lista += [pscustomobject]@{ id = $f; cnpj = $em.cnpj; nome = $em.nome; fantasia = $em.fantasia }
  }
  return $lista
}

# ---------------------------------------------------------------- programa principal
function Ser-Admin { return ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
function Instalar {
  Clear-Host
  Write-Host ''
  Write-Host '  FAROL CONTÁBIL  |  instalador do agente  (CPUSIS)' -ForegroundColor White
  $vAgente = '?'; try { $m = Select-String -Path (Join-Path $Origem 'lcxml.ps1') -Pattern "\`$VERSAO\s*=\s*'([\d.]+)'" -List; if ($m) { $vAgente = $m.Matches[0].Groups[1].Value } } catch { }
  Write-Host ('  Agente versão ' + $vAgente + ' - LC Sistemas (MySQL) e Gestores (PostgreSQL)')
  Write-Host '  O agente só LÊ o banco do sistema: nunca grava nada nele.'

  if (-not (Ser-Admin)) { Erro 'abra o instalador como administrador (botão direito > Executar como administrador).'; return $false }

  # 1) pasta e instalação anterior
  $pasta = $PASTA_PADRAO
  $antigo = $null
  if (Test-Path (Join-Path $pasta 'config.json')) {
    try { $antigo = Get-Content (Join-Path $pasta 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
    Titulo 'Já existe uma instalação neste computador'
    if ($antigo) { Info ('Empresas: ' + ((@($antigo.empresas) | ForEach-Object { $_.cliente + $(if ($_.subpasta) { ' / ' + $_.subpasta } else { '' }) }) -join ', ')) }
    $op = Escolher 'O que fazer?' @('Só atualizar o programa (mantém tudo como está)', 'Configurar de novo (banco, empresas, contabilidade)') 0
    if ($op -eq 0) { Copiar-Programa $pasta; Garantir-Tarefa $pasta; Ok 'programa atualizado'; return $true }
  }

  # 2) senha do receptor
  Titulo '1. Conexão com o Farol (Google Drive)'
  $senha = ''
  $origemSenha = ''
  if ($antigo -and $antigo.senha) { $senha = [string]$antigo.senha; $origemSenha = 'instalação anterior' }
  elseif ($PastaExe) { $senha = Senha-DoConexao $PastaExe; if ($senha) { $origemSenha = 'conexao.txt' } }
  while ($true) {
    if (-not $senha) { $senha = PerguntarSenha 'Senha do receptor (a mesma dos outros agentes)' }
    try {
      $r = Chamar-Receptor @{ acao = 'ping'; senha = $senha } 60
      if ($r.ok) { Ok ('conectado ao Farol' + $(if ($origemSenha) { ' (senha da ' + $origemSenha + ')' } else { '' }) + ' - pasta "' + $r.raiz + '"'); break }
      Erro ([string]$r.erro); $senha = ''; $origemSenha = ''
    } catch {
      Erro ('sem acesso ao Google: ' + $_.Exception.Message)
      if (-not (SimNao 'Tentar de novo?')) { return $false }
    }
  }
  $estrutura = @()
  try { $e = Chamar-Receptor @{ acao = 'estrutura'; senha = $senha } 180; if ($e.ok) { $estrutura = @($e.contabilidades) } } catch { Aviso ('não consegui ler as contabilidades do Drive: ' + $_.Exception.Message) }

  # 3) sistema do cliente
  Titulo '2. Sistema do cliente'
  $temMy = $false; $temPg = $false
  try { $sv = @(Get-Service -ErrorAction Stop); $temMy = [bool]($sv | Where-Object { $_.Name -match 'mysql|mariadb' }); $temPg = [bool]($sv | Where-Object { $_.Name -match 'postgres' }) } catch { }
  $padraoSis = $(if ($temPg -and -not $temMy) { 1 } elseif ($antigo -and $antigo.sistema -eq 'gestores') { 1 } else { 0 })
  if ($temMy) { Info 'encontrei MySQL neste computador' }
  if ($temPg) { Info 'encontrei PostgreSQL neste computador' }
  $sistema = @('lc', 'gestores')[(Escolher 'Qual sistema este servidor usa?' @('LC Sistemas (MySQL)', 'Gestores / Brajan (PostgreSQL)') $padraoSis)]
  $ehLc = ($sistema -eq 'lc')
  $ant = $(if ($antigo) { if ($ehLc) { $antigo.mysql } else { $antigo.postgres } })

  # 4) conexão com o banco (só leitura)
  Titulo $(if ($ehLc) { '3. Banco do LC (MySQL)' } else { '3. Banco do Gestores (PostgreSQL)' })
  $exeNome = $(if ($ehLc) { 'mysql.exe' } else { 'psql.exe' })
  $c = [ordered]@{
    exe = $(if ($ant -and $ant.exe -and (Test-Path -LiteralPath $ant.exe)) { $ant.exe } else { Achar-Exe $exeNome $(if ($ehLc) { @('mysql', 'mariadb') } else { @('postgres') }) })
    host = $(if ($ant) { [string]$ant.host } else { 'localhost' }); porta = $(if ($ant) { [string]$ant.porta } else { $(if ($ehLc) { '3306' } else { '5432' }) })
    usuario = $(if ($ant) { [string]$ant.usuario } else { $(if ($ehLc) { 'root' } else { 'postgres' }) }); senha = $(if ($ant) { [string]$ant.senha } else { '' }); banco = $(if ($ant) { [string]$ant.banco } else { '' })
  }
  while (-not $c.exe -or -not (Test-Path -LiteralPath $c.exe)) {
    Aviso ('não achei o ' + $exeNome + ' neste computador.')
    $c.exe = Perguntar ('Caminho completo do ' + $exeNome + ' (ex.: ' + $(if ($ehLc) { 'C:\Program Files\MySQL\MySQL Server 5.7\bin\mysql.exe' } else { 'C:\Program Files\PostgreSQL\12\bin\psql.exe' }) + ')')
    $c.exe = $c.exe.Trim('"')
  }
  Ok ('programa do banco: ' + $c.exe)
  if (-not $ant) {
    $c.usuario = Perguntar ('Usuário do banco (o usuário do ' + $(if ($ehLc) { 'MySQL' } else { 'PostgreSQL' }) + ', não o nome do banco)') $c.usuario
    $c.senha = PerguntarSenha ('Senha do usuário ' + $c.usuario)
  }
  $bancos = @()
  while ($true) {
    try {
      if ($ehLc) { $bancos = @(Sql-Mysql $c "SELECT DISTINCT table_schema FROM information_schema.tables WHERE table_name='nfce' ORDER BY 1") }
      else {
        $bancos = @()
        foreach ($b in (Sql-Pg $c "SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY 1")) {
          try { if ((@(Sql-Pg $c "SELECT to_regclass('mv_venda') IS NOT NULL" $b.Trim()))[0] -eq 't') { $bancos += $b.Trim() } } catch { }
        }
      }
      Ok ('conectado em ' + $c.host + ':' + $c.porta + ' como ' + $c.usuario)
      break
    } catch {
      $m = $_.Exception.Message
      Erro ('o banco recusou: ' + $m)
      switch (Tipo-Erro $m) {
        'login' {
          Info ('Usuário ou senha do banco errados. Atenção: o USUÁRIO é o login do ' + $(if ($ehLc) { 'MySQL (normalmente root)' } else { 'PostgreSQL (normalmente postgres)' }) + ',')
          Info 'não o nome do banco. O nome do banco você escolhe no próximo passo.'
          $c.usuario = Perguntar 'Usuário do banco' $c.usuario
          $c.senha = PerguntarSenha ('Senha do usuário ' + $c.usuario)
        }
        'servidor' {
          Info 'O banco não respondeu nesse endereço. Confira se o serviço do banco está ligado.'
          $c.host = Perguntar 'Endereço do servidor do banco' $c.host
          $c.porta = Perguntar 'Porta' $c.porta
        }
        default {
          if (-not (SimNao 'Tentar de novo com outro usuário/senha?')) { return $false }
          $c.usuario = Perguntar 'Usuário do banco' $c.usuario
          $c.senha = PerguntarSenha ('Senha do usuário ' + $c.usuario)
        }
      }
    }
  }
  if (-not $bancos.Count) {
    Aviso ('não achei nenhum banco ' + $(if ($ehLc) { 'do LC (com a tabela nfce)' } else { 'do Gestores (com a tabela mv_venda)' }) + ' com esse usuário.')
    $c.banco = Perguntar 'Nome do banco' $(if ($c.banco) { $c.banco } elseif ($ehLc) { 'lc_sistemas' } else { 'gestores' })
  } elseif ($bancos.Count -eq 1) { $c.banco = $bancos[0]; Ok ('banco: ' + $c.banco) }
  else { $c.banco = $bancos[(Escolher 'Qual banco?' $bancos ([Math]::Max(0, [array]::IndexOf($bancos, $c.banco))))] }

  # 5) empresas pelos XML
  Titulo '4. Empresas'
  Info 'procurando as empresas pelos XML gravados no banco (pode levar alguns segundos)...'
  $achadas = @($(if ($ehLc) { Empresas-Lc $c $c.banco } else { Empresas-Gestores $c $c.banco }))
  if (-not $achadas.Count) {
    Aviso 'não achei nenhuma nota com XML neste banco.'
    $n = Perguntar $(if ($ehLc) { 'Código da empresa no LC (id_empresa)' } else { 'Código da filial no Gestores (cod_filial)' }) '1'
    $achadas = @([pscustomobject]@{ id = [int]$n; cnpj = ''; nome = ''; fantasia = '' })
  }
  Write-Host ''
  for ($i = 0; $i -lt $achadas.Count; $i++) {
    $a = $achadas[$i]
    Write-Host ('   ' + ($i + 1).ToString().PadLeft(2) + ') ' + $(if ($ehLc) { 'empresa ' } else { 'filial ' }) + $a.id + '  ' + (Formatar-Cnpj $a.cnpj) + '  ' + $a.nome + $(if ($a.fantasia -and $a.fantasia -ne $a.nome) { ' (' + $a.fantasia + ')' } else { '' }))
  }
  $sel = @()
  while (-not $sel.Count) { $sel = @(Ler-Selecao (Perguntar 'Quais enviar? (Enter = todas; ou ex.: 1,3)' '') $achadas.Count) }
  $escolhidas = @($sel | ForEach-Object { $achadas[$_] })

  # 6) contabilidade, cliente e subpasta de cada empresa
  Titulo '5. Para onde vão os XML no Drive'
  $nomesContab = @($estrutura | ForEach-Object { [string]$_.nome })
  $empresas = @()
  $ultimaContab = -1
  foreach ($a in $escolhidas) {
    Write-Host ''
    Write-Host ('  >> ' + (Formatar-Cnpj $a.cnpj) + '  ' + $a.nome) -ForegroundColor White
    $antE = $(if ($antigo) { @($antigo.empresas) | Where-Object { [int]$_.id -eq $a.id } | Select-Object -First 1 })
    if ($nomesContab.Count) {
      $pad = $(if ($antE) { [array]::IndexOf($nomesContab, [string]$antE.contabilidade) } else { $ultimaContab })
      $ic = Escolher 'Contabilidade' $nomesContab $pad 'outra (digitar o nome)'
    } else { $ic = -1 }
    if ($ic -ge 0) { $contab = $nomesContab[$ic]; $ultimaContab = $ic; $clientes = @($estrutura[$ic].clientes | ForEach-Object { [string]$_.nome }) }
    else { $contab = Nome-Pasta (Perguntar 'Nome da contabilidade (como a pasta no Drive)' $(if ($antE) { $antE.contabilidade } else { '' })); $clientes = @() }
    $sug = $(if ($antE) { [string]$antE.cliente } elseif ($a.fantasia) { Nome-Pasta $a.fantasia } else { Nome-Pasta $a.nome })
    if ($clientes.Count) {
      $pc = [array]::IndexOf($clientes, $sug)
      $icl = Escolher ('Cliente dentro de ' + $contab) $clientes $pc ('cliente novo (sugestão: ' + $sug + ')')
      $cliente = $(if ($icl -ge 0) { $clientes[$icl] } else { Nome-Pasta (Perguntar 'Nome do cliente (pasta no Drive)' $sug) })
    } else { $cliente = Nome-Pasta (Perguntar 'Nome do cliente (pasta no Drive)' $sug) }
    $subSug = $(if ($antE) { [string]$antE.subpasta } else { Sugerir-Subpasta $a $escolhidas })
    $sub = Perguntar 'Subpasta (MATRIZ, FILIAL... Enter = sem subpasta)' $subSug
    if ($sub -eq '-') { $sub = '' }
    $empresas += [ordered]@{ id = $a.id; cnpj = $a.cnpj; contabilidade = $contab; cliente = $cliente; subpasta = (Nome-Pasta $sub) }
    Ok ($contab + ' / ' + $cliente + $(if ($sub) { ' / ' + (Nome-Pasta $sub) } else { '' }))
  }

  # 7) grava a configuração
  Titulo '6. Instalando'
  if (-not (Test-Path $pasta)) { New-Item -ItemType Directory -Path $pasta | Out-Null }
  $cfg = [ordered]@{ receptorUrl = $RECEPTOR_URL; senha = $senha; sistema = $sistema }
  $conexao = [ordered]@{ exe = $c.exe; host = $c.host; porta = [int]$c.porta; usuario = $c.usuario; senha = $c.senha; banco = $c.banco }
  if ($ehLc) {
    $cfg.mysql = $conexao
    $local = (@('', 'localhost', '127.0.0.1', '::1', '.', ([string]$env:COMPUTERNAME).ToLower()) -contains ([string]$c.host).Trim().ToLower())
    $svc = ''; try { $svc = (Get-Service -ErrorAction Stop | Where-Object { $_.Name -match 'mysql|mariadb' } | Select-Object -First 1).Name } catch { }
    if ($svc) { $cfg.servicoMysql = $svc }
    $cfg.vigia = [bool]($local -and $svc)
  } else { $cfg.postgres = $conexao; $cfg.vigia = $false }
  if ($antigo) { foreach ($k in @('diasMesAnterior', 'manuaisDesde', 'incluirMDe', 'parteEnvioMB', 'vigiaReiniciar')) { if ($null -ne $antigo.$k) { $cfg[$k] = $antigo.$k } } }
  $cfg.empresas = $empresas
  $arqCfg = Join-Path $pasta 'config.json'
  if (Test-Path $arqCfg) { Copy-Item $arqCfg ($arqCfg + '.anterior') -Force }
  [IO.File]::WriteAllText($arqCfg, ($cfg | ConvertTo-Json -Depth 6), $UTF8)
  Ok 'configuração gravada'
  Copiar-Programa $pasta
  Escrever-Desinstalador $pasta
  # o config.json tem senhas: só o SYSTEM e os administradores leem
  try { & icacls.exe $pasta /grant '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /T /C /Q | Out-Null } catch { }
  try { & icacls.exe $arqCfg /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' /C /Q | Out-Null; Ok 'configuração protegida (só administradores)' } catch { }
  Garantir-Tarefa $pasta

  # 8) teste: gera os ZIPs do mês sem enviar
  Titulo '7. Teste'
  Info 'gerando os ZIPs do mês atual SEM enviar, para conferir a leitura do banco...'
  $mes = (Get-Date).ToString('yyyy-MM')
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $pasta 'lcxml.ps1') -SoGerar -SemAtualizar -Meses $mes 2>&1 | ForEach-Object { Write-Host ('      ' + $_) }
  if ($LASTEXITCODE -ne 0) { Aviso 'o teste terminou com erro: confira as mensagens acima (o log fica em C:\LCXML\logs).' } else { Ok ('teste concluído: os ZIPs ficaram em ' + (Join-Path $pasta 'saida')) }
  if (SimNao 'Enviar agora para o Drive (mês atual e, no começo do mês, o anterior)?' $true) {
    Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $pasta 'lcxml.ps1') + '"')
    Ok 'envio iniciado numa janela separada (pode fechar esta)'
  }
  return $true
}

function Copiar-Programa([string]$pasta) {
  if (-not (Test-Path $pasta)) { New-Item -ItemType Directory -Path $pasta | Out-Null }
  $alvo = Join-Path $pasta 'lcxml.ps1'
  if (Test-Path $alvo) { Copy-Item $alvo ($alvo + '.anterior') -Force }
  Copy-Item (Join-Path $Origem 'lcxml.ps1') $alvo -Force
  try { Unblock-File $alvo } catch { }
  $e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($alvo, [ref]$null, [ref]$e)
  if ($e.Count) { throw ('o programa não abriu: ' + $e[0].Message) }
  $teste = & powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { [void][scriptblock]::Create((Get-Content -LiteralPath '$alvo' -Raw)); 'ok' } catch { `$_.Exception.Message }" 2>&1
  if ("$teste" -ne 'ok') {
    if (Test-Path ($alvo + '.anterior')) { Copy-Item ($alvo + '.anterior') $alvo -Force }
    throw ('o Windows/antivírus bloqueou o programa: ' + $teste + ' - libere a pasta ' + $pasta + ' no antivírus e rode de novo')
  }
  Ok ('programa copiado para ' + $alvo)
}
function Garantir-Tarefa([string]$pasta) {
  if (-not (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) {   # Windows antigo (7 / 2008): schtasks
    $tr = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $pasta 'lcxml.ps1') + '" -Agendado'
    & schtasks.exe /Create /F /TN $TAREFA /SC DAILY /ST 00:00 /RU SYSTEM /RL HIGHEST /TR $tr | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'não consegui criar a tarefa agendada (schtasks)' }
    Ok ('tarefa "' + $TAREFA + '" criada: todo dia à meia-noite'); return
  }
  $acao = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $pasta 'lcxml.ps1') + '" -Agendado')
  $quando = New-ScheduledTaskTrigger -Daily -At '00:00'
  $quem = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $conf = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 6) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $TAREFA -Action $acao -Trigger $quando -Principal $quem -Settings $conf -Description 'Farol Contábil (CPUSIS): envia os XML do mês para a contabilidade. Roda à meia-noite; se o computador estiver desligado, roda quando ligar.' -Force | Out-Null
  Ok ('tarefa "' + $TAREFA + '" criada: todo dia à meia-noite (ou quando o computador ligar)')
}
function Escrever-Desinstalador([string]$pasta) {
  $bat = "@echo off`r`necho Removendo o agente Farol Contabil (CPUSIS)...`r`nschtasks /Delete /TN `"$TAREFA`" /F`r`nschtasks /Delete /TN `"$TAREFA_VIGIA`" /F`r`necho.`r`necho Tarefas removidas. A pasta $pasta pode ser apagada.`r`npause`r`n"
  [IO.File]::WriteAllText((Join-Path $pasta 'DESINSTALAR.bat'), $bat, [Text.Encoding]::ASCII)
}

if ($SoFuncoes) { return }
$ok = $false
try { $ok = Instalar } catch { Erro $_.Exception.Message }
Write-Host ''
if ($ok) { Write-Host '  Pronto! O agente está instalado. Os dados aparecem no portal depois do primeiro envio.' -ForegroundColor Green }
else { Write-Host '  A instalação não terminou. Mande um print desta tela para a CPUSIS.' -ForegroundColor Red }
Write-Host ''
Read-Host '  Pressione Enter para fechar' | Out-Null
