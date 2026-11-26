<#
  LC XML -> GOOGLE DRIVE  |  AGENTE  (CPUSIS)
  Lê os XML fiscais guardados no banco do LC Sistemas e envia, para cada empresa,
  UM ZIP POR MÊS ao Google Drive (sempre o mesmo arquivo, substituído a cada envio).

  Uso:
    lcxml.ps1                 -> processa o mês atual (e o mês anterior nos primeiros dias)
    lcxml.ps1 -Agendado       -> igual, com espera aleatória de até 20 min (usado pela tarefa agendada)
    lcxml.ps1 -Meses 2026-09,2026-10   -> reenvia meses específicos
    lcxml.ps1 -SoGerar        -> só gera os ZIPs na pasta "saida", sem enviar (teste)
    lcxml.ps1 -Manuais        -> PROCESSADOR: monta o resumo do portal dos XML enviados à mão ao Drive
    lcxml.ps1 -Manuais -Tudo  -> reprocessa todos os meses (não só os novos/alterados)
    lcxml.ps1 -Vigia          -> confere se o MySQL responde e reinicia se travou (tarefa a cada 5 min)
    lcxml.ps1 -Restaurar arquivo.lcbk -SenhaBackup X [-Importar banco_novo] -> abre um backup (gera o .sql)
  Compatível com Windows PowerShell 5.1.
#>
param(
  [switch]$Agendado,
  [string[]]$Meses,
  [switch]$SoGerar,
  [switch]$SemAtualizar,
  [switch]$Manuais,
  [switch]$Tudo,
  [int]$LimiteMinutos = 240,
  [string]$Config,
  [switch]$Vigia,
  [string]$Restaurar,
  [string]$SenhaBackup,
  [string]$Importar
)

$ErrorActionPreference = 'Stop'
$VERSAO = '2.5'
$BASE = $PSScriptRoot
if (-not $Config) { $Config = Join-Path $BASE 'config.json' }
$PASTA_LOG = Join-Path $BASE 'logs'
$PASTA_TMP = Join-Path $BASE 'temp'
$PASTA_SAIDA = Join-Path $BASE 'saida'
$ARQ_ESTADO = Join-Path $BASE 'estado.json'
foreach ($p in @($PASTA_LOG, $PASTA_TMP)) { if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p | Out-Null } }
$ARQ_LOG = Join-Path $PASTA_LOG ('lcxml_' + (Get-Date -Format 'yyyy-MM') + '.log')

function Log([string]$msg) {
  $linha = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $msg
  Write-Host $linha
  try { Add-Content -Path $ARQ_LOG -Value $linha -Encoding UTF8 } catch { }
}

try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072 } catch { }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

# ---------------------------------------------------------------- utilidades
$TEM_FROMHEX = $null -ne ([System.Convert].GetMethod('FromHexString', [Type[]]@([string])))
function De-Hex([string]$h) {
  if ($TEM_FROMHEX) { return [System.Convert]::FromHexString($h) }
  return [System.Runtime.Remoting.Metadata.W3cXsd2001.SoapHexBinary]::Parse($h).Value
}
$UTF8_ESTRITO = New-Object System.Text.UTF8Encoding($false, $true)
$UTF8 = New-Object System.Text.UTF8Encoding($false)
$LATIN1 = [System.Text.Encoding]::GetEncoding(28591)
# O LC grava em colunas latin1: aceita tanto bytes UTF-8 quanto latin1 e devolve texto
function Bytes-ParaTexto([byte[]]$b) {
  $t = $null
  try { $t = $UTF8_ESTRITO.GetString($b) } catch { $t = $LATIN1.GetString($b) }
  return $t.TrimStart([char]0xFEFF)
}
function Sha256-Hex([byte[]]$b) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($b))).Replace('-', '') } finally { $sha.Dispose() }
}
function Nome-Seguro([string]$s) { return ($s -replace '[\\/:*?"<>|]', '-').Trim() }

# ---------------------------------------------------------------- configuração
if (-not (Test-Path $Config)) { Log "ERRO: não encontrei $Config. Rode o INSTALAR.bat."; exit 2 }
$CFG = Get-Content -Path $Config -Raw -Encoding UTF8 | ConvertFrom-Json
$DB = $CFG.mysql
# sistema de gestão do cliente: 'lc' (LC Sistemas, MySQL) ou 'gestores' (Gestores/Brajan, PostgreSQL)
# o mesmo agente serve aos dois sistemas: se adapta pelo banco configurado (config.json)
$SISTEMA = 'lc'
if ($CFG.sistema) { $SISTEMA = ([string]$CFG.sistema).Trim().ToLower() }
elseif ($CFG.postgres -and -not $CFG.mysql) { $SISTEMA = 'gestores' }
$PG = $CFG.postgres
if ($SISTEMA -eq 'gestores') { $DB = $null }   # sem MySQL: vigia do MySQL e reinícios ficam desligados
$DIAS_MES_ANTERIOR = 10
if ($CFG.diasMesAnterior) { $DIAS_MES_ANTERIOR = [int]$CFG.diasMesAnterior }

# ---------------------------------------------------------------- MySQL (via mysql.exe do próprio servidor)
function Invoke-MySql([string]$sql, [scriptblock]$porLinha) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $DB.exe
  $argv = @(('--host=' + $DB.host), ('--port=' + $DB.porta), ('--user=' + $DB.usuario), '--batch', '--skip-column-names',
            '--default-character-set=utf8', ('--database=' + $DB.banco))
  if ($DB.senha) { $argv += ('--password=' + $DB.senha) }
  $psi.Arguments = ($argv | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $psi.StandardOutputEncoding = $UTF8
  $p = [System.Diagnostics.Process]::Start($psi)
  $p.StandardInput.WriteLine($sql + ';')
  $p.StandardInput.Close()
  $errTask = $p.StandardError.ReadToEndAsync()
  $n = 0
  while ($true) {
    $l = $p.StandardOutput.ReadLine()
    if ($null -eq $l) { break }
    $n++
    if ($porLinha) { & $porLinha $l }
  }
  $p.WaitForExit()
  $err = $errTask.Result
  if ($p.ExitCode -ne 0) {
    $msg = ($err -split "`n" | Where-Object { $_ -notmatch 'Using a password' }) -join ' '
    throw "MySQL: $msg"
  }
  return $n
}

# ---------------------------------------------------------------- PostgreSQL (Gestores), via psql.exe do próprio servidor - só leitura
function Novo-ProcessoPg([string]$exe, $argv) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.Arguments = ($argv | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = $UTF8
  if ($PG.senha) { $psi.EnvironmentVariables['PGPASSWORD'] = [string]$PG.senha }
  $psi.EnvironmentVariables['PGCLIENTENCODING'] = 'UTF8'
  $psi.EnvironmentVariables['PGCONNECT_TIMEOUT'] = '30'
  $psi.EnvironmentVariables['PGAPPNAME'] = 'FarolContabil-agente'
  return $psi
}
function Invoke-Pg([string]$sql, [scriptblock]$porLinha) {
  $argv = @('-X', '-q', '-A', '-t', '-F', "`t", '-v', 'ON_ERROR_STOP=1', '-h', [string]$PG.host, '-p', [string]$PG.porta, '-U', [string]$PG.usuario, '-d', [string]$PG.banco)
  $p = [System.Diagnostics.Process]::Start((Novo-ProcessoPg $PG.exe $argv))
  # sessão somente leitura: o agente nunca grava nada no banco do Gestores
  $p.StandardInput.WriteLine('SET default_transaction_read_only = on;')
  $p.StandardInput.WriteLine($sql.TrimEnd(';') + ';')
  $p.StandardInput.Close()
  $errTask = $p.StandardError.ReadToEndAsync()
  $n = 0
  while ($true) {
    $l = $p.StandardOutput.ReadLine()
    if ($null -eq $l) { break }
    if ($l -eq '') { continue }
    $n++
    if ($porLinha) { & $porLinha $l }
  }
  $p.WaitForExit()
  if ($p.ExitCode -ne 0) { throw ('PostgreSQL: ' + (($errTask.Result -split "`n" | Where-Object { $_.Trim() }) -join ' ')) }
  return $n
}
function Invoke-Db([string]$sql, [scriptblock]$porLinha) {
  if ($SISTEMA -eq 'gestores') { return (Invoke-Pg $sql $porLinha) }
  return (Invoke-MySql $sql $porLinha)
}
function Testar-Pg { try { [void](Invoke-Pg 'SELECT 1' $null); return '' } catch { return $_.Exception.Message } }
function Servico-Banco {
  if ($SISTEMA -eq 'gestores') {
    try { $s = Get-Service -ErrorAction Stop | Where-Object { $_.Name -match '^postgresql' } | Select-Object -First 1; if ($s) { return $s.Name } } catch { }
    return ''
  }
  return (Servico-MySql)
}

# ---------------------------------------------------------------- identificação de cada XML
function Info-Xml([string]$x) {
  $i = @{ tipo = 'outro'; nome = $null; autorizado = $false; chave = $null; tpEvento = $null; modelo = $null }
  if ($x -match '<(procEventoNFe|procEventoCTe|procEventoMDFe|eventoCTe|eventoMDFe|evento|retEnvEvento)[\s>]') {
    $i.tipo = 'evento'
    if ($x -match '<ch(NFe|CTe|MDFe)>(\d{44})</ch') { $i.chave = $matches[2] }
    if ($x -match '<tpEvento>(\d{6})</tpEvento>') { $i.tpEvento = $matches[1] }
    $seq = '1'; if ($x -match '<nSeqEvento>(\d+)</nSeqEvento>') { $seq = $matches[1] }
    $i.autorizado = ($x -match '<retEvento') -and ($x -match '<cStat>(135|136|155)</cStat>')
    $i.nome = '{0}-{1}-{2}-procEvento.xml' -f $i.chave, $i.tpEvento, $seq
  }
  elseif ($x -match '<(procInutNFe|retInutNFe|inutNFe)[\s>]') {
    $i.tipo = 'inut'
    $id = 'inutilizacao'; if ($x -match 'Id="ID(\d+)"') { $id = $matches[1] }
    $i.autorizado = ($x -match '<cStat>102</cStat>')
    $i.nome = $id + '-procInutNFe.xml'
  }
  elseif ($x -match 'Id="(NFe|CTe|MDFe)(\d{44})"') {
    $i.tipo = 'doc'
    $pref = $matches[1]; $i.chave = $matches[2]; $i.modelo = $i.chave.Substring(20, 2)
    $i.autorizado = ($x -match '<prot(NFe|CTe|MDFe)[\s>]') -and ($x -match '<cStat>(100|150)</cStat>')
    $i.nome = '{0}-proc{1}.xml' -f $i.chave, $pref
  }
  return $i
}

# ---------------------------------------------------------------- análise fiscal (resumo para o portal)
$INV = [Globalization.CultureInfo]::InvariantCulture
$CFOP_DEVOL = @('201','202','203','204','208','209','210','410','411','412','413','503','553','555','556','660','661','662','918','919')
$TPAG = @{ '01'='Dinheiro'; '02'='Cheque'; '03'='Cartão de crédito'; '04'='Cartão de débito'; '05'='Crédito loja'; '10'='Vale alimentação';
           '11'='Vale refeição'; '12'='Vale presente'; '13'='Vale combustível'; '15'='Boleto'; '16'='Depósito'; '17'='PIX'; '18'='Transferência/carteira digital';
           '19'='Fidelidade/cashback'; '20'='PIX estático'; '21'='Crédito em loja'; '22'='Pagamento eletrônico não informado'; '90'='Sem pagamento'; '99'='Outros' }

function Num($n) { if ($null -eq $n -or $n.InnerText -eq '') { return [decimal]0 }; return [decimal]::Parse($n.InnerText, $INV) }
function Txt($n) { if ($null -eq $n) { return '' }; return $n.InnerText }
function Filho($no, [string]$nome) { if ($null -eq $no) { return $null }; return $no[$nome] }

# 2.5: validade do certificado digital lida do XML assinado (sem senha, sem tocar no certificado do cliente)
function Ler-CertificadoXml($c) {
  if (-not $c -or -not $c.b64) { return $null }
  try {
    $x5 = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 (, [Convert]::FromBase64String($c.b64))
    $cn = ''; if ($x5.Subject -match 'CN=([^,]+)') { $cn = $Matches[1].Trim('"') }
    $doc = ''; if ($cn -match ':(\d{11,14})$') { $doc = $Matches[1] }
    $tipo = ''; foreach ($e in $x5.Extensions) { if ($e.Oid.Value -eq '2.5.29.32') { $t = $e.Format($false); if ($t -match '2\.16\.76\.1\.2\.1\.') { $tipo = 'A1' } elseif ($t -match '2\.16\.76\.1\.2\.3\.') { $tipo = 'A3' } } }
    $emissor = ''; if ($x5.Issuer -match 'CN=([^,]+)') { $emissor = $Matches[1].Trim('"') }
    return [ordered]@{ validade = $x5.NotAfter.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); inicio = $x5.NotBefore.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
      titular = ($cn -replace ':\d{11,14}$', ''); doc = $doc; tipo = $tipo; emissor = $emissor; serie = $x5.SerialNumber; notaEm = $c.dh }
  } catch { return $null }
}

function Nova-Analise {
  $script:AN = @{ docs = @{}; canceladas = @{}; inut = New-Object System.Collections.ArrayList; cte = @{ qtd = 0; valor = [decimal]0 }; mdfe = 0; sistemaDia = $null; pendencias = $null; certs = @{}; certCliente = $null }
}

# lê um documento autorizado (NF-e/NFC-e/compra) e guarda o que interessa
function Analisar-Doc([string]$grupo, [string]$texto) {
  $x = New-Object System.Xml.XmlDocument
  try { $x.LoadXml($texto) } catch { return }
  $inf = $x.GetElementsByTagName('infNFe')[0]
  if ($null -eq $inf) {
    if ($grupo -eq 'cte' -or ($grupo -eq 'auto' -and $x.GetElementsByTagName('infCte').Count)) { $script:AN.cte.qtd++; $v = $x.GetElementsByTagName('vTPrest')[0]; if ($v) { $script:AN.cte.valor += (Num $v) } }
    if ($grupo -eq 'mdfe' -or ($grupo -eq 'auto' -and $x.GetElementsByTagName('infMDFe').Count)) { $script:AN.mdfe++ }
    return
  }
  $chave = $inf.GetAttribute('Id') -replace '^NFe', ''
  if ($script:AN.docs.ContainsKey($chave)) { return }
  $ide = $inf['ide']; $emit = $inf['emit']; $dest = $inf['dest']; $tot = Filho $inf['total'] 'ICMSTot'
  $origem = 'NFe'; if ($grupo -eq 'nfce') { $origem = 'NFCe' } elseif ($grupo -eq 'compras' -or $grupo -eq 'mde') { $origem = 'Compras' }
  $dh = Txt (Filho $ide 'dhEmi'); if (-not $dh) { $dh = Txt (Filho $ide 'dEmi') }
  $destDoc = Txt (Filho $dest 'CNPJ'); if (-not $destDoc) { $destDoc = Txt (Filho $dest 'CPF') }; if (-not $destDoc) { $destDoc = Txt (Filho $dest 'idEstrangeiro') }
  $d = @{
    origem = $origem; chave = $chave; modelo = (Txt (Filho $ide 'mod')); serie = (Txt (Filho $ide 'serie')); numero = [long](Txt (Filho $ide 'nNF'))
    data = $(if ($dh.Length -ge 10) { $dh.Substring(0, 10) } else { '' }); tpNF = (Txt (Filho $ide 'tpNF')); finNFe = (Txt (Filho $ide 'finNFe')); natOp = (Txt (Filho $ide 'natOp'))
    emitDoc = (Txt (Filho $emit 'CNPJ')); emitNome = (Txt (Filho $emit 'xNome')); crt = (Txt (Filho $emit 'CRT')); destDoc = $destDoc; destNome = (Txt (Filho $dest 'xNome'))
    uf = (Txt (Filho (Filho $emit 'enderEmit') 'UF')); cMunFG = (Txt (Filho $ide 'cMunFG')); dh = $dh
    vNF = (Num (Filho $tot 'vNF')); itens = New-Object System.Collections.ArrayList; pag = New-Object System.Collections.ArrayList
    refs = @($x.GetElementsByTagName('refNFe') | ForEach-Object { $_.InnerText })
  }
  # 2.5: certificado que assinou a nota (vai dentro do próprio XML, é público): guarda o da nota mais recente de cada emitente
  if ($d.emitDoc) {
    $xc = $x.GetElementsByTagName('X509Certificate')
    if ($xc.Count -and (-not $script:AN.certs.ContainsKey($d.emitDoc) -or [string]$dh -gt [string]$script:AN.certs[$d.emitDoc].dh)) { $script:AN.certs[$d.emitDoc] = @{ dh = [string]$dh; b64 = ($xc[0].InnerText -replace '\s', '') } }
  }
  foreach ($det in $inf.GetElementsByTagName('det')) {
    $pr = $det['prod']; $im = $det['imposto']
    $icms = $null; $nIcms = Filho $im 'ICMS'; if ($nIcms) { $icms = $nIcms.FirstChild }
    $cst = Txt (Filho $icms 'CST'); if (-not $cst) { $cst = Txt (Filho $icms 'CSOSN') }
    $pis = $null; $nPis = Filho $im 'PIS'; if ($nPis) { $pis = $nPis.FirstChild }
    $cof = $null; $nCof = Filho $im 'COFINS'; if ($nCof) { $cof = $nCof.FirstChild }
    $vIPI = [decimal]0; $nIpi = Filho $im 'IPI'; if ($nIpi) { $vIPI = Num (Filho (Filho $nIpi 'IPITrib') 'vIPI') }
    $vIBS = [decimal]0; $vCBS = [decimal]0; $cstIBS = ''; $cClass = ''; $bcIbs = [decimal]0; $pUF = [decimal]0; $pMun = [decimal]0; $pCBS = [decimal]0
    $nIbs = Filho $im 'IBSCBS'
    if ($nIbs) {
      # reforma tributária (NT 2025.002): CST e cClassTrib do IBS/CBS, base, alíquotas e valores
      $cstIBS = Txt (Filho $nIbs 'CST'); $cClass = Txt (Filho $nIbs 'cClassTrib')
      $a = $nIbs.GetElementsByTagName('vIBS'); if ($a.Count) { $vIBS = Num $a[0] }; $a = $nIbs.GetElementsByTagName('vCBS'); if ($a.Count) { $vCBS = Num $a[0] }
      $g = Filho $nIbs 'gIBSCBS'
      if ($g) { $bcIbs = Num (Filho $g 'vBC'); $pUF = Num (Filho (Filho $g 'gIBSUF') 'pIBSUF'); $pMun = Num (Filho (Filho $g 'gIBSMun') 'pIBSMun'); $pCBS = Num (Filho (Filho $g 'gCBS') 'pCBS') }
    }
    # conferência IBS/CBS (agente 2.2): componentes da base (LC 214/2025, art. 12) e o grupo como veio na nota
    $rtcIt = $null
    if ($nIbs) { try {
      $gIbs = Filho $nIbs 'gIBSCBS'
      $vUFDest = [decimal]0; $vFcpUFDest = [decimal]0; $nUFD = Filho $im 'ICMSUFDest'; if ($nUFD) { $vUFDest = Num (Filho $nUFD 'vICMSUFDest'); $vFcpUFDest = Num (Filho $nUFD 'vFCPUFDest') }
      $vIss = [decimal]0; $nIss = Filho $im 'ISSQN'; if ($nIss) { $vIss = Num (Filho $nIss 'vISSQN') }
      # ICMS desonerado (ex.: Área de Livre Comércio): muitos emissores abatem do preço mesmo sem indDeduzDeson; a conferência aceita a base com ou sem ele
      $vDesonRtc = Num (Filho $icms 'vICMSDeson')
      # comp: vProd, vFrete, vSeg, vOutro, vII, vDesc, vPIS, vCOFINS, vICMS, vFCP, vICMSUFDest, vFCPUFDest, vICMSMono, vISSQN, vICMSDeson abatido (vetor para gastar pouca memória)
      $rtcIt = @{ g = [bool]$gIbs
        comp = [decimal[]]@((Num $pr['vProd']), (Num $pr['vFrete']), (Num $pr['vSeg']), (Num $pr['vOutro']), $(if ($nII) { Num (Filho $nII 'vII') } else { [decimal]0 }), (Num $pr['vDesc']),
                            (Num (Filho $pis 'vPIS')), (Num (Filho $cof 'vCOFINS')), (Num (Filho $icms 'vICMS')), (Num (Filho $icms 'vFCP')), $vUFDest, $vFcpUFDest, (Num (Filho $icms 'vICMSMono')), $vIss, $vDesonRtc) }
      if ($gIbs) {
        # por tributo: p, v, vDif, vDevTrib, pRedAliq, pAliqEfet (-1 = sem gRed)
        foreach ($t in @(@('UF', 'gIBSUF', 'pIBSUF', 'vIBSUF'), @('Mun', 'gIBSMun', 'pIBSMun', 'vIBSMun'), @('CBS', 'gCBS', 'pCBS', 'vCBS'))) {
          $gt = Filho $gIbs $t[1]; if (-not $gt) { continue }; $red = Filho $gt 'gRed'
          $rtcIt[$t[0]] = [decimal[]]@((Num (Filho $gt $t[2])), (Num (Filho $gt $t[3])), (Num (Filho (Filho $gt 'gDif') 'vDif')), (Num (Filho (Filho $gt 'gDevTrib') 'vDevTrib')),
                                       $(if ($red) { Num (Filho $red 'pRedAliq') } else { [decimal]0 }), $(if ($red) { Num (Filho $red 'pAliqEfet') } else { [decimal]-1 }))
        }
      }
    } catch { $rtcIt = $null } }   # nunca deixa a conferência derrubar a leitura da nota
    $vST = Num (Filho $icms 'vICMSST'); $vFCPST = Num (Filho $icms 'vFCPST')
    $vDeson = [decimal]0; if ((Txt (Filho $icms 'indDeduzDeson')) -ne '0') { $vDeson = Num (Filho $icms 'vICMSDeson') }
    $vII = [decimal]0; $nII = Filho $im 'II'; if ($nII) { $vII = Num (Filho $nII 'vII') }
    $vItem = (Num $pr['vProd']) - (Num $pr['vDesc']) + (Num $pr['vFrete']) + (Num $pr['vSeg']) + (Num $pr['vOutro']) + $vST + $vFCPST + $vIPI + $vII - $vDeson
    [void]$d.itens.Add(@{
      cfop = (Txt $pr['CFOP']); cst = $cst; orig = (Txt (Filho $icms 'orig')); aliq = (Num (Filho $icms 'pICMS'))
      valor = $vItem; vBC = (Num (Filho $icms 'vBC')); vICMS = (Num (Filho $icms 'vICMS')); vBCST = (Num (Filho $icms 'vBCST')); vST = $vST
      vIPI = $vIPI; cstPis = (Txt (Filho $pis 'CST')); vPIS = (Num (Filho $pis 'vPIS')); cstCofins = (Txt (Filho $cof 'CST')); vCOFINS = (Num (Filho $cof 'vCOFINS'))
      cstIBS = $cstIBS; vIBS = $vIBS; vCBS = $vCBS; temIbs = [bool]$nIbs; cClass = $cClass; bcIbs = $bcIbs; pUF = $pUF; pMun = $pMun; pCBS = $pCBS; rtc = $rtcIt
      ncm = (Txt $pr['NCM']); cest = (Txt $pr['CEST']); cProd = (Txt $pr['cProd']); xProd = (Txt $pr['xProd']); un = (Txt $pr['uCom']); qtd = (Num $pr['qCom'])
    })
  }
  $pagNo = $inf['pag']
  if ($pagNo) {
    $troco = Num (Filho $pagNo 'vTroco')
    foreach ($dp in $pagNo.GetElementsByTagName('detPag')) {
      $tp = Txt $dp['tPag']; $v = Num $dp['vPag']
      if ($tp -eq '01' -and $troco -gt 0) { $v -= $troco; $troco = 0 }
      [void]$d.pag.Add(@($tp, $v))
    }
  }
  $script:AN.docs[$chave] = $d
}

function Analisar-Inut([string]$texto) {
  $x = New-Object System.Xml.XmlDocument
  try { $x.LoadXml($texto) } catch { return }
  $inf = $x.GetElementsByTagName('infInut')
  $i = $null; foreach ($n in $inf) { if ($n['nNFIni']) { $i = $n; break } }
  if ($null -eq $i) { $i = $inf[0] }
  if ($null -eq $i) { return }
  [void]$script:AN.inut.Add([ordered]@{ modelo = (Txt $i['mod']); serie = (Txt $i['serie']); inicio = [long](Txt $i['nNFIni']); fim = [long](Txt $i['nNFFin'])
                                        justificativa = (Txt $i['xJust']); protocolo = (Txt ($x.GetElementsByTagName('nProt')[0])) })
}

function R2([decimal]$v) { return [Math]::Round($v, 2) }


# ---------------------------------------------------------------- conferência IBS/CBS (reforma tributária)
# Tabela oficial (alíquotas de referência e cClassTrib com reduções) vem da Calculadora de Tributos da Receita,
# repassada pelo banco do Farol (função rtc). Sem ela, usa a cópia local de até 30 dias; sem nenhuma, só confere base e valores.
$RTC_URL = 'https://cidvuirvojpsmukfxpll.supabase.co/functions/v1/rtc'
$script:RTC_TAB = @{}
$RTC_COMP = @('vProd', 'vFrete', 'vSeg', 'vOutro', 'vII', 'vDesc', 'vPIS', 'vCOFINS', 'vICMS', 'vFCP', 'vICMSUFDest', 'vFCPUFDest', 'vICMSMono', 'vISSQN', 'vICMSDeson')
function Tabela-Rtc([datetime]$mes) {
  $k = $mes.ToString('yyyy-MM')
  if ($null -eq $script:RTC_TAB) { $script:RTC_TAB = @{} }
  if ($script:RTC_TAB.ContainsKey($k)) { return $script:RTC_TAB[$k] }
  $arq = Join-Path $BASE ('rtc_tabela_' + $k + '.json'); $tab = $null
  try {
    $r = Invoke-RestMethod -Uri ($RTC_URL + '?acao=tabela&data=' + $mes.ToString('yyyy-MM-15')) -Method Get -TimeoutSec 25
    if ($r -is [string]) { $r = $r | ConvertFrom-Json }
    if ($r.ok -and $r.tabela) { $tab = $r.tabela; try { [IO.File]::WriteAllText($arq, ($r.tabela | ConvertTo-Json -Depth 6 -Compress), $UTF8) } catch { } }
  } catch { Log ('tabela IBS/CBS: ' + $_.Exception.Message) }
  if (-not $tab -and (Test-Path $arq) -and ((Get-Date) - (Get-Item $arq).LastWriteTime).TotalDays -lt 30) { try { $tab = Get-Content $arq -Raw -Encoding UTF8 | ConvertFrom-Json } catch { } }
  $t = @{ fonte = 'nenhuma'; cbs = $null; uf = $null; mun = $null; cls = @{} }
  if ($tab) {
    $t.fonte = [string]$tab.fonte; $t.versao = [string]$tab.versao
    if ($null -ne $tab.cbs) { $t.cbs = [decimal]$tab.cbs }; if ($null -ne $tab.ibsUF) { $t.uf = [decimal]$tab.ibsUF }; if ($null -ne $tab.ibsMun) { $t.mun = [decimal]$tab.ibsMun }
    foreach ($c in @($tab.classes)) { if ($c.c) { $t.cls[[string]$c.c] = $c } }
  }
  $script:RTC_TAB[$k] = $t
  return $t
}
function Rd2([decimal]$v) { return [Math]::Round($v, 2, [MidpointRounding]::AwayFromZero) }
# confere um item; devolve $null (sem grupo IBSCBS) ou @{ prob = códigos; bcEsp; vEsp; vNota }
function Conferir-Item($it, $T) {
  $r = $it.rtc; if (-not $r) { return $null }
  $prob = New-Object System.Collections.ArrayList
  $cc = [string]$it.cClass; $cst = [string]$it.cstIBS
  if (-not $cc) { [void]$prob.Add('semClass') }
  elseif ($cst -and $cc.Length -ge 3 -and $cc.Substring(0, 3) -ne $cst) { [void]$prob.Add('cst') }
  $cl = $null; if ($cc -and $T.cls.Count) { $cl = $T.cls[$cc]; if (-not $cl) { [void]$prob.Add('classe') } }
  $o = @{ prob = $prob; bcEsp = $null; vEsp = [decimal]0; vNota = [decimal]0 }
  if (-not $r.g) { return $o }
  $c = $r.comp
  $bcEsp = $c[0] + $c[1] + $c[2] + $c[3] + $c[4] - $c[5] - $c[6] - $c[7] - $c[8] - $c[9] - $c[10] - $c[11] - $c[12] - $c[13] - $c[14]
  if ($bcEsp -lt 0) { $bcEsp = [decimal]0 }
  $o.bcEsp = Rd2 $bcEsp
  # ICMS desonerado abatido: aceita a base com ou sem o abatimento (os emissores ainda divergem; a norma não é explícita)
  if ($c[14] -gt 0 -and [Math]::Abs($it.bcIbs - (Rd2 ($bcEsp + $c[14]))) -le 0.05) { $o.bcEsp = $it.bcIbs }
  if ([Math]::Abs($it.bcIbs - $o.bcEsp) -gt 0.05) { [void]$prob.Add('base') }
  $refs = @{ UF = $T.uf; Mun = $T.mun; CBS = $T.cbs }
  $redTab = @{ UF = $null; Mun = $null; CBS = $null }
  if ($cl) {
    if ($cl.padrao -eq $false) { $refs = @{ UF = $null; Mun = $null; CBS = $null } }   # alíquota fixa/específica (ex.: combustíveis): não compara alíquota nem redução
    else { $redTab.UF = [decimal]$cl.rUF; $redTab.Mun = [decimal]$cl.rMun; $redTab.CBS = [decimal]$cl.rCBS }
  }
  $aliq = $false; $red = $false; $val = $false
  foreach ($k in @('UF', 'Mun', 'CBS')) {
    $a = $r[$k]; if (-not $a) { continue }
    $p = $a[0]; $v = $a[1]; $vDif = $a[2]; $vDev = $a[3]; $rd = $a[4]; $pE = $a[5]
    $o.vNota += $v
    # alíquota efetiva da nota (com a redução que ela mesma informa) x efetiva oficial (referência x redução da tabela)
    $pEf = $p; if ($pE -ge 0) { $pEf = $pE } elseif ($rd -gt 0) { $pEf = $p * (100 - $rd) / 100 }
    $pRef = $p; if ($null -ne $refs[$k]) { $pRef = $refs[$k] }
    $rRef = $rd; if ($null -ne $redTab[$k]) { $rRef = $redTab[$k] }
    $efOf = $pRef * (100 - $rRef) / 100
    if (($null -ne $refs[$k] -or $null -ne $redTab[$k]) -and [Math]::Abs($pEf - $efOf) -gt 0.0001) {
      if ($null -ne $redTab[$k] -and [Math]::Abs($rd - $redTab[$k]) -gt 0.01) { $red = $true } else { $aliq = $true }
    }
    if ([Math]::Abs($v - ((Rd2 ($it.bcIbs * $pEf / 100)) - $vDif - $vDev)) -gt 0.011) { $val = $true }
    # o que deveria ser: base correta x alíquota efetiva oficial
    $o.vEsp += (Rd2 ($o.bcEsp * $efOf / 100)) - $vDif - $vDev
  }
  if ($aliq) { [void]$prob.Add('aliquota') }; if ($red) { [void]$prob.Add('reducao') }; if ($val) { [void]$prob.Add('valor') }
  return $o
}
function Conferir-Rtc([datetime]$mes) {
  $T = Tabela-Rtc $mes; $script:rtcDetalhes = @{}; $script:rtcNotas = @{}
  $orig = @{}; $notas = New-Object System.Collections.ArrayList; $forn = @{}; $pares = @{}; $probTot = @{}
  foreach ($d in $script:AN.docs.Values) {
    if ($script:AN.canceladas.ContainsKey($d.chave)) { continue }
    $o = $d.origem
    if (-not $orig.ContainsKey($o)) { $orig[$o] = [ordered]@{ docs = 0; conferidos = 0; ok = 0; comErro = 0; semGrupo = 0; itens = 0; itensErro = 0; difTrib = [decimal]0 } }
    $R = $orig[$o]; $R.docs++
    $temGrupo = $false; $erros = New-Object System.Collections.ArrayList; $nItErro = 0; $bcN = [decimal]0; $bcE = [decimal]0; $vN = [decimal]0; $vE = [decimal]0; $probN = @{}
    foreach ($it in $d.itens) {
      $cf = Conferir-Item $it $T
      if ($null -eq $cf) { continue }
      $temGrupo = $true; $R.itens++
      if ($it.cClass -and $it.cClass -ne '000001' -and $it.ncm -and $pares.Count -lt 600) { $pares[$it.ncm + '|' + $it.cClass] = 1 }
      if (-not $cf.prob.Count) { continue }
      $nItErro++; $R.itensErro++
      foreach ($p in $cf.prob) { $probN[$p] = 1 + [int]$probN[$p]; $probTot[$o + '|' + $p] = 1 + [int]$probTot[$o + '|' + $p] }
      if ($null -ne $cf.bcEsp) { $bcN += $it.bcIbs; $bcE += $cf.bcEsp; $vN += $cf.vNota; $vE += $cf.vEsp }
      if ($erros.Count -lt 8 -and [int]$script:rtcDetalhes[$o] -lt 25) {
        $comp = [ordered]@{}; $cv = $it.rtc.comp; for ($q = 0; $q -lt $RTC_COMP.Count; $q++) { if ($cv[$q] -ne 0) { $comp[$RTC_COMP[$q]] = $cv[$q] } }
        $dec = [ordered]@{ vBC = $it.bcIbs }; foreach ($k in @('UF', 'Mun', 'CBS')) { $x = $it.rtc[$k]; if ($x) { $dec['p' + $k] = $x[0]; $dec['v' + $k] = $x[1]; if ($x[4]) { $dec['r' + $k] = $x[4] }; if ($x[2]) { $dec['dif' + $k] = $x[2] } } }
        [void]$erros.Add([ordered]@{ n = $erros.Count + 1; ncm = $it.ncm; prod = $it.xProd; cst = $it.cstIBS; cc = $it.cClass; prob = @($cf.prob); bcEsp = $cf.bcEsp; vEsp = (R2 $cf.vEsp); nota = $dec; comp = $comp })
      }
    }
    if (-not $temGrupo) { if ($d.itens.Count) { $R.semGrupo++ }; continue }
    $R.conferidos++
    if (-not $nItErro) { $R.ok++ } else { $R.comErro++; $R.difTrib += ($vN - $vE) }
    if ($o -eq 'Compras' -and $d.emitDoc) {
      if (-not $forn.ContainsKey($d.emitDoc)) { $forn[$d.emitDoc] = [ordered]@{ doc = $d.emitDoc; nome = $d.emitNome; docs = 0; comErro = 0; difTrib = [decimal]0 } }
      $f = $forn[$d.emitDoc]; $f.docs++; if ($nItErro) { $f.comErro++; $f.difTrib += ($vN - $vE) }
    }
    if ($nItErro -and $erros.Count) { $script:rtcDetalhes[$o] = 1 + [int]$script:rtcDetalhes[$o] }
    if ($nItErro -and [int]$script:rtcNotas[$o] -lt 120) {
      $script:rtcNotas[$o] = 1 + [int]$script:rtcNotas[$o]
      $part = $d.destNome; $partDoc = $d.destDoc; if ($o -eq 'Compras') { $part = $d.emitNome; $partDoc = $d.emitDoc }
      $dh = $d.data
      [void]$notas.Add([ordered]@{ chave = $d.chave; origem = $o; modelo = $d.modelo; serie = $d.serie; numero = $d.numero; data = $dh; part = $part; partDoc = $partDoc; crt = $d.crt
        uf = $d.uf; mun = $d.cMunFG; dh = $d.dh; vNF = (R2 $d.vNF); itens = $d.itens.Count; itensErro = $nItErro; prob = $probN
        bcNota = (R2 $bcN); bcEsp = (R2 $bcE); vNota = (R2 $vN); vEsp = (R2 $vE); dif = (R2 ($vN - $vE)); erros = @($erros) })
    }
  }
  foreach ($v in $orig.Values) { $v.difTrib = R2 $v.difTrib }
  $fl = @($forn.Values | ForEach-Object { $_.difTrib = R2 $_.difTrib; $_ } | Sort-Object { $_.comErro } -Descending | Select-Object -First 100)
  $pt = [ordered]@{}; foreach ($k in $probTot.Keys) { $pt[$k] = $probTot[$k] }
  return [ordered]@{ versao = 1; tabela = [ordered]@{ fonte = $T.fonte; versao = $T.versao; cbs = $T.cbs; ibsUF = $T.uf; ibsMun = $T.mun; classes = $T.cls.Count }
    porOrigem = $orig; problemas = $pt; notas = @($notas); fornecedores = $fl; pares = @($pares.Keys) }
}

# soma tudo e devolve o objeto do resumo (JSON)
function Montar-Resumo($emp, [datetime]$mes) {
  $trib = @{}; $ncm = @{}; $prod = @{}; $pc = @{}; $pagto = @{}; $tot = @{}
  $canc = New-Object System.Collections.ArrayList; $devol = New-Object System.Collections.ArrayList
  $numeros = @{}; $crts = @{}; $ultimos = @{}   # 2.4: último número emitido por modelo e série
  # reforma tributária: quem já destaca IBS/CBS nos XML (por documento e por item)
  $rfOrig = @{}; $rfCls = @{}; $rfSem = New-Object System.Collections.ArrayList; $rfForn = @{}
  foreach ($d in $script:AN.docs.Values) {
    if ($script:AN.canceladas.ContainsKey($d.chave)) { continue }
    $o = $d.origem
    if (-not $rfOrig.ContainsKey($o)) { $rfOrig[$o] = [ordered]@{ docs = 0; docsCom = 0; itens = 0; itensCom = 0; itensSemClass = 0 } }
    $r = $rfOrig[$o]; $r.docs++; $com = 0
    foreach ($it in $d.itens) {
      $r.itens++
      if (-not $it.temIbs) { continue }
      $com++; $r.itensCom++; if (-not $it.cClass) { $r.itensSemClass++ }
      $kc = '{0}|{1}|{2}|{3}|{4}|{5}' -f $o, $it.cstIBS, $it.cClass, $it.pUF, $it.pMun, $it.pCBS
      if (-not $rfCls.ContainsKey($kc)) { $rfCls[$kc] = [ordered]@{ origem = $o; cst = $it.cstIBS; cClassTrib = $it.cClass; pIBSUF = $it.pUF; pIBSMun = $it.pMun; pCBS = $it.pCBS; itens = 0; valor = [decimal]0; vBC = [decimal]0; vIBS = [decimal]0; vCBS = [decimal]0 } }
      $c = $rfCls[$kc]; $c.itens++; $c.valor += $it.valor; $c.vBC += $it.bcIbs; $c.vIBS += $it.vIBS; $c.vCBS += $it.vCBS
    }
    if ($com -gt 0) { $r.docsCom++ }
    elseif ($o -ne 'Compras' -and $d.itens.Count -and $rfSem.Count -lt 50) { [void]$rfSem.Add([ordered]@{ origem = $o; modelo = $d.modelo; serie = $d.serie; numero = $d.numero; data = $d.data; valor = (R2 $d.vNF); chave = $d.chave }) }
    if ($o -eq 'Compras' -and $d.emitDoc) { if (-not $rfForn.ContainsKey($d.emitDoc)) { $rfForn[$d.emitDoc] = $false }; if ($com -gt 0) { $rfForn[$d.emitDoc] = $true } }
  }
  foreach ($d in $script:AN.docs.Values) {
    $o = $d.origem
    if ($o -ne 'Compras' -and $d.crt) { $crts[$d.crt] = 1 + [int]$crts[$d.crt] }
    if (-not $tot.ContainsKey($o)) { $tot[$o] = [ordered]@{ qtd = 0; canceladas = 0; valor = [decimal]0; vBC = [decimal]0; vICMS = [decimal]0; vST = [decimal]0; vIPI = [decimal]0; vPIS = [decimal]0; vCOFINS = [decimal]0; vIBS = [decimal]0; vCBS = [decimal]0 } }
    $t = $tot[$o]
    if ($o -ne 'Compras') { $k = $d.modelo + '|' + $d.serie; if (-not $numeros.ContainsKey($k)) { $numeros[$k] = New-Object 'System.Collections.Generic.HashSet[long]' }; [void]$numeros[$k].Add($d.numero); if (-not $ultimos.ContainsKey($k) -or [long]$d.numero -gt [long]$ultimos[$k].numero) { $ultimos[$k] = [ordered]@{ modelo = $d.modelo; serie = $d.serie; numero = [long]$d.numero; data = $d.data } } }
    if ($script:AN.canceladas.ContainsKey($d.chave)) {
      $t.canceladas++
      [void]$canc.Add([ordered]@{ origem = $o; modelo = $d.modelo; serie = $d.serie; numero = $d.numero; data = $d.data; valor = (R2 $d.vNF); chave = $d.chave })
      continue
    }
    $t.qtd++; $t.valor += $d.vNF
    $es = 'S'; if ($d.tpNF -eq '0' -or $o -eq 'Compras') { $es = 'E' }
    $cfop1 = ''; if ($d.itens.Count) { $cfop1 = $d.itens[0].cfop }
    $ehDev = ($d.finNFe -eq '4') -or ($cfop1.Length -eq 4 -and $CFOP_DEVOL -contains $cfop1.Substring(1))
    if ($ehDev) {
      if ($o -eq 'Compras') { $tipo = 'Devolução de venda (nota emitida pelo cliente)' }
      elseif ($cfop1 -match '^[123]') { $tipo = 'Devolução de venda (entrada própria)' }
      else { $tipo = 'Devolução de compra (nota emitida)' }
      $part = $d.destNome; $partDoc = $d.destDoc; if ($o -eq 'Compras') { $part = $d.emitNome; $partDoc = $d.emitDoc }
      [void]$devol.Add([ordered]@{ tipo = $tipo; origem = $o; numero = $d.numero; serie = $d.serie; data = $d.data; cfop = $cfop1; participante = $part; documento = $partDoc
                                   valor = (R2 $d.vNF); chave = $d.chave; referencia = ($d.refs -join ' ') })
    }
    foreach ($it in $d.itens) {
      $kt = '{0}|{1}|{2}|{3}|{4}' -f $o, $es, $it.cfop, $it.cst, $it.aliq
      if (-not $trib.ContainsKey($kt)) { $trib[$kt] = [ordered]@{ origem = $o; es = $es; cfop = $it.cfop; cst = $it.cst; aliq = $it.aliq; itens = 0; valor = [decimal]0; vBC = [decimal]0; vICMS = [decimal]0; vBCST = [decimal]0; vST = [decimal]0; vIPI = [decimal]0; vPIS = [decimal]0; vCOFINS = [decimal]0; vIBS = [decimal]0; vCBS = [decimal]0 } }
      $a = $trib[$kt]; $a.itens++; $a.valor += $it.valor; $a.vBC += $it.vBC; $a.vICMS += $it.vICMS; $a.vBCST += $it.vBCST; $a.vST += $it.vST; $a.vIPI += $it.vIPI; $a.vPIS += $it.vPIS; $a.vCOFINS += $it.vCOFINS; $a.vIBS += $it.vIBS; $a.vCBS += $it.vCBS
      $t.vBC += $it.vBC; $t.vICMS += $it.vICMS; $t.vST += $it.vST; $t.vIPI += $it.vIPI; $t.vPIS += $it.vPIS; $t.vCOFINS += $it.vCOFINS; $t.vIBS += $it.vIBS; $t.vCBS += $it.vCBS

      $kn = '{0}|{1}|{2}|{3}' -f $o, $it.ncm, $it.cst, $it.cstPis
      if (-not $ncm.ContainsKey($kn)) { $ncm[$kn] = [ordered]@{ origem = $o; ncm = $it.ncm; cest = $it.cest; cst = $it.cst; cstPis = $it.cstPis; cfops = @{}; itens = 0; produtos = @{}; valor = [decimal]0; vICMS = [decimal]0; vST = [decimal]0; vPIS = [decimal]0; vCOFINS = [decimal]0 } }
      $n = $ncm[$kn]; $n.itens++; $n.valor += $it.valor; $n.vICMS += $it.vICMS; $n.vST += $it.vST; $n.vPIS += $it.vPIS; $n.vCOFINS += $it.vCOFINS; $n.cfops[$it.cfop] = 1; $n.produtos[$it.cProd] = 1

      $kp = '{0}|{1}' -f $o, $it.cProd
      if (-not $prod.ContainsKey($kp)) { $prod[$kp] = [ordered]@{ origem = $o; codigo = $it.cProd; descricao = $it.xProd; ncm = $it.ncm; cst = $it.cst; un = $it.un; qtd = [decimal]0; valor = [decimal]0; itens = 0 } }
      $p = $prod[$kp]; $p.qtd += $it.qtd; $p.valor += $it.valor; $p.itens++

      $kc = '{0}|{1}|{2}' -f $o, $it.cstPis, $it.cstCofins
      if (-not $pc.ContainsKey($kc)) { $pc[$kc] = [ordered]@{ origem = $o; cstPis = $it.cstPis; cstCofins = $it.cstCofins; itens = 0; valor = [decimal]0; vPIS = [decimal]0; vCOFINS = [decimal]0 } }
      $c = $pc[$kc]; $c.itens++; $c.valor += $it.valor; $c.vPIS += $it.vPIS; $c.vCOFINS += $it.vCOFINS
    }
    if ($o -ne 'Compras') {
      foreach ($pg in $d.pag) {
        $kg = $o + '|' + $pg[0]
        if (-not $pagto.ContainsKey($kg)) { $nome = $TPAG[$pg[0]]; if (-not $nome) { $nome = 'Código ' + $pg[0] }; $pagto[$kg] = [ordered]@{ origem = $o; tPag = $pg[0]; forma = $nome; qtd = 0; valor = [decimal]0 } }
        $pagto[$kg].qtd++; $pagto[$kg].valor += $pg[1]
      }
    }
  }
  # falhas de numeração: números entre o menor e o maior do mês sem XML autorizado e sem inutilização
  $falhas = New-Object System.Collections.ArrayList
  foreach ($k in $numeros.Keys) {
    $mod = $k.Split('|')[0]; $ser = $k.Split('|')[1]; $set = $numeros[$k]
    $lista = @($set | Sort-Object); if ($lista.Count -lt 2) { continue }
    $inutSet = New-Object 'System.Collections.Generic.HashSet[long]'
    foreach ($iu in $script:AN.inut) { if ($iu.modelo -eq $mod -and [string]([int]$iu.serie) -eq [string]([int]$ser)) { for ($q = $iu.inicio; $q -le $iu.fim -and $q - $iu.inicio -lt 100000; $q++) { [void]$inutSet.Add($q) } } }
    $iniF = $null
    for ($q = $lista[0]; $q -le $lista[-1] + 1; $q++) {
      $falta = ($q -le $lista[-1]) -and -not $set.Contains($q) -and -not $inutSet.Contains($q)
      if ($falta -and $null -eq $iniF) { $iniF = $q }
      if (-not $falta -and $null -ne $iniF) { [void]$falhas.Add([ordered]@{ modelo = $mod; serie = $ser; de = $iniF; ate = ($q - 1); quantidade = ($q - $iniF) }); $iniF = $null }
      if ($falhas.Count -gt 500) { break }
    }
  }
  function Fechar($h) {
    foreach ($v in $h.Values) { foreach ($kk in @($v.Keys)) { if ($v[$kk] -is [decimal]) { $v[$kk] = R2 $v[$kk] } } }
    return @($h.Values)
  }
  foreach ($n in $ncm.Values) { $n.cfops = (@($n.cfops.Keys) | Sort-Object) -join ', '; $n.produtos = $n.produtos.Count }
  $todosProd = @(Fechar $prod)
  $topProd = @()
  foreach ($o in @('NFe', 'NFCe', 'Compras')) { $topProd += @($todosProd | Where-Object { $_.origem -eq $o } | Sort-Object { $_.valor } -Descending | Select-Object -First 300) }
  foreach ($p in $topProd) { $p.qtd = [Math]::Round([decimal]$p.qtd, 3) }
  $crt = ''; if ($crts.Count) { $crt = ($crts.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 1).Key }
  # dia a dia: documentos com XML (e, no LC, quantos o sistema tem)
  $dias = @{}
  foreach ($d in $script:AN.docs.Values) {
    if (-not $d.data) { continue }
    if (-not $dias.ContainsKey($d.data)) { $dias[$d.data] = [ordered]@{ dia = $d.data; nfe = 0; nfce = 0; compras = 0; canc = 0; vNfe = [decimal]0; vNfce = [decimal]0; vCompras = [decimal]0 } }
    $x = $dias[$d.data]
    if ($script:AN.canceladas.ContainsKey($d.chave)) { $x.canc++ }
    if ($d.origem -eq 'NFCe') { $x.nfce++; $x.vNfce += $d.vNF } elseif ($d.origem -eq 'Compras') { $x.compras++; $x.vCompras += $d.vNF } else { $x.nfe++; $x.vNfe += $d.vNF }
  }
  if ($script:AN.sistemaDia) {
    foreach ($k in $script:AN.sistemaDia.Keys) {
      if (-not $dias.ContainsKey($k)) { $dias[$k] = [ordered]@{ dia = $k; nfe = 0; nfce = 0; compras = 0; canc = 0; vNfe = [decimal]0; vNfce = [decimal]0; vCompras = [decimal]0 } }
      $s = $script:AN.sistemaDia[$k]
      if ($s.nfe) { $dias[$k].sisNfe = $s.nfe[0]; $dias[$k].sisNfeXml = $s.nfe[1] }
      if ($s.nfce) { $dias[$k].sisNfce = $s.nfce[0]; $dias[$k].sisNfceXml = $s.nfce[1] }
    }
  }
  $porDia = @($dias.Keys | Sort-Object | ForEach-Object { $v = $dias[$_]; $v.vNfe = R2 $v.vNfe; $v.vNfce = R2 $v.vNfce; $v.vCompras = R2 $v.vCompras; $v })
  $totais = [ordered]@{}; foreach ($k in $tot.Keys) { $v = $tot[$k]; foreach ($kk in @($v.Keys)) { if ($v[$kk] -is [decimal]) { $v[$kk] = R2 $v[$kk] } }; $totais[$k] = $v }
  return [ordered]@{
    versao = 1; cliente = $emp.cliente; contabilidade = $emp.contabilidade; subpasta = $emp.subpasta; cnpj = $emp.cnpj
    mes = $mes.ToString('yyyy-MM'); geradoEm = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'); agente = $VERSAO; crt = $crt
    totais = $totais; cte = [ordered]@{ qtd = $script:AN.cte.qtd; valor = (R2 $script:AN.cte.valor) }; mdfe = $script:AN.mdfe
    tributacao = @(Fechar $trib); ncm = @(Fechar $ncm); pisCofins = @(Fechar $pc); pagamentos = @(Fechar $pagto)
    produtos = $topProd; produtosDistintos = $todosProd.Count
    devolucoes = @($devol); canceladas = @($canc); inutilizacoes = @($script:AN.inut); falhasNumeracao = @($falhas)
    ultimosNumeros = @($ultimos.Values)
    certificadoXml = (Ler-CertificadoXml $script:AN.certCliente)
    porDia = $porDia; comSistema = [bool]$script:AN.sistemaDia
    pendencias = @($(if ($script:AN.pendencias) { $script:AN.pendencias } else { @() })); comPendencias = ($null -ne $script:AN.pendencias)
    rtc = $(try { Conferir-Rtc $mes } catch { [ordered]@{ erro = $_.Exception.Message } })
    reforma = [ordered]@{
      porOrigem = $rfOrig; classes = @(Fechar $rfCls); semGrupo = @($rfSem)
      fornecedores = [ordered]@{ total = $rfForn.Count; com = @($rfForn.Values | Where-Object { $_ }).Count }
    }
  }
}

# ---------------------------------------------------------------- monta o ZIP de um mês de uma empresa
function Gerar-Zip($emp, [datetime]$mes, [string]$destino) {
  $E = [int]$emp.id
  $ini = $mes.ToString('yyyy-MM-01'); $fim = $mes.AddMonths(1).ToString('yyyy-MM-01')
  $cont = [ordered]@{ nfe = 0; nfeEventos = 0; nfce = 0; nfceEventos = 0; compras = 0; mde = 0; cte = 0; cteEventos = 0; mdfe = 0; mdfeEventos = 0; cce = 0; inut = 0 }
  $script:ignorados = 0; $script:errosAnalise = 0
  $script:nomes = @{}
  $script:valores = @{}; $script:canceladas = @{}
  Nova-Analise
  $fs = [System.IO.File]::Open($destino, [System.IO.FileMode]::Create)
  $zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)

  $adicionar = {
    param([string]$pasta, [string]$nome, [byte[]]$bytes)
    $caminho = $pasta + '/' + $nome
    $h = Sha256-Hex $bytes
    # o LC às vezes guarda o mesmo documento duas vezes: fica só o primeiro (mesma chave = mesmo documento)
    if ($script:nomes.ContainsKey($caminho)) { return $false }
    $script:nomes[$caminho] = $h
    $ent = $zip.CreateEntry($caminho, [System.IO.Compression.CompressionLevel]::Optimal)
    $s = $ent.Open(); try { $s.Write($bytes, 0, $bytes.Length) } finally { $s.Dispose() }
    return $true
  }

  # grupo -> pasta do documento / pasta dos eventos / contadores
  $rotas = @{
    nfe     = @{ doc = 'NFe_Emitidas'; ev = 'NFe_Emitidas/Eventos'; cDoc = 'nfe'; cEv = 'nfeEventos' }
    nfce    = @{ doc = 'NFCe'; ev = 'NFCe/Eventos'; cDoc = 'nfce'; cEv = 'nfceEventos' }
    compras = @{ doc = 'NFe_Compras'; ev = 'NFe_Compras/Eventos'; cDoc = 'compras'; cEv = 'compras' }
    mde     = @{ doc = 'NFe_Destinadas_MDe'; ev = 'NFe_Destinadas_MDe/Eventos'; cDoc = 'mde'; cEv = 'mde' }
    cte     = @{ doc = 'CTe'; ev = 'CTe/Eventos'; cDoc = 'cte'; cEv = 'cteEventos' }
    mdfe    = @{ doc = 'MDFe'; ev = 'MDFe/Eventos'; cDoc = 'mdfe'; cEv = 'mdfeEventos' }
    cce     = @{ doc = 'NFe_Emitidas/Eventos'; ev = 'NFe_Emitidas/Eventos'; cDoc = 'cce'; cEv = 'cce' }
    inut    = @{ doc = 'Inutilizacoes'; ev = 'Inutilizacoes'; cDoc = 'inut'; cEv = 'inut' }
  }

  $consultas = @(
    @{ g = 'nfe';     sql = "SELECT HEX(xml), HEX(cancel_xml) FROM nfe WHERE id_empresa=$E AND dados_dataemissao>='$ini' AND dados_dataemissao<'$fim' AND xml IS NOT NULL AND xml<>''" },
    @{ g = 'nfce';    sql = "SELECT HEX(x.xml) FROM nfcexml x JOIN nfce n ON n.id=x.id_nfce WHERE n.id_empresa=$E AND n.ide_dhemi>='$ini' AND n.ide_dhemi<'$fim' AND x.xml IS NOT NULL AND x.xml<>''" },
    @{ g = 'compras'; sql = "SELECT HEX(xml) FROM entrada WHERE id_empresa=$E AND COALESCE(data_entradasaida,data_emissao)>='$ini' AND COALESCE(data_entradasaida,data_emissao)<'$fim' AND xml IS NOT NULL AND xml<>''" },
    @{ g = 'cte';     sql = "SELECT HEX(x.xml) FROM ctexml x JOIN cte c ON c.id=x.id_cte WHERE c.id_empresa=$E AND c.ide_dhemi>='$ini' AND c.ide_dhemi<'$fim' AND x.xml IS NOT NULL AND x.xml<>''" },
    @{ g = 'mdfe';    sql = "SELECT HEX(x.xml) FROM mdfexml x JOIN mdfe m ON m.id=x.id_mdfe WHERE m.id_empresa=$E AND m.ide_dhEmi>='$ini' AND m.ide_dhEmi<'$fim' AND x.xml IS NOT NULL AND x.xml<>''" },
    @{ g = 'cce';     sql = "SELECT HEX(c.xml_retorno), HEX(c.xml_envio) FROM nfecce c JOIN nfe n ON n.id=c.id_nfe WHERE n.id_empresa=$E AND c.data_hora>='$ini' AND c.data_hora<'$fim'" },
    @{ g = 'inut';    sql = "SELECT HEX(xml) FROM nfeinutilizacao WHERE id_empresa=$E AND data_hora>='$ini' AND data_hora<'$fim' AND xml IS NOT NULL AND xml<>''" }
  )
  if ($SISTEMA -eq 'gestores') {
    # Gestores: cada filial (cod_filial) é uma empresa. NFC-e: 1 = autorizada, 2 = cancelada; NF-e: 3 = autorizada, 4 = cancelada
    # A coluna 'CANC' marca NFC-e cancelada (o XML do cancelamento fica só no PDV da loja)
    $consultas = @(
      @{ g = 'nfe';     sql = "SELECT upper(encode(arquivo_xml,'hex')), upper(encode(arquivo_can_xml,'hex')) FROM mv_nota_saida WHERE cod_filial=$E AND modelo='55' AND situacao_xml IN (3,4) AND data_ex IS NULL AND data_emissao>='$ini' AND data_emissao<'$fim' AND arquivo_xml IS NOT NULL" },
      @{ g = 'nfce';    sql = "SELECT upper(encode(xml,'hex')), CASE WHEN situacao=2 THEN 'CANC' ELSE '' END FROM mv_venda WHERE cod_filial=$E AND modelo='65' AND situacao IN (1,2) AND data_ex IS NULL AND data>='$ini' AND data<'$fim' AND xml IS NOT NULL" },
      @{ g = 'compras'; sql = "SELECT upper(encode(arquivo,'hex')) FROM mv_nota_entrada WHERE cod_filial=$E AND modelo='55' AND data_ex IS NULL AND COALESCE(data_lancamento,data_emissao)>='$ini' AND COALESCE(data_lancamento,data_emissao)<'$fim' AND arquivo IS NOT NULL" },
      @{ g = 'cte';     sql = "SELECT upper(encode(arquivo_xml,'hex')), upper(encode(arquivo_can_xml,'hex')) FROM ct_cte WHERE cod_filial=$E AND data_ex IS NULL AND data_emissao>='$ini' AND data_emissao<'$fim' AND arquivo_xml IS NOT NULL" },
      @{ g = 'mdfe';    sql = "SELECT upper(encode(arquivo_xml,'hex')) FROM fis_mdfe WHERE cod_filial=$E AND data_ex IS NULL AND data_emissao>='$ini' AND data_emissao<'$fim' AND arquivo_xml IS NOT NULL" },
      @{ g = 'cce';     sql = "SELECT upper(encode(arquivo_xml,'hex')), upper(encode(arquivo_xml_cancelamento,'hex')) FROM fis_eventos WHERE cod_filial=$E AND data_ex IS NULL AND emissao_evento>='$ini' AND emissao_evento<'$fim' AND (arquivo_xml IS NOT NULL OR arquivo_xml_cancelamento IS NOT NULL)" },
      @{ g = 'inut';    sql = "SELECT upper(encode(xml,'hex')) FROM tab_documentos_inutilizados WHERE cod_filial=$E AND data_ex IS NULL AND data>='$ini' AND data<'$fim' AND xml IS NOT NULL" }
    )
  }
  if ($CFG.incluirMDe -and $SISTEMA -ne 'gestores') {
    $consultas += @{ g = 'mde'; sql = "SELECT HEX(x.xml) FROM mdexml x JOIN mde m ON m.id=x.id_mde WHERE m.id_empresa=$E AND m.emitente_dhEmi>='$ini' AND m.emitente_dhEmi<'$fim' AND x.xml IS NOT NULL AND x.xml<>''" }
  }

  $avisos = @()
  try {
    foreach ($q in $consultas) {
      $g = $q.g; $rota = $rotas[$g]
      $porLinha = {
        param($linha)
        $cols = $linha -split "`t"
        $textos = @(); $marcaCanc = $false
        foreach ($c in $cols) { if ($c -eq 'CANC') { $marcaCanc = $true; continue }; if ($c -and $c -ne 'NULL') { $textos += ,(Bytes-ParaTexto (De-Hex $c)) } }
        if ($g -eq 'cce') {   # CC-e: prefere o XML com protocolo (procEventoNFe)
          $melhor = $textos | Where-Object { $_ -match '<procEventoNFe' } | Select-Object -First 1
          if (-not $melhor) { $melhor = $textos | Where-Object { $_ -match '<retEvento' } | Select-Object -First 1 }
          $textos = @(); if ($melhor) { $textos = @($melhor) }
        }
        foreach ($t in $textos) {
          $inf = Info-Xml $t
          if (-not $inf.autorizado -or -not $inf.nome) { $script:ignorados++; continue }
          $bytes = $UTF8.GetBytes($t)
          if ($inf.tipo -eq 'doc' -or $inf.tipo -eq 'inut') {
            if (& $adicionar $rota.doc $inf.nome $bytes) {
              $cont[$rota.cDoc]++
              if ($g -eq 'nfe' -or $g -eq 'nfce') { if ($t -match '<vNF>([\d.]+)</vNF>') { $script:valores[$inf.chave] = @($g, [decimal]::Parse($matches[1], [Globalization.CultureInfo]::InvariantCulture)) } }
              if ($inf.tipo -eq 'inut') { Analisar-Inut $t } else { try { Analisar-Doc $g $t } catch { $script:errosAnalise++ } }
            }
            if ($marcaCanc -and $inf.tipo -eq 'doc' -and $inf.chave) { $script:canceladas[$inf.chave] = $true; $script:AN.canceladas[$inf.chave] = $true }
          } else {
            if (& $adicionar $rota.ev $inf.nome $bytes) { $cont[$rota.cEv]++ }
            if ($inf.tpEvento -eq '110111' -and $inf.chave) { $script:canceladas[$inf.chave] = $true; $script:AN.canceladas[$inf.chave] = $true }
          }
        }
      }
      try { [void](Invoke-Db $q.sql $porLinha) }
      catch {
        if ($_.Exception.Message -match "doesn't exist|Unknown column|does not exist") { $avisos += "tabela/coluna de $g não existe nesta versão do sistema" }
        else { throw }
      }
    }

    # resumo dentro do ZIP
    $totNfe = [decimal]0; $totNfce = [decimal]0; $qCancNfe = 0; $qCancNfce = 0
    foreach ($k in $script:valores.Keys) {
      $v = $script:valores[$k]
      if ($script:canceladas.ContainsKey($k)) { if ($v[0] -eq 'nfe') { $qCancNfe++ } else { $qCancNfce++ }; continue }
      if ($v[0] -eq 'nfe') { $totNfe += $v[1] } else { $totNfce += $v[1] }
    }
    $br = [Globalization.CultureInfo]::GetCultureInfo('pt-BR')
    $res = @(
      ('XML FISCAIS - ' + $emp.cliente),
      ('CNPJ: ' + $emp.cnpj),
      ('Período: ' + $mes.ToString('MM/yyyy')),
      ('Gerado em: ' + (Get-Date -Format 'dd/MM/yyyy HH:mm') + '  (agente Farol v' + $VERSAO + ' - CPUSIS - sistema: ' + $(if ($SISTEMA -eq 'gestores') { 'Gestores' } else { 'LC' }) + ')'),
      '',
      ('NF-e emitidas ..................: {0}  (canceladas: {1})  valor autorizado: R$ {2}' -f $cont.nfe, $qCancNfe, $totNfe.ToString('N2', $br)),
      ('NF-e eventos (cancel./CC-e) ....: {0}  (cartas de correção: {1})' -f ($cont.nfeEventos + $cont.cce), $cont.cce),
      ('NFC-e ..........................: {0}  (canceladas: {1})  valor autorizado: R$ {2}' -f $cont.nfce, $qCancNfce, $totNfce.ToString('N2', $br)),
      ('NFC-e eventos ..................: {0}' -f $cont.nfceEventos),
      ('NF-e de compras (XML importados): {0}' -f $cont.compras),
      ('CT-e ...........................: {0}  eventos: {1}' -f $cont.cte, $cont.cteEventos),
      ('MDF-e ..........................: {0}  eventos: {1}' -f $cont.mdfe, $cont.mdfeEventos),
      ('Inutilizações ..................: {0}' -f $cont.inut)
    )
    if ($CFG.incluirMDe) { $res += ('NF-e destinadas (MD-e) .........: {0}' -f $cont.mde) }
    $res += ''
    $res += 'Pastas: NFe_Emitidas, NFCe, NFe_Compras, CTe, MDFe, Inutilizacoes (eventos em subpasta "Eventos").'
    $resBytes = $UTF8.GetBytes(($res -join "`r`n"))
    $ent = $zip.CreateEntry('RESUMO.txt'); $s = $ent.Open(); try { $s.Write($resBytes, 0, $resBytes.Length) } finally { $s.Dispose() }
  }
  finally { $zip.Dispose(); $fs.Dispose() }

  # impressão digital do conteúdo (para saber se mudou desde o último envio)
  $lista = ($script:nomes.Keys | Sort-Object | ForEach-Object { $_ + '=' + $script:nomes[$_] }) -join "`n"
  # quantos documentos o LC tem em cada dia e quantos têm XML (para o calendário do portal)
  try {
    $sd = @{}
    $guardar = { param($tipo, $linha) $c = $linha -split "`t"; if ($c[0] -notmatch '^\d{4}-\d{2}-\d{2}$') { return }; if (-not $sd.ContainsKey($c[0])) { $sd[$c[0]] = @{} }; $sd[$c[0]][$tipo] = @([int]$c[1], [int]$c[2]) }
    if ($SISTEMA -eq 'gestores') {
      [void](Invoke-Pg "SELECT data_emissao::text, count(*), count(arquivo_xml) FROM mv_nota_saida WHERE cod_filial=$E AND modelo='55' AND data_ex IS NULL AND data_emissao>='$ini' AND data_emissao<'$fim' GROUP BY 1" { param($l) & $guardar 'nfe' $l })
      [void](Invoke-Pg "SELECT data::text, count(*), count(*) FILTER (WHERE xml IS NOT NULL AND position('nfeProc' in encode(substring(xml from 1 for 300),'escape'))>0) FROM mv_venda WHERE cod_filial=$E AND modelo='65' AND data_ex IS NULL AND data>='$ini' AND data<'$fim' GROUP BY 1" { param($l) & $guardar 'nfce' $l })
    } else {
    [void](Invoke-MySql "SELECT DATE(dados_dataemissao), COUNT(*), SUM(xml IS NOT NULL AND xml<>'') FROM nfe WHERE id_empresa=$E AND dados_dataemissao>='$ini' AND dados_dataemissao<'$fim' GROUP BY 1" { param($l) & $guardar 'nfe' $l })
    [void](Invoke-MySql "SELECT DATE(n.ide_dhemi), COUNT(DISTINCT n.id), COUNT(DISTINCT CASE WHEN x.xml IS NOT NULL AND x.xml<>'' THEN n.id END) FROM nfce n LEFT JOIN nfcexml x ON x.id_nfce=n.id WHERE n.id_empresa=$E AND n.ide_dhemi>='$ini' AND n.ide_dhemi<'$fim' GROUP BY 1" { param($l) & $guardar 'nfce' $l })
    }
    $script:AN.sistemaDia = $sd
  } catch { $avisos += ('contagem diária do sistema não feita: ' + $_.Exception.Message) }
  # pendências: documentos do LC sem autorização (em digitação, rejeitados, contingência não transmitida, sem XML)
  try {
    $pend = New-Object System.Collections.ArrayList
    $limpa = { param($s) (($s -replace '\\n', ' ' -replace '\s+', ' ').Trim()) }
    if ($SISTEMA -eq 'gestores') {
      [void](Invoke-Pg "SELECT modelo, coalesce(serie,''), coalesce(numero,''), data_emissao::text, situacao_xml::text FROM mv_nota_saida WHERE cod_filial=$E AND modelo='55' AND data_ex IS NULL AND situacao_xml NOT IN (3,4) AND data_emissao>='$ini' AND data_emissao<'$fim' ORDER BY data_emissao LIMIT 300" {
        param($l) $c = $l -split "`t"; if ($c.Count -lt 5) { return }
        [void]$pend.Add([ordered]@{ modelo = $c[0]; serie = $c[1]; numero = $c[2]; data = $c[3]; tipo = 'digitacao'; motivo = ('não transmitida (situação ' + $c[4] + ' no Gestores)') })
      })
      [void](Invoke-Pg "SELECT modelo, coalesce(serie,''), coalesce(numero,''), data::text, coalesce(chave_cfe,''), coalesce(protocolo_cfe,''), (xml IS NULL)::int FROM mv_venda WHERE cod_filial=$E AND modelo='65' AND situacao=1 AND data_ex IS NULL AND data>='$ini' AND data<'$fim' AND (xml IS NULL OR position('nfeProc' in encode(substring(xml from 1 for 300),'escape'))=0) ORDER BY data, numero LIMIT 300" {
        param($l) $c = $l -split "`t"; if ($c.Count -lt 7) { return }
        $mot = $(if ($c[6] -eq '1') { 'o XML não está gravado no Gestores' } else { 'autorizada' + $(if ($c[5]) { ' (protocolo ' + $c[5] + ')' } else { '' }) + ', mas o XML gravado no Gestores não tem a autorização da SEFAZ' })
        if ($c[4]) { $mot += ' - chave ' + $c[4] }
        [void]$pend.Add([ordered]@{ modelo = $c[0]; serie = $c[1]; numero = $c[2]; data = $c[3]; tipo = 'semxml'; motivo = $mot })
      })
    } else {
    [void](Invoke-MySql "SELECT IFNULL(dados_modelo,'55'), IFNULL(dados_serie,''), IFNULL(dados_n_nota,''), DATE(dados_dataemissao), LEFT(REPLACE(REPLACE(IFNULL(situacao,''),CHAR(9),' '),CHAR(10),' '),200), IFNULL(dados_tpemis,'') FROM nfe WHERE id_empresa=$E AND IFNULL(status,'')<>'EX' AND (xml IS NULL OR xml='') AND IFNULL(inutiliza_motivo,'')='' AND dados_dataemissao>='$ini' AND dados_dataemissao<'$fim' ORDER BY dados_dataemissao LIMIT 300" {
      param($l) $c = $l -split "`t"; if ($c.Count -lt 6) { return }
      $sit = & $limpa $c[4]
      $tipo = 'rejeitada'; if ($sit -match '(?i)digita') { $tipo = 'digitacao' } elseif ($c[5] -eq '9' -or $c[5] -eq '6' -or $c[5] -eq '7') { $tipo = 'contingencia' } elseif (-not $sit) { $tipo = 'semxml' }
      [void]$pend.Add([ordered]@{ modelo = $c[0]; serie = $c[1]; numero = $c[2]; data = $c[3]; tipo = $tipo; motivo = $sit })
    })
    [void](Invoke-MySql "SELECT IFNULL(n.ide_mod,'65'), IFNULL(n.ide_serie,''), IFNULL(n.ide_numero,''), DATE(n.ide_dhemi), LEFT(REPLACE(REPLACE(IFNULL(n.aut_motivo,''),CHAR(9),' '),CHAR(10),' '),200), IFNULL(n.ide_tpemis,''), IFNULL(n.aut_status,''), IFNULL(n.cont_datahora,''), (SELECT COUNT(*) FROM nfcexml x WHERE x.id_nfce=n.id AND x.xml IS NOT NULL AND x.xml<>'') FROM nfce n WHERE n.id_empresa=$E AND n.ide_dhemi>='$ini' AND n.ide_dhemi<'$fim' AND IFNULL(n.aut_inutcstatus,'')<>'102' AND (IFNULL(n.aut_status,'') NOT IN ('100','150') OR NOT EXISTS (SELECT 1 FROM nfcexml x WHERE x.id_nfce=n.id AND x.xml IS NOT NULL AND x.xml<>'')) ORDER BY n.ide_dhemi LIMIT 300" {
      param($l) $c = $l -split "`t"; if ($c.Count -lt 9) { return }
      $mot = & $limpa $c[4]
      if ($c[6] -eq '100' -or $c[6] -eq '150') { $tipo = 'semxml'; $mot = 'autorizada, mas o XML não está gravado no sistema' }
      elseif ($c[5] -eq '9') { $tipo = 'contingencia'; if (-not $mot) { $mot = 'emitida offline em ' + $c[7] + ', ainda não transmitida' } }
      elseif ($mot) { $tipo = 'rejeitada' } else { $tipo = 'semxml'; $mot = 'não transmitida' }
      [void]$pend.Add([ordered]@{ modelo = $c[0]; serie = $c[1]; numero = $c[2]; data = $c[3]; tipo = $tipo; motivo = $mot })
    })
    }
    $script:AN.pendencias = $pend
  } catch { $avisos += ('pendências não verificadas: ' + $_.Exception.Message) }
  $resumo = $null
  try { $resumo = Montar-Resumo $emp $mes } catch { $avisos += ('resumo fiscal não gerado: ' + $_.Exception.Message) }
  if ($script:errosAnalise) { $avisos += "$($script:errosAnalise) XML não puderam ser analisados" }
  return @{ contagens = $cont; hash = (Sha256-Hex ($UTF8.GetBytes($lista))); arquivos = $script:nomes.Count; ignorados = $script:ignorados; avisos = $avisos; resumo = $resumo }
}

# ---------------------------------------------------------------- comunicação com o receptor (Google)
function Chamar-Receptor($obj) {
  $obj.senha = $CFG.senha
  $json = $obj | ConvertTo-Json -Depth 6 -Compress
  $r = Invoke-RestMethod -Uri $CFG.receptorUrl -Method Post -Body ($UTF8.GetBytes($json)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 300
  if ($r -is [string]) { $r = $r | ConvertFrom-Json }
  if (-not $r.ok) { throw ('Receptor: ' + $r.erro) }
  return $r
}

function Enviar-Arquivo($emp, [datetime]$mes, [string]$zipPath, [string]$nomeArquivo, [string]$destino = 'xml') {
  $tam = (Get-Item $zipPath).Length
  $tipo = 'application/zip'; if ($destino -eq 'portal') { $tipo = 'application/json' }
  $tentativa = 0
  while ($true) {
    $tentativa++
    try {
      $ini = Chamar-Receptor @{ acao = 'iniciar'; destino = $destino; contabilidade = $emp.contabilidade; cliente = $emp.cliente; subpasta = $emp.subpasta;
                                 ano = $mes.Year; mes = $mes.Month; arquivo = $nomeArquivo; tamanho = $tam; tipo = $tipo }
      $resp = Invoke-WebRequest -Uri $ini.uploadUrl -Method Put -InFile $zipPath -ContentType $tipo -UseBasicParsing -TimeoutSec 3600
      if ([int]$resp.StatusCode -ge 300) { throw "Drive respondeu $($resp.StatusCode)" }
      return $ini
    } catch {
      if ($tentativa -ge 3) { throw }
      Log ("  tentativa $tentativa falhou: " + $_.Exception.Message + ' - tentando de novo em 30s')
      Start-Sleep -Seconds 30
    }
  }
}

# ---------------------------------------------------------------- estado (último envio de cada mês)
function Ler-Estado {
  $h = @{}
  if (Test-Path $ARQ_ESTADO) {
    try {
      $o = Get-Content $ARQ_ESTADO -Raw -Encoding UTF8 | ConvertFrom-Json
      foreach ($p in $o.PSObject.Properties) { $h[$p.Name] = $p.Value }
    } catch { Log 'Aviso: estado.json ilegível, será recriado.' }
  }
  return $h
}
function Gravar-Estado($h) { ($h | ConvertTo-Json -Depth 6) | Set-Content -Path $ARQ_ESTADO -Encoding UTF8 }

# ================================================================= PROCESSADOR DOS XML ENVIADOS À MÃO
function Baixar-Arquivo([string]$id, [long]$tam) {
  $ms = New-Object System.IO.MemoryStream
  [long]$ini = 0; $parte = 8388608
  while ($true) {
    $r = Chamar-Receptor @{ acao = 'baixarParte'; id = $id; inicio = $ini; tamanho = $parte }
    if (-not $r.dados) { break }
    $b = [Convert]::FromBase64String($r.dados); $ms.Write($b, 0, $b.Length); $ini += $b.Length
    if ($b.Length -lt $parte -or ($tam -gt 0 -and $ini -ge $tam)) { break }
  }
  $ms.Position = 0
  return $ms
}
function Ler-Zip([System.IO.Stream]$st, [scriptblock]$cada, [int]$nivel) {
  $z = New-Object System.IO.Compression.ZipArchive($st, [System.IO.Compression.ZipArchiveMode]::Read, $true)
  try {
    foreach ($e in $z.Entries) {
      if ($e.Length -eq 0) { continue }
      $n = $e.FullName.ToLower()
      if ($n.EndsWith('.xml') -or ($n.EndsWith('.zip') -and $nivel -lt 2)) {
        $s = $e.Open(); $m = New-Object System.IO.MemoryStream; $s.CopyTo($m); $s.Dispose()
        if ($n.EndsWith('.xml')) { & $cada $e.Name ($m.ToArray()) } else { $m.Position = 0; Ler-Zip $m $cada ($nivel + 1) }
        $m.Dispose()
      }
    }
  } finally { $z.Dispose() }
}
function Formatar-Doc([string]$d) {
  if ($d -match '^\d{14}$') { return $d.Substring(0, 2) + '.' + $d.Substring(2, 3) + '.' + $d.Substring(5, 3) + '/' + $d.Substring(8, 4) + '-' + $d.Substring(12, 2) }
  return $d
}

function Processar-Manuais {
  $inicio = Get-Date
  Log 'Buscando no Drive os meses com XML enviados à mão...'
  $lista = Chamar-Receptor @{ acao = 'manuais' }
  # só a partir deste mês (config.json "manuaisDesde": "AAAA-MM"; padrão 2026-01)
  $desde = '2026-01'; if ($CFG.manuaisDesde) { $desde = [string]$CFG.manuaisDesde }
  $todos = @($lista.itens)
  $itens = @($todos | Where-Object { [string]$_.mes -ge $desde })
  if ($todos.Count -ne $itens.Count) { Log ("{0} meses anteriores a {1} ignorados." -f ($todos.Count - $itens.Count), $desde) }
  # versão nova do programa: refaz uma vez o mês atual e o anterior (o resumo ganha o que a versão nova calcula)
  $estM = Ler-Estado; $mesRefaz = (Get-Date).AddMonths(-1).ToString('yyyy-MM')
  $refazVersao = ([string]$estM['_manuaisVersao'] -ne $VERSAO)
  if ($refazVersao) { Log "Versão $VERSAO do programa: refazendo os resumos a partir de $mesRefaz." }
  $pend = @($itens | Where-Object {
    if ($Tudo -or -not $_.resumoMod) { return $true }
    if ($refazVersao -and [string]$_.mes -ge $mesRefaz) { return $true }
    $rm = [datetime]$_.resumoMod
    return [bool](@($_.arquivos | Where-Object { [datetime]$_.mod -gt $rm }).Count)
  } | Sort-Object { $_.mes } -Descending)
  Log ("{0} meses de clientes encontrados no Drive; {1} precisam de resumo." -f $itens.Count, $pend.Count)
  $erros = 0
  foreach ($it in $pend) {
    if (((Get-Date) - $inicio).TotalMinutes -gt $LimiteMinutos) { Log "Limite de $LimiteMinutos minutos atingido: o restante fica para a próxima execução."; break }
    $rot = '{0} / {1}{2} {3}' -f $it.contabilidade, $it.cliente, $(if ($it.subpasta) { ' / ' + $it.subpasta } else { '' }), $it.mes
    try {
      Log "-> $rot  ($(@($it.arquivos).Count) arquivo(s))"
      Nova-Analise
      $script:ignorados = 0; $script:errosAnalise = 0; $script:lidos = 0
      $cada = {
        param($nome, [byte[]]$bytes)
        $t = Bytes-ParaTexto $bytes
        $inf = Info-Xml $t
        if (-not $inf.autorizado) { $script:ignorados++; return }
        $script:lidos++
        if ($inf.tipo -eq 'evento') { if ($inf.tpEvento -eq '110111' -and $inf.chave) { $script:AN.canceladas[$inf.chave] = $true } }
        elseif ($inf.tipo -eq 'inut') { Analisar-Inut $t }
        else { try { Analisar-Doc 'auto' $t } catch { $script:errosAnalise++ } }
      }
      $semZip = -not @($it.arquivos | Where-Object { [string]$_.nome -match '\.zip$' }).Count
      $soltos = New-Object System.Collections.ArrayList
      foreach ($a in @($it.arquivos)) {
        $nome = [string]$a.nome
        if ($nome -notmatch '\.(zip|xml)$') { continue }
        $ms = Baixar-Arquivo $a.id ([long]$a.tamanho)
        try {
          if ($nome -match '\.zip$') { Ler-Zip $ms $cada 0 }
          else { $bx = $ms.ToArray(); & $cada $nome $bx; if ($semZip) { [void]$soltos.Add(@($nome, $bx)) } }
        } catch { Log ("   aviso: não consegui ler " + $nome + ': ' + $_.Exception.Message) }
        finally { $ms.Dispose() }
      }
      # só XML soltos na pasta: junta tudo num ZIP do mês para o contador baixar pelo portal
      if ($semZip -and $soltos.Count) {
        $mesZ = [datetime]::ParseExact($it.mes + '-01', 'yyyy-MM-dd', $null)
        $nomeZip = (Nome-Seguro $it.cliente) + ' - XML ' + $mesZ.ToString('MM.yyyy') + '.zip'
        $zp = Join-Path $PASTA_TMP ([guid]::NewGuid().ToString('N') + '.zip')
        $fz = [System.IO.File]::Open($zp, [System.IO.FileMode]::Create)
        $za = New-Object System.IO.Compression.ZipArchive($fz, [System.IO.Compression.ZipArchiveMode]::Create)
        try { foreach ($s in $soltos) { $en = $za.CreateEntry($s[0], [System.IO.Compression.CompressionLevel]::Optimal); $w = $en.Open(); $w.Write($s[1], 0, $s[1].Length); $w.Dispose() } }
        finally { $za.Dispose(); $fz.Dispose() }
        try { [void](Enviar-Arquivo @{ contabilidade = $it.contabilidade; cliente = $it.cliente; subpasta = $it.subpasta } $mesZ $zp $nomeZip); Log "   ZIP do mês criado com os $($soltos.Count) XML soltos: $nomeZip" }
        finally { Remove-Item $zp -Force -ErrorAction SilentlyContinue }
      }
      if (-not $script:AN.docs.Count -and -not $script:AN.inut.Count) { Log "   nenhum XML autorizado encontrado (lidos: $($script:lidos), sem protocolo: $($script:ignorados))"; continue }

      # quem é o cliente: o CNPJ que aparece (como emitente ou destinatário) no maior número de documentos
      $freq = @{}
      foreach ($d in $script:AN.docs.Values) { foreach ($c in @($d.emitDoc, $d.destDoc)) { if ($c) { $freq[$c] = 1 + [int]$freq[$c] } } }
      $cnpj = ($freq.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 1).Key
      foreach ($d in $script:AN.docs.Values) {
        if ($d.emitDoc -eq $cnpj) { if ($d.modelo -eq '65') { $d.origem = 'NFCe' } else { $d.origem = 'NFe' } } else { $d.origem = 'Compras' }
      }
      $script:AN.certCliente = $script:AN.certs[$cnpj]
      $emp = @{ cliente = $it.cliente; contabilidade = $it.contabilidade; subpasta = $it.subpasta; cnpj = (Formatar-Doc $cnpj) }
      $mesDt = [datetime]::ParseExact($it.mes + '-01', 'yyyy-MM-dd', $null)
      $res = Montar-Resumo $emp $mesDt
      $res.origemDados = 'XML enviados ao Drive'
      $tmp = Join-Path $PASTA_TMP ('manual_' + [guid]::NewGuid().ToString('N') + '.json')
      [IO.File]::WriteAllText($tmp, ($res | ConvertTo-Json -Depth 8 -Compress), $UTF8)
      try { [void](Enviar-Arquivo $emp $mesDt $tmp ($it.mes + '.json') 'portal') } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
      $tt = $res.totais
      $q = { param($o, $k) if ($tt.Contains($o)) { return [int]$tt[$o][$k] } else { return 0 } }
      $cont = @{ nfe = ((& $q 'NFe' 'qtd') + (& $q 'NFe' 'canceladas')); nfce = ((& $q 'NFCe' 'qtd') + (& $q 'NFCe' 'canceladas')); compras = (& $q 'Compras' 'qtd'); inut = $script:AN.inut.Count; cte = $script:AN.cte.qtd; mdfe = $script:AN.mdfe }
      Log ('   resumo enviado ao portal | CNPJ {0} | NF-e {1}, NFC-e {2}, compras {3} | sem protocolo {4}' -f $emp.cnpj, $cont.nfe, $cont.nfce, $cont.compras, $script:ignorados)
      try {
        [void](Chamar-Receptor @{ acao = 'concluir'; contabilidade = $it.contabilidade; cliente = $it.cliente; subpasta = $it.subpasta; cnpj = $emp.cnpj;
                                  ano = $mesDt.Year; mes = $mesDt.Month; arquivo = ((@($it.arquivos) | ForEach-Object { $_.nome }) -join ', ');
                                  tamanho = [long](@($it.arquivos) | Measure-Object -Property tamanho -Sum).Sum; contagens = $cont;
                                  situacao = 'MANUAL - RESUMO GERADO'; maquina = $env:COMPUTERNAME; versao = $VERSAO; mensagem = "XML enviados à mão; sem protocolo: $($script:ignorados)" })
      } catch { }
    } catch {
      $erros++
      Log ("   ERRO: " + $_.Exception.Message)
    }
  }
  # só marca a versão quando deu tempo de passar por todos (senão a próxima execução continua refazendo)
  if ($refazVersao -and ((Get-Date) - $inicio).TotalMinutes -le $LimiteMinutos) { $estM = Ler-Estado; $estM['_manuaisVersao'] = $VERSAO; Gravar-Estado $estM }
  return [int]($erros -gt 0)
}

# ================================================================= SERVIDOR: vigia do MySQL, backup do banco, reinício
# Vigia (tarefa "LC XML Vigia MySQL (CPUSIS)", a cada 5 min): testa se o MySQL responde; se travou, reinicia o serviço.
# Backup (na rodada diária, depois dos XML): mysqldump -> compacta -> criptografa (AES-256) -> Drive em partes.
$ARQ_VIGIA = Join-Path $BASE 'vigia.json'
$ARQ_REINICIANDO = Join-Path $BASE 'reiniciando.flag'
$TAREFA_VIGIA = 'LC XML Vigia MySQL (CPUSIS)'
$EMP0 = $null; if ($CFG.empresas) { $EMP0 = @($CFG.empresas)[0] }

function Mysql-Local {
  $h = ([string]$DB.host).Trim().ToLower()
  return (@('', 'localhost', '127.0.0.1', '::1', '.', ([string]$env:COMPUTERNAME).ToLower()) -contains $h)
}
function Args-Conexao {
  $a = @(('--host=' + $DB.host), ('--port=' + $DB.porta), ('--user=' + $DB.usuario))
  if ($DB.senha) { $a += ('--password=' + $DB.senha) }
  return $a
}
function Juntar-Args($a) { return ($a | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' ' }
function Novo-Processo([string]$exe, $argv) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe; $psi.Arguments = (Juntar-Args $argv)
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  return $psi
}
function Limpar-Erro([string]$e) { return (($e -split "`n" | Where-Object { $_.Trim() -and $_ -notmatch 'Using a password' }) -join ' ').Trim() }

# '' = respondeu; senão, o motivo
function Testar-MySql([int]$limiteSeg = 30) {
  try {
    $p = [System.Diagnostics.Process]::Start((Novo-Processo $DB.exe ((Args-Conexao) + @('--batch', '--skip-column-names', '--connect-timeout=10', ('--database=' + $DB.banco), '-e', 'SELECT 1'))))
  } catch { return 'não consegui rodar o mysql.exe: ' + $_.Exception.Message }
  $o = $p.StandardOutput.ReadToEndAsync(); $e = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($limiteSeg * 1000)) { try { $p.Kill() } catch { }; return "o MySQL não respondeu em $limiteSeg segundos (travado)" }
  $p.WaitForExit()
  if ($p.ExitCode -eq 0 -and $o.Result.Trim() -eq '1') { return '' }
  $m = Limpar-Erro $e.Result; if (-not $m) { $m = 'código ' + $p.ExitCode }
  return $m
}

function Servico-MySql {
  if ($CFG.servicoMysql) { $s = Get-Service -Name $CFG.servicoMysql -ErrorAction SilentlyContinue; if ($s) { return $s.Name } }
  $todos = $null
  try { $todos = @(Get-CimInstance Win32_Service -ErrorAction Stop) } catch { try { $todos = @(Get-WmiObject Win32_Service) } catch { return $null } }
  $cand = @($todos | Where-Object { $_.PathName -match '(?i)mysqld|mariadbd' })
  if ($cand.Count -eq 0) { return $null }
  if ($cand.Count -eq 1) { return $cand[0].Name }
  $pasta = ''; try { $pasta = (Split-Path (Split-Path $DB.exe -Parent) -Parent).ToLower() } catch { }
  $m = @($cand | Where-Object { $pasta -and $_.PathName.ToLower().Contains($pasta) })
  if ($m.Count) { return $m[0].Name }
  $m = @($cand | Where-Object { $_.StartMode -eq 'Auto' })
  if ($m.Count) { return $m[0].Name }
  return $cand[0].Name
}
function Info-Servico([string]$nome) {
  try { return Get-CimInstance Win32_Service -Filter ("Name='" + $nome + "'") -ErrorAction Stop } catch { return Get-WmiObject Win32_Service -Filter ("Name='" + $nome + "'") }
}

# Para (espera até 2 min o MySQL gravar o que tem em memória; se não parar, finaliza o processo), inicia e confere.
function Reiniciar-MySql([string]$motivo) {
  $nome = Servico-MySql
  if (-not $nome) { throw 'não encontrei o serviço do MySQL neste computador' }
  [IO.File]::WriteAllText($ARQ_REINICIANDO, (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
  $t0 = Get-Date; $forcado = $false
  try {
    Log "MySQL: reiniciando o serviço '$nome' ($motivo)"
    $svc = Info-Servico $nome
    if ($svc.State -ne 'Stopped') {
      $pidAnt = [int]$svc.ProcessId
      & sc.exe stop $nome | Out-Null
      $parou = $false
      for ($i = 0; $i -lt 60; $i++) { Start-Sleep -Seconds 2; if ((Info-Servico $nome).State -eq 'Stopped') { $parou = $true; break } }
      if (-not $parou) {
        $forcado = $true
        Log 'MySQL: não parou em 2 minutos - finalizando o processo'
        if ($pidAnt -gt 0) { Stop-Process -Id $pidAnt -Force -ErrorAction SilentlyContinue }
        Get-Process -Name mysqld, mariadbd -ErrorAction SilentlyContinue | Where-Object { $_.Id -eq $pidAnt } | Stop-Process -Force -ErrorAction SilentlyContinue
        for ($i = 0; $i -lt 15; $i++) { Start-Sleep -Seconds 2; if ((Info-Servico $nome).State -eq 'Stopped') { break } }
      }
    }
    & sc.exe start $nome | Out-Null
    $erro = 'não voltou'
    for ($i = 0; $i -lt 36; $i++) { Start-Sleep -Seconds 5; $erro = Testar-MySql 15; if (-not $erro) { break } }
    $seg = [int]((Get-Date) - $t0).TotalSeconds
    if ($erro) { Log "MySQL: NÃO voltou depois de reiniciar ($erro)"; return @{ ok = $false; servico = $nome; segundos = $seg; forcado = $forcado; erro = $erro } }
    Log "MySQL: voltou a responder em $seg s"
    return @{ ok = $true; servico = $nome; segundos = $seg; forcado = $forcado }
  } finally { Remove-Item $ARQ_REINICIANDO -Force -ErrorAction SilentlyContinue }
}

function Ler-Json([string]$arq) {
  $h = @{}
  if (Test-Path $arq) { try { $o = Get-Content $arq -Raw -Encoding UTF8 | ConvertFrom-Json; foreach ($p in $o.PSObject.Properties) { $h[$p.Name] = $p.Value } } catch { } }
  return $h
}
function Gravar-Json([string]$arq, $h) { try { ($h | ConvertTo-Json -Depth 6) | Set-Content -Path $arq -Encoding UTF8 } catch { } }

# avisa o portal; se não conseguir (sem internet), guarda e manda na próxima vez
function Avisar-Evento($st, [string]$tipo, [string]$detalhe, $extra) {
  $ev = @{ tipo = $tipo; detalhe = $detalhe; quando = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') }
  if ($extra) { foreach ($k in $extra.Keys) { $ev[$k] = $extra[$k] } }
  $fila = @(); if ($st.fila) { $fila = @($st.fila) }
  $fila += (New-Object PSObject -Property $ev)
  if ($fila.Count -gt 100) { $fila = $fila[($fila.Count - 100)..($fila.Count - 1)] }
  $st.fila = $fila
}
function Enviar-Eventos($st) {
  if (-not $EMP0) { return }
  $fila = @(); if ($st.fila) { $fila = @($st.fila) }
  if ($fila.Count -eq 0) { return }
  try {
    [void](Chamar-Receptor @{ acao = 'evento'; contabilidade = $EMP0.contabilidade; cliente = $EMP0.cliente; maquina = $env:COMPUTERNAME; versao = $VERSAO; eventos = $fila })
    $st.fila = @(); $st.ultimoSinal = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
  } catch { }
}

function Rodar-Vigia {
  if (-not $DB -or -not $DB.exe -or $CFG.vigia -eq $false) { return }
  $tv = $null
  try { $tv = [System.IO.File]::Open((Join-Path $BASE 'vigia.lock'), 'OpenOrCreate', 'ReadWrite', 'None') } catch { return }
  try {
    # reinício em andamento (pela rodada da noite ou por outro vigia): não atrapalha
    if (Test-Path $ARQ_REINICIANDO) { if (((Get-Date) - (Get-Item $ARQ_REINICIANDO).LastWriteTime).TotalMinutes -lt 10) { return } }
    $st = Ler-Json $ARQ_VIGIA
    $erro = Testar-MySql 30
    if ($erro) { Start-Sleep -Seconds 20; $erro2 = Testar-MySql 30; if (-not $erro2) { $erro = '' } else { $erro = $erro2 } }
    if ($erro) {
      $agora = Get-Date
      $recentes = @(); if ($st.reinicios) { $recentes = @($st.reinicios | Where-Object { ($agora - [datetime]::Parse($_)).TotalMinutes -lt 60 }) }
      if ($erro -match '(?i)access denied|1045|unknown database|1049') {
        # senha/usuário do banco mudou: reiniciar não resolve; avisa uma vez por dia
        Log "VIGIA: o MySQL respondeu, mas recusou o acesso ($erro) - confira o usuário/senha no config.json"
        if (-not $st.avisoAcesso -or ($agora - [datetime]::Parse($st.avisoAcesso)).TotalHours -ge 24) {
          Avisar-Evento $st 'acesso' $erro @{ reiniciou = $false }; $st.avisoAcesso = $agora.ToString('yyyy-MM-dd HH:mm:ss')
        }
      } elseif ($CFG.vigiaReiniciar -eq $false) {
        Log "VIGIA: MySQL sem resposta ($erro) - reinício automático desligado neste servidor"
        Avisar-Evento $st 'travado' $erro @{ reiniciou = $false }
      } elseif (-not (Mysql-Local)) {
        Log "VIGIA: MySQL de outro computador ($($DB.host)) sem resposta: $erro"
        Avisar-Evento $st 'travado' ("banco em outro computador (" + $DB.host + "): " + $erro) @{ reiniciou = $false }
      } elseif ($recentes.Count -ge 3) {
        # 3 reinícios na última hora e continua travando: para de tentar e avisa (problema maior: disco, banco corrompido...)
        Log "VIGIA: MySQL travado de novo ($erro) - já reiniciei 3 vezes na última hora, não vou tentar mais agora"
        if (-not $st.avisoLimite -or ($agora - [datetime]::Parse($st.avisoLimite)).TotalMinutes -ge 60) {
          Avisar-Evento $st 'limite' ('travou 3 vezes em 1 hora e continua: ' + $erro) @{ reiniciou = $false }
          $st.avisoLimite = $agora.ToString('yyyy-MM-dd HH:mm:ss')
        }
      } else {
        Log "VIGIA: MySQL sem resposta: $erro"
        $r = $null
        try { $r = Reiniciar-MySql 'vigia: sem resposta' } catch { $r = @{ ok = $false; erro = $_.Exception.Message; segundos = 0; semServico = $true } }
        $st.reinicios = @($recentes) + @($agora.ToString('yyyy-MM-dd HH:mm:ss'))
        if ($r.ok) { Avisar-Evento $st 'reiniciado' $erro @{ reiniciou = $true; segundos = $r.segundos; forcado = $r.forcado } }
        elseif ($r.semServico) { Avisar-Evento $st 'falhou' ($erro + ' | não reiniciei: ' + $r.erro) @{ reiniciou = $false } }
        else { Avisar-Evento $st 'falhou' ($erro + ' | depois do reinício: ' + $r.erro) @{ reiniciou = $true; segundos = $r.segundos } }
      }
    } elseif (-not $st.ultimoSinal -or ((Get-Date) - [datetime]::Parse($st.ultimoSinal)).TotalHours -ge 6) {
      Avisar-Evento $st 'sinal' 'ok' $null   # sinal de vida a cada 6 h
    }
    Enviar-Eventos $st
    Gravar-Json $ARQ_VIGIA $st
  } finally { $tv.Dispose() }
}

# Cria/atualiza a tarefa do vigia (a cada 5 min, como SYSTEM) e arruma a tarefa principal das instalações antigas.
function Garantir-Tarefas {
  if ($CFG.vigia -eq $false) {   # vigia desligado no config.json: remove a tarefa se existir
    try { $p = Start-Process -FilePath 'schtasks.exe' -ArgumentList ('/Delete /F /TN "' + $TAREFA_VIGIA + '"') -WindowStyle Hidden -Wait -PassThru } catch { }
    return
  }
  if (-not $DB -or -not $DB.exe) { return }
  try {
    $tr = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $PSCommandPath + '" -Vigia'
    $a = '/Create /F /TN "' + $TAREFA_VIGIA + '" /SC MINUTE /MO 5 /RU SYSTEM /RL HIGHEST /TR "' + $tr.Replace('"', '\"') + '"'
    $p = Start-Process -FilePath 'schtasks.exe' -ArgumentList $a -WindowStyle Hidden -Wait -PassThru
    if ($p.ExitCode -ne 0) { Log "aviso: não consegui criar a tarefa do vigia (código $($p.ExitCode))" }
    try {
      $t = Get-ScheduledTask -TaskName $TAREFA_VIGIA -ErrorAction Stop
      $t.Settings.DisallowStartIfOnBatteries = $false; $t.Settings.StopIfGoingOnBatteries = $false
      $t.Settings.ExecutionTimeLimit = 'PT15M'; $t.Settings.MultipleInstances = 'IgnoreNew'
      Set-ScheduledTask -InputObject $t | Out-Null
    } catch { }
  } catch { Log ('aviso: tarefa do vigia: ' + $_.Exception.Message) }
  try {
    $t = Get-ScheduledTask -TaskName 'LC XML Contabilidade (CPUSIS)' -ErrorAction Stop
    if (-not $t.Settings.StartWhenAvailable) { $t.Settings.StartWhenAvailable = $true; Set-ScheduledTask -InputObject $t | Out-Null; Log 'tarefa principal: ligado "executar assim que possível" (computador desligado no horário)' }
  } catch { }
  # desinstalador também remove o vigia
  try {
    $bat = Join-Path $BASE 'DESINSTALAR.bat'
    if ((Test-Path $bat) -and -not ((Get-Content $bat -Raw) -match 'Vigia')) {
      $txt = (Get-Content $bat -Raw) -replace '(schtasks /Delete /TN "LC XML Contabilidade \(CPUSIS\)" /F)', ('$1' + "`r`nschtasks /Delete /TN `"$TAREFA_VIGIA`" /F")
      [IO.File]::WriteAllText($bat, $txt, (New-Object System.Text.UTF8Encoding($false)))
    }
  } catch { }
}

# ---------------------------------------------------------------- backup (formato .lcbk: "LCBK1" + sal(16) + iv(16) + AES-256-CBC(gzip(sql)))
function Chave-Backup([string]$senha, [byte[]]$sal) {
  $kdf = New-Object System.Security.Cryptography.Rfc2898DeriveBytes($senha, $sal, 100000)
  try { return $kdf.GetBytes(32) } finally { $kdf.Dispose() }
}
function Novo-Aes([byte[]]$chave, [byte[]]$iv) {
  $aes = [System.Security.Cryptography.Aes]::Create()
  $aes.Mode = 'CBC'; $aes.Padding = 'PKCS7'; $aes.Key = $chave; $aes.IV = $iv
  return $aes
}
function Exe-Dump {
  $pasta = Split-Path $DB.exe -Parent; $ext = [IO.Path]::GetExtension($DB.exe)
  foreach ($n in @('mysqldump', 'mariadb-dump')) { $c = Join-Path $pasta ($n + $ext); if (Test-Path $c) { return $c } }
  return $null
}
# espaço livre do disco de uma pasta: { letra, gb, pct } (null se não conseguir medir)
function Espaco-Livre([string]$caminho) {
  try {
    $raiz = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($caminho)); $d = New-Object IO.DriveInfo($raiz)
    return @{ letra = $d.Name.TrimEnd('\'); gb = [math]::Round($d.AvailableFreeSpace / 1GB, 1); pct = [math]::Round($d.AvailableFreeSpace * 100.0 / [math]::Max($d.TotalSize, 1), 0) }
  } catch { return $null }
}
function Gerar-Backup([string]$destino, [string]$senha, [switch]$Devagar) {
  if ($SISTEMA -eq 'gestores') {
    # pg_dump faz uma foto consistente sem travar o banco (o Gestores continua funcionando normalmente)
    $dump = Join-Path (Split-Path $PG.exe -Parent) 'pg_dump.exe'
    if (-not (Test-Path $dump)) { throw ('não encontrei o pg_dump.exe na pasta do PostgreSQL (' + (Split-Path $PG.exe -Parent) + ')') }
    $psi = Novo-ProcessoPg $dump @('-h', [string]$PG.host, '-p', [string]$PG.porta, '-U', [string]$PG.usuario, '-d', [string]$PG.banco, '--no-owner', '--no-privileges', '-Fp')
    $psi.RedirectStandardInput = $false; $psi.StandardOutputEncoding = $null
    $p = [System.Diagnostics.Process]::Start($psi)
  } else {
  $dump = Exe-Dump
  if (-not $dump) { throw 'não encontrei o mysqldump.exe na pasta do MySQL (' + (Split-Path $DB.exe -Parent) + ')' }
  $argv = (Args-Conexao) + @('--single-transaction', '--quick', '--routines', '--triggers', '--hex-blob', '--max-allowed-packet=512M', $DB.banco)
  $p = [System.Diagnostics.Process]::Start((Novo-Processo $dump $argv))
  }
  if ($Devagar) { try { $p.PriorityClass = 'BelowNormal' } catch { } }
  $proxConf = [long]256MB
  $err = $p.StandardError.ReadToEndAsync()
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $sal = New-Object byte[] 16; $iv = New-Object byte[] 16; $rng.GetBytes($sal); $rng.GetBytes($iv)
  $aes = Novo-Aes (Chave-Backup $senha $sal) $iv
  $fs = [IO.File]::Open($destino, [IO.FileMode]::Create)
  $cab = [Text.Encoding]::ASCII.GetBytes('LCBK1'); $fs.Write($cab, 0, 5); $fs.Write($sal, 0, 16); $fs.Write($iv, 0, 16)
  $cs = New-Object System.Security.Cryptography.CryptoStream($fs, $aes.CreateEncryptor(), [System.Security.Cryptography.CryptoStreamMode]::Write)
  $gz = New-Object System.IO.Compression.GZipStream($cs, [System.IO.Compression.CompressionMode]::Compress)
  try {
    $buf = New-Object byte[] 1048576; $total = [long]0; $ent = $p.StandardOutput.BaseStream
    while (($n = $ent.Read($buf, 0, $buf.Length)) -gt 0) {
      $gz.Write($buf, 0, $n); $total += $n
      if ($total -ge $proxConf) {   # confere o disco durante o backup: se apertar, para (o servidor do cliente vem primeiro)
        $proxConf = $total + 256MB; $lv = Espaco-Livre $destino
        if ($null -ne $lv -and $lv.gb -lt 3) { try { $p.Kill() } catch { }; throw ('backup interrompido: o disco ' + $lv.letra + ' ficou com menos de 3 GB livres') }
        if ($script:LIMITE_BACKUP -and (Get-Date) -ge $script:LIMITE_BACKUP) { try { $p.Kill() } catch { }; throw 'backup interrompido às 04:45 para não pesar no banco na abertura do cliente (tenta de novo na próxima noite)' }
      }
    }
  } finally { $gz.Dispose(); $cs.Dispose(); $fs.Dispose(); $aes.Dispose() }
  $p.WaitForExit()
  $msg = Limpar-Erro $err.Result
  if ($p.ExitCode -ne 0) { Remove-Item $destino -Force -ErrorAction SilentlyContinue; throw ($(if ($SISTEMA -eq 'gestores') { 'pg_dump' } else { 'mysqldump' }) + ' falhou: ' + $msg) }
  return @{ sql = $total; aviso = $msg }
}
# Abre o backup (senha), descompacta e confere se termina com "Dump completed". -Saida grava o .sql.
function Abrir-Backup([string]$arq, [string]$senha, [string]$Saida) {
  $fs = [IO.File]::OpenRead($arq)
  try {
    $cab = New-Object byte[] 37; if ($fs.Read($cab, 0, 37) -ne 37 -or [Text.Encoding]::ASCII.GetString($cab, 0, 5) -ne 'LCBK1') { throw 'não é um backup LC XML (.lcbk)' }
    $sal = $cab[5..20]; $iv = $cab[21..36]
    $aes = Novo-Aes (Chave-Backup $senha ([byte[]]$sal)) ([byte[]]$iv)
    $cs = New-Object System.Security.Cryptography.CryptoStream($fs, $aes.CreateDecryptor(), [System.Security.Cryptography.CryptoStreamMode]::Read)
    $gz = New-Object System.IO.Compression.GZipStream($cs, [System.IO.Compression.CompressionMode]::Decompress)
    $out = $null; $parcial = $Saida + '.parcial'; if ($Saida) { $out = [IO.File]::Open($parcial, [IO.FileMode]::Create) }
    $buf = New-Object byte[] 1048576; $total = [long]0; $fim = New-Object byte[] 0
    try {
      while (($n = $gz.Read($buf, 0, $buf.Length)) -gt 0) {
        $total += $n
        if ($out) { $out.Write($buf, 0, $n) }
        if ($n -ge 4096) { $fim = $buf[($n - 4096)..($n - 1)] } else { $fim = @($fim) + @($buf[0..($n - 1)]); if ($fim.Count -gt 4096) { $fim = $fim[($fim.Count - 4096)..($fim.Count - 1)] } }
      }
    } catch { if ($out) { $out.Dispose(); $out = $null; Remove-Item $parcial -Force -ErrorAction SilentlyContinue }; throw ('senha errada ou arquivo danificado (' + $_.Exception.Message + ')') }
    finally { if ($out) { $out.Dispose() }; try { $gz.Dispose() } catch { } }
    if ($Saida) { Move-Item $parcial $Saida -Force }
    $txt = [Text.Encoding]::UTF8.GetString([byte[]]$fim)
    return @{ sql = $total; completo = ($txt -match 'Dump completed|PostgreSQL database dump complete') }
  } finally { $fs.Dispose() }
}

# Envia arquivo grande ao Drive em partes de 16 MB (continua de onde parou se a internet cair)
function Posicao-Envio([string]$url, [long]$tam) {
  $req = [System.Net.HttpWebRequest]::Create($url); $req.Method = 'PUT'; $req.AllowAutoRedirect = $false; $req.ContentLength = 0; $req.Timeout = 60000
  $req.Headers.Add('Content-Range', "bytes */$tam")
  try { $resp = $req.GetResponse() } catch [System.Net.WebException] { $resp = $_.Exception.Response; if (-not $resp) { throw } }
  try {
    $cod = [int]$resp.StatusCode
    if ($cod -eq 200 -or $cod -eq 201) { return $tam }
    if ($cod -eq 308) { $rg = $resp.Headers['Range']; if ($rg -match '-(\d+)$') { return [long]$matches[1] + 1 }; return [long]0 }
    throw "Drive respondeu $cod ao consultar o envio"
  } finally { $resp.Close() }
}
function Enviar-Grande([string]$url, [string]$arq) {
  $tam = (Get-Item $arq).Length; $parte = 16MB; $pos = [long]0; $falhas = 0
  if ($CFG.parteEnvioMB) { $parte = [int]([double]$CFG.parteEnvioMB * 1MB) }
  $buf = New-Object byte[] $parte
  $fs = [IO.File]::OpenRead($arq)
  try {
    while ($true) {
      $n = [int][Math]::Min([long]$parte, $tam - $pos)
      try {
        $fs.Position = $pos; $lidos = 0; while ($lidos -lt $n) { $r = $fs.Read($buf, $lidos, $n - $lidos); if ($r -le 0) { break }; $lidos += $r }
        $req = [System.Net.HttpWebRequest]::Create($url); $req.Method = 'PUT'; $req.AllowAutoRedirect = $false
        $req.Timeout = 900000; $req.ReadWriteTimeout = 900000; $req.ContentLength = $n
        $req.Headers.Add('Content-Range', ('bytes {0}-{1}/{2}' -f $pos, ($pos + $n - 1), $tam))
        $rs = $req.GetRequestStream(); $rs.Write($buf, 0, $n); $rs.Close()
        $resp = $null
        try { $resp = $req.GetResponse() } catch [System.Net.WebException] { $resp = $_.Exception.Response; if (-not $resp -or [int]$resp.StatusCode -ne 308) { throw } }
        $cod = [int]$resp.StatusCode; $rg = $resp.Headers['Range']; $resp.Close()
        if ($cod -eq 200 -or $cod -eq 201) { return }
        if ($cod -ne 308) { throw "Drive respondeu $cod" }
        if ($rg -match '-(\d+)$') { $pos = [long]$matches[1] + 1 } else { $pos = 0 }
        $falhas = 0
      } catch {
        $falhas++
        if ($falhas -gt 6) { throw ('envio interrompido: ' + $_.Exception.Message) }
        Log ("   backup: falha no envio (" + $_.Exception.Message + "), tentando continuar em " + (20 * $falhas) + 's')
        Start-Sleep -Seconds (20 * $falhas)
        try { $pos = Posicao-Envio $url $tam; if ($pos -ge $tam) { return } } catch { }
      }
    }
  } finally { $fs.Dispose() }
}

# Rodada da noite: backup (se ligado no portal) e reinício programado (se ligado e estiver de madrugada)
function Rotina-Servidor {
  if (-not $EMP0) { return }
  if (-not ($DB -and $DB.exe) -and -not ($SISTEMA -eq 'gestores' -and $PG -and $PG.exe)) { return }
  $nomeBanco = $(if ($SISTEMA -eq 'gestores') { [string]$PG.banco + ' (PostgreSQL)' } else { $DB.banco })
  $conf = $null
  try { $conf = Chamar-Receptor @{ acao = 'servidor'; contabilidade = $EMP0.contabilidade; cliente = $EMP0.cliente; maquina = $env:COMPUTERNAME; versao = $VERSAO; banco = $nomeBanco; servico = (Servico-Banco) } }
  catch { Log ('servidor: portal sem as opções de backup ainda (' + $_.Exception.Message + ')'); return }
  $agora = Get-Date; $h = $agora.Hour
  # janela segura (sem movimento): 21:30 às 04:30. Há clientes que abrem às 05:00 e fecham às 21:00 (horário local do servidor).
  $minDia = $h * 60 + $agora.Minute
  $madrugada = ($minDia -lt 270)                          # 00:00 a 04:29 (reinício programado)
  $janelaBackup = ($minDia -ge 1290 -or $minDia -lt 270)   # 21:30 a 04:29 (backup automático)
  $comercial = -not $janelaBackup
  $estado = Ler-Estado
  $bk = $estado['_backup']
  $ultimo = $null; if ($bk -and $bk.ultimoOk) { try { $ultimo = [datetime]::Parse($bk.ultimoOk) } catch { } }

  if ($conf.backup -and $conf.senhaBackup) {
    $fazer = $true
    if ($ultimo -and $ultimo.Date -eq $agora.Date) { $fazer = $false; Log 'backup: já feito hoje' }
    elseif (-not $janelaBackup) { $fazer = $false; Log 'backup: fora da janela da noite (21:30 às 04:30) - fica para esta noite' }   # nunca pesa no banco durante o expediente
    if ($fazer) {
      $nome = (Nome-Seguro $EMP0.cliente) + '_' + $agora.ToString('yyyy-MM-dd_HHmm') + '.lcbk'
      $arq = Join-Path $PASTA_TMP $nome
      $t0 = Get-Date
      try {
        Log "backup: gerando $nome"
        $livre = Espaco-Livre $PASTA_TMP
        if ($null -ne $livre -and ($livre.gb -lt 5 -or $livre.pct -lt 10)) { throw ('pouco espaço no disco ' + $livre.letra + ' (' + $livre.gb + ' GB livres, ' + $livre.pct + '%) - backup não feito para não lotar o disco do servidor') }
        $script:LIMITE_BACKUP = $null
        if (-not $ForcarBackup) { $lim = $agora.Date.AddMinutes(285); if ($agora -ge $lim) { $lim = $lim.AddDays(1) }; $script:LIMITE_BACKUP = $lim }   # passa das 04:45: para
        $g = Gerar-Backup $arq $conf.senhaBackup -Devagar
        $tam = (Get-Item $arq).Length
        $teste = Abrir-Backup $arq $conf.senhaBackup
        if (-not $teste.completo -or $teste.sql -ne $g.sql) { throw 'o backup gerado não passou na conferência (arquivo incompleto)' }
        Log ('backup: {0:N1} MB de banco -> {1:N1} MB compactado e conferido em {2:N0}s; enviando' -f ($g.sql / 1MB), ($tam / 1MB), ((Get-Date) - $t0).TotalSeconds)
        $tent = 0
        while ($true) {
          $tent++
          try {
            $ini = Chamar-Receptor @{ acao = 'iniciar'; destino = 'backup'; contabilidade = $EMP0.contabilidade; cliente = $EMP0.cliente; ano = $agora.Year; mes = $agora.Month; arquivo = $nome; tamanho = $tam; tipo = 'application/octet-stream' }
            Enviar-Grande $ini.uploadUrl $arq
            break
          } catch { if ($tent -ge 2) { throw }; Log ('backup: ' + $_.Exception.Message + ' - recomeçando o envio') }
        }
        $seg = [int]((Get-Date) - $t0).TotalSeconds
        $fim = Chamar-Receptor @{ acao = 'backupConcluir'; contabilidade = $EMP0.contabilidade; cliente = $EMP0.cliente; arquivo = $nome; tamanho = $tam; tamanhoSql = $g.sql; segundos = $seg; situacao = 'OK'; maquina = $env:COMPUTERNAME; versao = $VERSAO; mensagem = $g.aviso }
        Log ("backup: enviado ao Drive em $seg s" + $(if ($fim.apagados) { " ($($fim.apagados) backup(s) antigo(s) apagados)" } else { '' }))
        $estado['_backup'] = @{ ultimoOk = $agora.ToString('yyyy-MM-dd HH:mm:ss'); tamanho = $tam }
        Gravar-Estado $estado
      } catch {
        $m = $_.Exception.Message
        Log "backup: ERRO: $m"
        try { [void](Chamar-Receptor @{ acao = 'backupConcluir'; contabilidade = $EMP0.contabilidade; cliente = $EMP0.cliente; arquivo = $nome; situacao = 'ERRO'; maquina = $env:COMPUTERNAME; versao = $VERSAO; mensagem = $m }) } catch { }
      } finally { Remove-Item $arq -Force -ErrorAction SilentlyContinue }
    }
  }

  # reinício programado: só de madrugada, nunca em horário de movimento
  if ($conf.reiniciar) {
    if ($SISTEMA -eq 'gestores') { Log 'reinício programado: não se aplica ao Gestores (PostgreSQL)' }
    elseif (-not $madrugada) { Log 'reinício programado: pulado (fora da janela 00:00 às 04:30; o vigia continua cuidando)' }
    elseif (-not (Mysql-Local)) { Log 'reinício programado: pulado (MySQL em outro computador)' }
    else {
      $st = Ler-Json $ARQ_VIGIA
      try {
        $r = Reiniciar-MySql 'reinício programado da madrugada'
        if ($r.ok) { Avisar-Evento $st 'programado' 'reinício programado da madrugada' @{ reiniciou = $true; segundos = $r.segundos; forcado = $r.forcado } }
        else { Avisar-Evento $st 'falhou' ('reinício programado: ' + $r.erro) @{ reiniciou = $true; segundos = $r.segundos } }
      } catch { Avisar-Evento $st 'falhou' ('reinício programado: ' + $_.Exception.Message) @{ reiniciou = $false } }
      Enviar-Eventos $st; Gravar-Json $ARQ_VIGIA $st
    }
  }
}

# ================================================================= EXECUÇÃO
if ($Vigia) { try { Rodar-Vigia } catch { Log ("VIGIA: ERRO: " + $_.Exception.Message) }; exit 0 }
if ($Restaurar) {
  if (-not $SenhaBackup) { $SenhaBackup = Read-Host 'Senha dos backups' }
  $sql = [IO.Path]::ChangeExtension($Restaurar, '.sql')
  Log "Abrindo $Restaurar -> $sql"
  $r = Abrir-Backup $Restaurar $SenhaBackup -Saida $sql
  if (-not $r.completo) { Log 'ATENÇÃO: o backup está incompleto (não termina com "Dump completed").' }
  Log ('.sql gerado: {0:N1} MB' -f ($r.sql / 1MB))
  if ($Importar) {
    Log "Importando no banco '$Importar' (criado se não existir)..."
    $psi = Novo-Processo $DB.exe ((Args-Conexao) + @('-e', ('CREATE DATABASE IF NOT EXISTS `' + $Importar + '`')))
    $p = [System.Diagnostics.Process]::Start($psi); $p.WaitForExit()
    $psi = Novo-Processo $DB.exe ((Args-Conexao) + @('--max-allowed-packet=512M', $Importar)); $psi.RedirectStandardInput = $true
    $p = [System.Diagnostics.Process]::Start($psi); $e = $p.StandardError.ReadToEndAsync()
    $fs = [IO.File]::OpenRead($sql); try { $fs.CopyTo($p.StandardInput.BaseStream) } catch { } finally { $fs.Dispose(); try { $p.StandardInput.Close() } catch { } }
    $p.WaitForExit()
    if ($p.ExitCode -ne 0) { Log ('ERRO na importação: ' + (Limpar-Erro $e.Result)); exit 1 }
    Log 'Importação concluída.'
  }
  exit 0
}

$trava = $null
try { $trava = [System.IO.File]::Open((Join-Path $BASE 'em_execucao.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
catch { Log 'Já existe um envio em andamento. Saindo.'; exit 0 }

$codigoSaida = 0
$script:AVISO_UP = $null   # 2.3: motivo de uma atualização que não deu certo (vai na mensagem do envio)
try {
  Log "===== LC XML v$VERSAO - início ($env:COMPUTERNAME) ====="

  # atualização automática: o receptor entrega a versão nova do agente (arquivo agente/lcxml.ps1 no Drive)
  if (-not $SoGerar -and -not $SemAtualizar) {
    try {
      $up = Chamar-Receptor @{ acao = 'agente'; versao = $VERSAO; maquina = $env:COMPUTERNAME }
      if ($up.versao -and $up.conteudo -and ([version]$up.versao -gt [version]$VERSAO)) {
        $novo = $UTF8.GetString([Convert]::FromBase64String($up.conteudo)).TrimStart([char]0xFEFF)
        $tk = $null; $er = $null
        [void][System.Management.Automation.Language.Parser]::ParseInput($novo, [ref]$tk, [ref]$er)
        if ($SISTEMA -eq 'gestores' -and $novo -notmatch 'function Invoke-Pg') { Log ('Atualização ' + $up.versao + ' ainda não tem suporte ao Gestores - mantida a versão atual.'); $script:AVISO_UP = 'atualização ' + $up.versao + ' sem suporte ao Gestores' }
        elseif ($er.Count -eq 0 -and $novo -match '\$VERSAO = ') {
          Copy-Item $PSCommandPath ($PSCommandPath + '.anterior') -Force
          [IO.File]::WriteAllText($PSCommandPath, $novo, (New-Object System.Text.UTF8Encoding($true)))
          Log ("Agente atualizado: $VERSAO -> " + $up.versao + '. Reiniciando com a versão nova.')
          $trava.Dispose(); $trava = $null
          $prm = @{ SemAtualizar = $true }
          if ($Meses) { $prm.Meses = $Meses }
          if ($Manuais) { $prm.Manuais = $true }
          if ($Tudo) { $prm.Tudo = $true }
          if ($Config) { $prm.Config = $Config }
          try { & $PSCommandPath @prm; exit $LASTEXITCODE }
          catch {
            # versão nova bloqueada (ex.: antivírus) ou com erro ao abrir: volta a anterior e roda com ela
            $msgNova = $_.Exception.Message
            if (Test-Path ($PSCommandPath + '.anterior')) { Copy-Item ($PSCommandPath + '.anterior') $PSCommandPath -Force }
            Log ('A versão ' + $up.versao + ' não abriu neste servidor (' + $msgNova + ') - voltei para a ' + $VERSAO + '.')
            $script:AVISO_UP = 'atualização ' + $up.versao + ' não abriu: ' + $msgNova
            $prm.SemAtualizar = $true
            & $PSCommandPath @prm
            exit $LASTEXITCODE
          }
        } else { Log 'Atualização recebida com erro - mantida a versão atual.'; $script:AVISO_UP = 'atualização ' + $up.versao + ' recebida com erro (' + $er.Count + ' erro(s) de leitura)' }
      }
    } catch { Log ('(verificação de atualização falhou: ' + $_.Exception.Message + ')'); $script:AVISO_UP = 'atualização falhou: ' + $_.Exception.Message }
  }
  if ($Agendado) { $esp = Get-Random -Minimum 0 -Maximum 1200; Log "Aguardando $esp s (espalha os envios dos clientes)"; Start-Sleep -Seconds $esp }

  if ($Manuais) {
    $codigoSaida = Processar-Manuais
  } else {
  # meses a processar
  $lista = @(); $retroAno = $null
  if ($Meses) {
    foreach ($m in ($Meses -join ',').Split(',')) { if ($m.Trim()) { $lista += [datetime]::ParseExact($m.Trim() + '-01', 'yyyy-MM-dd', $null) } }
  } else {
    $hoje = Get-Date
    $atual = Get-Date -Year $hoje.Year -Month $hoje.Month -Day 1 -Hour 0 -Minute 0 -Second 0
    if ($hoje.Day -le $DIAS_MES_ANTERIOR) { $lista += $atual.AddMonths(-1) }
    $lista += $atual
    # Gestores, uma vez por ano: completa os meses anteriores do ano que têm XML no banco (retroativo automático).
    # Meses já enviados e sem mudança são pulados (mesmo hash), então nada é enviado em duplicidade.
    if ($SISTEMA -eq 'gestores' -and -not $SoGerar) {
      $est0 = Ler-Estado
      if ([string]$est0['_retroAno'] -ne [string]$hoje.Year) {
        $ids = (@($CFG.empresas) | ForEach-Object { [int]$_.id }) -join ','
        $iniAno = ('{0}-01-01' -f $hoje.Year); $fimRetro = $lista[0].ToString('yyyy-MM-dd')
        $mesesXml = @{}; $retroOk = $true
        foreach ($q in @(
            "SELECT DISTINCT to_char(data,'YYYY-MM') FROM mv_venda WHERE cod_filial IN ($ids) AND modelo='65' AND xml IS NOT NULL AND data_ex IS NULL AND data>='$iniAno' AND data<'$fimRetro'",
            "SELECT DISTINCT to_char(data_emissao,'YYYY-MM') FROM mv_nota_saida WHERE cod_filial IN ($ids) AND modelo='55' AND arquivo_xml IS NOT NULL AND data_ex IS NULL AND data_emissao>='$iniAno' AND data_emissao<'$fimRetro'",
            "SELECT DISTINCT to_char(COALESCE(data_lancamento,data_emissao),'YYYY-MM') FROM mv_nota_entrada WHERE cod_filial IN ($ids) AND modelo='55' AND arquivo IS NOT NULL AND data_ex IS NULL AND COALESCE(data_lancamento,data_emissao)>='$iniAno' AND COALESCE(data_lancamento,data_emissao)<'$fimRetro'")) {
          try { [void](Invoke-Pg $q { param($l) if ($l.Trim() -match '^\d{4}-\d{2}$') { $mesesXml[$l.Trim()] = 1 } }) }
          catch { $retroOk = $false; Log ('retroativo do ano: não consegui ler os meses (' + $_.Exception.Message + ')') }
        }
        $extras = @($mesesXml.Keys | Sort-Object | ForEach-Object { [datetime]::ParseExact($_ + '-01', 'yyyy-MM-dd', $null) })
        if ($extras.Count) { $lista = @($extras) + @($lista) }
        if ($retroOk) { $retroAno = $hoje.Year }
        Log ('Retroativo do ano ' + $hoje.Year + ': ' + $extras.Count + ' mês(es) anteriores com XML' + $(if ($extras.Count) { ' (' + (($extras | ForEach-Object { $_.ToString('MM/yyyy') }) -join ', ') + ')' } else { '' }))
      }
    }
  }

  $estado = Ler-Estado
  foreach ($emp in $CFG.empresas) {
    foreach ($mes in $lista) {
      $rotulo = '{0} {1}' -f $emp.cliente, $mes.ToString('MM/yyyy')
      $chaveEstado = '{0}|{1}|{2}' -f $(if ($SISTEMA -eq 'gestores') { 'pg:' + $PG.banco } else { $DB.banco }), $emp.id, $mes.ToString('yyyy-MM')
      $nomeArquivo = (Nome-Seguro $emp.cliente) + ' - XML ' + $mes.ToString('MM.yyyy') + '.zip'
      $zipPath = Join-Path $PASTA_TMP $nomeArquivo
      $info = $null
      try {
        Log "-> $rotulo"
        $t0 = Get-Date
        $info = Gerar-Zip $emp $mes $zipPath
        $tam = (Get-Item $zipPath).Length
        $c = $info.contagens
        Log ('   {0} XML no ZIP ({1:N0} KB) em {2:N0}s | NF-e {3}, NFC-e {4}, compras {5}, CT-e {6}, MDF-e {7}, eventos {8}, inutil. {9} | ignorados (sem protocolo) {10}' -f `
             $info.arquivos, ($tam / 1KB), ((Get-Date) - $t0).TotalSeconds, $c.nfe, $c.nfce, $c.compras, $c.cte, $c.mdfe,
             ($c.nfeEventos + $c.nfceEventos + $c.cteEventos + $c.mdfeEventos + $c.cce), $c.inut, $info.ignorados)
        foreach ($a in $info.avisos) { Log "   aviso: $a" }

        $jsonPath = $zipPath -replace '\.zip$', '.json'
        if ($info.resumo) { [IO.File]::WriteAllText($jsonPath, ($info.resumo | ConvertTo-Json -Depth 8 -Compress), $UTF8) }

        if ($SoGerar) {
          if (-not (Test-Path $PASTA_SAIDA)) { New-Item -ItemType Directory -Path $PASTA_SAIDA | Out-Null }
          Move-Item $zipPath (Join-Path $PASTA_SAIDA $nomeArquivo) -Force
          if (Test-Path $jsonPath) { Move-Item $jsonPath (Join-Path $PASTA_SAIDA ([IO.Path]::GetFileName($jsonPath))) -Force }
          Log "   gerado em saida\$nomeArquivo (não enviado)"
          continue
        }

        $anterior = $estado[$chaveEstado]
        $situacao = 'ENVIADO'
        if ($info.arquivos -eq 0) {
          $situacao = 'SEM MOVIMENTO'
          Log '   nenhum XML neste mês ainda - nada a enviar'
        } else {
          $zipIgual = ($anterior -and $anterior.hash -eq $info.hash)
          $resumoIgual = ($zipIgual -and $anterior.resumoV -eq $VERSAO)
          if ($zipIgual) {
            $situacao = 'SEM ALTERAÇÃO'
            Log '   sem alteração desde o último envio'
          } else {
            $r = Enviar-Arquivo $emp $mes $zipPath $nomeArquivo
            Log ('   enviado ao Drive' + $(if ($r.substituindo) { ' (substituiu o ZIP anterior)' } else { ' (arquivo novo)' }))
          }
          $resumoV = $null; if ($anterior) { $resumoV = $anterior.resumoV }
          if (-not $resumoIgual -and (Test-Path $jsonPath)) {
            try { [void](Enviar-Arquivo $emp $mes $jsonPath ($mes.ToString('yyyy-MM') + '.json') 'portal'); $resumoV = $VERSAO; Log '   resumo fiscal enviado ao portal' }
            catch { Log ('   aviso: resumo do portal não enviado: ' + $_.Exception.Message) }
          }
          $estado[$chaveEstado] = @{ hash = $info.hash; enviadoEm = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'); tamanho = $tam; resumoV = $resumoV }
          Gravar-Estado $estado
        }
        [void](Chamar-Receptor @{ acao = 'concluir'; contabilidade = $emp.contabilidade; cliente = $emp.cliente; subpasta = $emp.subpasta; cnpj = $emp.cnpj;
                                  ano = $mes.Year; mes = $mes.Month; arquivo = $nomeArquivo; tamanho = $tam; contagens = $info.contagens;
                                  situacao = $situacao; maquina = $env:COMPUTERNAME; versao = $VERSAO;
                                  mensagem = (($info.avisos + @("ignorados sem protocolo: $($info.ignorados)") + @($script:AVISO_UP | Where-Object { $_ })) -join '; ') })
      } catch {
        $codigoSaida = 1
        $msg = $_.Exception.Message
        Log "   ERRO: $msg"
        if (-not $SoGerar) {
          try {
            [void](Chamar-Receptor @{ acao = 'concluir'; contabilidade = $emp.contabilidade; cliente = $emp.cliente; subpasta = $emp.subpasta; cnpj = $emp.cnpj;
                                      ano = $mes.Year; mes = $mes.Month; arquivo = $nomeArquivo; situacao = 'ERRO'; maquina = $env:COMPUTERNAME;
                                      versao = $VERSAO; mensagem = (@($msg, $script:AVISO_UP) | Where-Object { $_ }) -join '; ' })
          } catch { Log ('   (não consegui avisar o painel: ' + $_.Exception.Message + ')') }
        }
      } finally {
        if (Test-Path $zipPath) { Remove-Item $zipPath -Force -ErrorAction SilentlyContinue }
        $jp = $zipPath -replace '\.zip$', '.json'; if (Test-Path $jp) { Remove-Item $jp -Force -ErrorAction SilentlyContinue }
      }
    }
  }
  if ($retroAno) { $estado['_retroAno'] = [string]$retroAno; Gravar-Estado $estado; Log ('Retroativo do ano ' + $retroAno + ' concluído.') }
  if (-not $SoGerar -and -not $Meses) {
    Garantir-Tarefas
    try { Rotina-Servidor } catch { Log ('servidor: ERRO: ' + $_.Exception.Message) }
  }
  }
  Get-ChildItem $PASTA_LOG -Filter '*.log' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-120) } | Remove-Item -Force -ErrorAction SilentlyContinue
  Log '===== fim ====='
}
finally { if ($trava) { $trava.Dispose() } }
exit $codigoSaida
