/**
 * LC XML -> GOOGLE DRIVE  |  RECEPTOR (Google Apps Script)
 * CPUSIS - versão 1.8  (receptor + PORTAL FAROL CONTÁBIL + atualização automática pelo GitHub)
 *
 * Código oficial: https://github.com/CPUSISCODE/farol.contabil
 * No Apps Script fica só o CARREGADOR (receptor/Carregador.gs), que baixa este arquivo do GitHub e o executa.
 * As senhas NÃO ficam no código: ficam em Configurações do projeto > Propriedades do script (SENHA e SENHA_BACKUP).
 *
 * Recebe os ZIPs mensais enviados pelos agentes instalados nos servidores
 * dos clientes e grava no Google Drive em:
 *     PASTA RAIZ / CONTABILIDADE / CLIENTE / ANO / MÊS / Cliente_AAAA-MM.zip
 * O ZIP do mês é SEMPRE O MESMO ARQUIVO: a cada envio ele é substituído.
 * Também mantém a planilha "LC XML - Painel de envios" com a situação de cada cliente,
 * e serve o PORTAL DOS CONTADORES (o mesmo endereço /exec aberto no navegador).
 * Precisa do arquivo HTML "Portal" no mesmo projeto.
 *
 * >>> AJUSTE SÓ O BLOCO "CONFIG" ABAIXO <<<
 */
var CONFIG = {
  // Senha combinada com os agentes (a mesma que vai no arquivo conexao.txt). Troque!
  SENHA: 'TROQUE-ESTA-SENHA',

  // ID da pasta do Drive onde ficam as pastas das contabilidades.
  // (abra a pasta no navegador: o ID é o final do endereço, depois de /folders/)
  // Deixe '' para o receptor criar a pasta "XML CONTABILIDADES" no seu Meu Drive.
  PASTA_RAIZ_ID: '1VXlk5Ungt-qFSFNbqCiwPrZtk1ksbK2V',   // ARQUIVOS FISCAIS CONTABEIS

  // Nome da pasta do ano e do mês. Use {AAAA}=2026  {MM}=11  {NOME}=NOVEMBRO
  // Padrão do escritório: CLIENTE / XML 2026 / 11.2026
  FORMATO_ANO: 'XML {AAAA}',
  FORMATO_MES: '{MM}.{AAAA}',

  // BACKUPS DOS BANCOS DOS CLIENTES (só a CPUSIS vê).
  // Senha que protege os arquivos de backup. GUARDE EM LUGAR SEGURO: sem ela não dá para abrir nenhum backup.
  // Se trocar, os backups antigos continuam abrindo só com a senha antiga.
  SENHA_BACKUP: 'TROQUE-ESTA-SENHA-DE-BACKUP',
  // Pasta dos backups. '' = cria "_BACKUPS_CPUSIS" no seu Meu Drive (fora das pastas das contabilidades).
  PASTA_BACKUP_ID: '',
  // Quantos guardar de cada cliente: últimos N dias, N semanas e N meses (o resto é apagado sozinho)
  GUARDAR_DIAS: 7, GUARDAR_SEMANAS: 4, GUARDAR_MESES: 6
};

var VERSAO = '1.11';
var PASTA_PORTAL = '_PORTAL_DADOS';   // resumos fiscais (JSON) e versão do agente
var MESES = ['JANEIRO','FEVEREIRO','MARCO','ABRIL','MAIO','JUNHO','JULHO','AGOSTO','SETEMBRO','OUTUBRO','NOVEMBRO','DEZEMBRO'];
var MESES_TXT = ['JANEIRO','FEVEREIRO','MARÇO','ABRIL','MAIO','JUNHO','JULHO','AGOSTO','SETEMBRO','OUTUBRO','NOVEMBRO','DEZEMBRO'];

/* ---------- Entradas do App da Web ---------- */

// Abrir o endereço no navegador = Portal dos Contadores
// Se existir o arquivo _PORTAL_DADOS/portal/Portal.html no Drive, ele é usado (atualiza o portal sem mexer aqui).
// Cores, nomes e logo vêm da aba "Aparência" da planilha do painel.
function doGet() {
  marcarPublicada_();
  var html = null;
  try { html = portalHtml_(); } catch (e) { }
  if (!html) html = HtmlService.createHtmlOutputFromFile('Portal').getContent();
  var ap = aparencia_();
  html = html.replace('/*__APARENCIA__*/', 'var APARENCIA = ' + JSON.stringify(ap).replace(/</g, '\\u003c') + ';');
  return HtmlService.createHtmlOutput(html)
    .setTitle(ap.nome || 'Portal Contábil')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ---------- Aparência do portal (aba "Aparência" da planilha) ---------- */
// Portal.html do Drive, guardado em cache (só relê quando o arquivo muda)
function portalHtml_() {
  var props = PropertiesService.getScriptProperties(), cache = CacheService.getScriptCache();
  var id = props.getProperty('PORTAL_HTML_ID'), f = null;
  if (id) { try { f = DriveApp.getFileById(id); if (f.isTrashed()) f = null; } catch (e) { f = null; } }
  if (!f) {
    var pp = existente_(existente_(pastaRaiz_(), PASTA_PORTAL), 'portal');
    if (!pp) return null;
    var it = pp.getFilesByName('Portal.html');
    while (it.hasNext()) { var x = it.next(); if (!x.isTrashed()) { f = x; break; } }
    if (!f) return null;
    props.setProperty('PORTAL_HTML_ID', f.getId());
  }
  var chave = 'html_' + f.getId() + '_' + f.getLastUpdated().getTime();
  var html = getGrande_(cache, chave);
  if (html) return html;
  html = f.getBlob().getDataAsString('UTF-8');
  putGrande_(cache, chave, html, 21600);
  return html;
}
// CacheService aceita até 100 KB por item: divide em pedaços
function putGrande_(cache, chave, txt, seg) {
  try {
    var n = Math.ceil(txt.length / 90000), o = {};
    for (var i = 0; i < n; i++) o[chave + '_' + i] = txt.slice(i * 90000, (i + 1) * 90000);
    o[chave] = String(n);
    cache.putAll(o, seg);
  } catch (e) { }
}
function getGrande_(cache, chave) {
  var n = Number(cache.get(chave) || 0); if (!n) return null;
  var ks = []; for (var i = 0; i < n; i++) ks.push(chave + '_' + i);
  var g = cache.getAll(ks), s = '';
  for (var j = 0; j < n; j++) { if (g[ks[j]] == null) return null; s += g[ks[j]]; }
  return s;
}

var APARENCIA_PADRAO = [
  ['Nome do portal', 'Farol Contábil', 'Aparece no topo, na tela de login e na aba do navegador'],
  ['Subtítulo', 'XML e resumos fiscais dos clientes · CPUSIS', 'Linha menor abaixo do nome'],
  ['Sigla', 'CP', 'Até 3 letras no quadradinho (usado quando não houver logo)'],
  ['Logo', '', 'Link da imagem OU link/ID de uma imagem no Google Drive (PNG/JPG até 300 KB). Em branco = usa a sigla'],
  ['Cor principal', '#0f6b55', 'Botões, abas e destaques. Formato #RRGGBB'],
  ['Cor principal (modo escuro)', '#4cc29c', 'A mesma cor, mais clara, para quem usa o celular/computador no modo escuro'],
  ['Cor de fundo', '#f3f5f4', 'Fundo das telas no modo claro'],
  ['Mensagem na tela de login', 'Acesso exclusivo para os escritórios de contabilidade parceiros.', 'Texto curto abaixo do botão Entrar (em branco = nenhum)'],
  ['Contato de suporte', 'CPUSIS - Cem Por Um Sistemas', 'Aparece no rodapé (telefone, WhatsApp, e-mail...)']
];
function abaAparencia_(ss) {
  var a = ss.getSheetByName('Aparência');
  if (a) return a;
  a = ss.insertSheet('Aparência');
  a.getRange(1, 1, 1, 3).setValues([['Item', 'Valor (pode mudar)', 'Explicação']]).setFontWeight('bold').setBackground('#0f6b55').setFontColor('#ffffff');
  a.getRange(2, 1, APARENCIA_PADRAO.length, 3).setValues(APARENCIA_PADRAO);
  a.setFrozenRows(1); a.setColumnWidth(1, 200); a.setColumnWidth(2, 340); a.setColumnWidth(3, 520);
  return a;
}
function aparencia_() {
  var cache = CacheService.getScriptCache();
  var c = cache.get('aparencia'); if (c) return JSON.parse(c);
  var v = {}; APARENCIA_PADRAO.forEach(function (l) { v[l[0]] = l[1]; });
  try { abaAparencia_(planilha_()).getDataRange().getValues().slice(1).forEach(function (l) { if (l[0]) v[String(l[0]).trim()] = String(l[1] == null ? '' : l[1]).trim(); }); } catch (e) { }
  var cor = function (x, padrao) { return /^#[0-9a-f]{6}$/i.test(x) ? x : padrao; };
  var ap = {
    nome: v['Nome do portal'] || 'Portal Contábil', subtitulo: v['Subtítulo'], sigla: String(v['Sigla'] || '').slice(0, 3),
    cor: cor(v['Cor principal'], '#0f6b55'), corEscura: cor(v['Cor principal (modo escuro)'], '#4cc29c'), fundo: cor(v['Cor de fundo'], '#f3f5f4'),
    login: v['Mensagem na tela de login'], suporte: v['Contato de suporte'], logo: logo_(v['Logo'])
  };
  try { cache.put('aparencia', JSON.stringify(ap), 120); } catch (e) { }
  return ap;
}
function logo_(x) {
  if (!x) return '';
  var id = (String(x).match(/[-\w]{25,}/) || [])[0];
  if (id && !/^https?:\/\/(?!drive\.google|docs\.google)/i.test(x)) {
    try { var b = DriveApp.getFileById(id).getBlob(); if (b.getBytes().length <= 300 * 1024) return 'data:' + b.getContentType() + ';base64,' + Utilities.base64Encode(b.getBytes()); } catch (e) { }
    return '';
  }
  return /^https:\/\//i.test(x) ? x : '';
}

function doPost(e) {
  marcarPublicada_();
  var r;
  try {
    var req = JSON.parse(e.postData.contents);
    if (req.acao === 'portal') {
      r = portalApi_(req);
    } else if (req.senha !== segredo_('SENHA')) {
      r = { ok: false, erro: 'Senha inválida. Confira o arquivo conexao.txt do agente.' };
    } else if (!redirecionarUnificado_(req)) {   // cliente unificado: envio sem subpasta vai para a que ficou (sempre segue)
      r = { ok: false };
    } else if (req.acao === 'ping') {
      r = { ok: true, versao: VERSAO, raiz: pastaRaiz_().getName() };
    } else if (req.acao === 'iniciar') {
      r = iniciarEnvio_(req);
    } else if (req.acao === 'concluir') {
      r = registrar_(req);
    } else if (req.acao === 'agente') {
      r = versaoAgente_(req);
    } else if (req.acao === 'manuais') {
      r = listarMeses_(req);
    } else if (req.acao === 'baixarParte') {
      r = baixarParte_(req);
    } else if (req.acao === 'servidor') {
      r = servidor_(req);
    } else if (req.acao === 'backupConcluir') {
      r = backupConcluir_(req);
    } else if (req.acao === 'evento') {
      r = eventos_(req);
    } else if (req.acao === 'estrutura') {
      r = { ok: true, contabilidades: estrutura_() };
    } else {
      r = { ok: false, erro: 'Ação desconhecida: ' + req.acao };
    }
  } catch (err) {
    r = { ok: false, erro: String(err && err.message ? err.message : err) };
  }
  return ContentService.createTextOutput(JSON.stringify(r)).setMimeType(ContentService.MimeType.JSON);
}

// A versão que está realmente publicada no endereço /exec (o gatilho roda o código do editor, que pode ser mais novo)
function marcarPublicada_() {
  try { var p = PropertiesService.getScriptProperties(); if (p.getProperty('VERSAO_PUBLICADA') !== VERSAO) p.setProperty('VERSAO_PUBLICADA', VERSAO); } catch (e) { }
}

// Versões como "1.5" viram data na planilha em português (01/05): grava como texto e conserta ao ler
function txt_(v) { return v == null || v === '' ? '' : "'" + String(v); }
function verTxt_(v) { if (v instanceof Date) return v.getDate() + '.' + (v.getMonth() + 1); return String(v == null ? '' : v); }

/* Senhas: ficam nas Propriedades do script (não vão para o GitHub). O CONFIG só serve na primeira instalação. */
function segredo_(nome) {
  var v = PropertiesService.getScriptProperties().getProperty(nome);
  if (v) return v;
  var c = String(CONFIG[nome] || '');
  return /^TROQUE/.test(c) ? '' : c;
}

/* ---------- Portal pelo GitHub (Farol Contábil): as telas chamam as mesmas funções via POST ---------- */
var PORTAL_API = ['portalAparencia', 'portalLogin', 'portalSair', 'portalDados', 'portalResumo', 'portalArquivo', 'portalParte',
  'portalIndicadores', 'portalIndicadoresLote', 'portalAdmin', 'portalSalvarUsuario', 'portalExcluirUsuario', 'portalCriarContabilidade',
  'portalCriarCliente', 'portalSalvarRegime', 'portalServidores', 'portalSalvarServidor', 'portalUnificar', 'portalFinCarteira', 'portalFinSalvarBpo', 'portalFinLoginEmpresa', 'portalFinCliente', 'portalFinImportar',
  'portalFinCategorizar', 'portalFinSolicitar', 'portalFinJustificar', 'portalFinAnexo', 'portalFinRemoverRegra', 'portalFinPlano'];
function portalApi_(req) {
  var fn = String(req.fn || '');
  if (PORTAL_API.indexOf(fn) < 0) return { ok: false, erro: 'Função não permitida: ' + fn };
  var mapa = { portalAparencia: portalAparencia, portalLogin: portalLogin, portalSair: portalSair, portalDados: portalDados, portalResumo: portalResumo,
    portalArquivo: portalArquivo, portalParte: portalParte, portalIndicadores: portalIndicadores, portalIndicadoresLote: portalIndicadoresLote,
    portalAdmin: portalAdmin, portalSalvarUsuario: portalSalvarUsuario, portalExcluirUsuario: portalExcluirUsuario,
    portalCriarContabilidade: portalCriarContabilidade, portalCriarCliente: portalCriarCliente, portalSalvarRegime: portalSalvarRegime,
    portalServidores: portalServidores, portalSalvarServidor: portalSalvarServidor, portalUnificar: portalUnificar,
    portalFinCarteira: portalFinCarteira, portalFinSalvarBpo: portalFinSalvarBpo, portalFinLoginEmpresa: portalFinLoginEmpresa, portalFinCliente: portalFinCliente,
    portalFinImportar: portalFinImportar, portalFinCategorizar: portalFinCategorizar, portalFinSolicitar: portalFinSolicitar, portalFinJustificar: portalFinJustificar,
    portalFinAnexo: portalFinAnexo, portalFinRemoverRegra: portalFinRemoverRegra, portalFinPlano: portalFinPlano };
  var f = mapa[fn]; if (typeof f !== 'function') return { ok: false, erro: 'Função não encontrada: ' + fn };
  try { return { ok: true, r: f.apply(null, Array.isArray(req.args) ? req.args : []) }; }
  catch (e) { return { ok: false, erro: String(e && e.message ? e.message : e) }; }
}
function portalAparencia() { return aparencia_(); }

/* ---------- Envio do arquivo ---------- */

// Prepara a pasta e devolve um endereço de upload direto ao Google Drive
// (upload "resumable": o agente manda o ZIP direto pro Drive, sem limite de tamanho do script).
function iniciarEnvio_(req) {
  obrigatorios_(req, ['contabilidade', 'cliente', 'ano', 'mes', 'arquivo', 'tamanho']);
  var pasta, existente = null;
  var tipo = req.tipo || 'application/zip';
  var lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try {
    if (req.destino === 'backup') {   // backup do banco: _BACKUPS_CPUSIS / CONTABILIDADE / CLIENTE / arquivo.lcbk
      pasta = filha_(filha_(pastaBackup_(), req.contabilidade), req.cliente);
    } else if (req.destino === 'portal') {   // resumo fiscal do mês: _PORTAL_DADOS / CONTABILIDADE / CLIENTE [/ SUBPASTA] / AAAA-MM.json
      pasta = filha_(filha_(filha_(pastaRaiz_(), PASTA_PORTAL), req.contabilidade), req.cliente);
      if (req.subpasta) pasta = filha_(pasta, req.subpasta);
    } else {
      pasta = pastaDoMes_(req.contabilidade, req.cliente, Number(req.ano), Number(req.mes), req.subpasta);
    }
    var it = pasta.getFilesByName(req.arquivo);
    while (it.hasNext()) { var f = it.next(); if (!f.isTrashed()) { existente = f; break; } }
  } finally { lock.releaseLock(); }

  var url, metodo, corpo;
  if (existente) {          // substitui o conteúdo mantendo o mesmo arquivo (mesmo link)
    url = 'https://www.googleapis.com/upload/drive/v3/files/' + existente.getId() + '?uploadType=resumable&supportsAllDrives=true';
    metodo = 'patch';
    corpo = '{}';
  } else {                  // cria o arquivo novo na pasta do mês
    url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true';
    metodo = 'post';
    corpo = JSON.stringify({ name: req.arquivo, parents: [pasta.getId()], mimeType: tipo });
  }
  var resp = UrlFetchApp.fetch(url, {
    method: metodo,
    contentType: 'application/json; charset=UTF-8',
    payload: corpo,
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      'X-Upload-Content-Type': tipo,
      'X-Upload-Content-Length': String(req.tamanho)
    },
    muteHttpExceptions: true
  });
  var cab = resp.getHeaders();
  var local = cab['Location'] || cab['location'];
  if (resp.getResponseCode() !== 200 || !local) {
    throw new Error('O Drive recusou o envio (' + resp.getResponseCode() + '): ' + resp.getContentText().slice(0, 300));
  }
  return { ok: true, uploadUrl: local, substituindo: !!existente, pasta: pasta.getUrl() };
}

/* ---------- Pastas ---------- */

function pastaRaiz_() {
  if (CONFIG.PASTA_RAIZ_ID) return DriveApp.getFolderById(CONFIG.PASTA_RAIZ_ID);
  return filha_(DriveApp.getRootFolder(), 'XML CONTABILIDADES');
}

// subpasta (opcional) fica entre o ano e o mês, ex.: XML 2026 / MATRIZ / 11.2026
function pastaDoMes_(contabilidade, cliente, ano, mes, subpasta) {
  var p = filha_(pastaRaiz_(), contabilidade);
  p = filha_(p, cliente);
  p = filha_(p, formatar_(CONFIG.FORMATO_ANO, ano, mes));
  if (subpasta) p = filha_(p, subpasta);
  return filha_(p, formatar_(CONFIG.FORMATO_MES, ano, mes));
}

function formatar_(fmt, ano, mes) {
  return fmt.replace(/\{AAAA\}/g, String(ano))
            .replace(/\{MM\}/g, ('0' + mes).slice(-2))
            .replace(/\{NOME\}/g, MESES_TXT[mes - 1]);
}

// Acha a subpasta pelo nome (sem diferenciar maiúsculas/acentos/espaços extras); cria se não existir.
function filha_(pai, nome) {
  nome = String(nome).replace(/[\\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
  var alvo = normal_(nome);
  var it = pai.getFolders();
  while (it.hasNext()) {
    var f = it.next();
    if (!f.isTrashed() && normal_(f.getName()) === alvo) return f;
  }
  return pai.createFolder(nome);
}

function normal_(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
}

/* ---------- Painel (planilha) ---------- */

var CAB_PAINEL = ['Contabilidade', 'Cliente', 'CNPJ', 'Mês', 'Último contato', 'Situação',
  'NF-e emitidas', 'NF-e eventos', 'NFC-e', 'NFC-e eventos', 'Compras (XML importados)', 'MD-e baixadas',
  'CT-e', 'CT-e eventos', 'MDF-e', 'MDF-e eventos', 'CC-e', 'Inutilizações',
  'Arquivo', 'Tamanho (KB)', 'Máquina', 'Versão agente', 'Mensagem', 'Dias sem contato'];
var CHAVES = ['nfe', 'nfeEventos', 'nfce', 'nfceEventos', 'compras', 'mde', 'cte', 'cteEventos', 'mdfe', 'mdfeEventos', 'cce', 'inut'];

function planilha_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('PLANILHA_ID');
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) { /* recria */ } }
  var ss = SpreadsheetApp.create('LC XML - Painel de envios');
  try { DriveApp.getFileById(ss.getId()).moveTo(pastaRaiz_()); } catch (e) { }
  var p = ss.getSheets()[0]; p.setName('Painel');
  p.getRange(1, 1, 1, CAB_PAINEL.length).setValues([CAB_PAINEL]).setFontWeight('bold').setBackground('#0f6b55').setFontColor('#ffffff');
  p.setFrozenRows(1);
  var h = ss.insertSheet('Histórico');
  h.getRange(1, 1, 1, 9).setValues([['Data/hora', 'Contabilidade', 'Cliente', 'Mês', 'Situação', 'Arquivo', 'Tamanho (KB)', 'Máquina', 'Mensagem']])
    .setFontWeight('bold').setBackground('#0f6b55').setFontColor('#ffffff');
  h.setFrozenRows(1);
  props.setProperty('PLANILHA_ID', ss.getId());
  abaUsuarios_(ss);
  return ss;
}

// Garante o cabeçalho na linha 1 da aba Painel (se alguém apagou, recoloca sem perder os dados)
function abaPainel_(ss) {
  var p = ss.getSheetByName('Painel');
  if (!p) { p = ss.insertSheet('Painel', 0); }
  if (String(p.getRange(1, 1).getValue()).trim() !== 'Contabilidade') {
    if (p.getLastRow() > 0) p.insertRowBefore(1);
    p.getRange(1, 1, 1, CAB_PAINEL.length).setValues([CAB_PAINEL]).setFontWeight('bold').setBackground('#0f6b55').setFontColor('#ffffff');
    p.setFrozenRows(1);
  }
  return p;
}

function registrar_(req) {
  obrigatorios_(req, ['contabilidade', 'cliente', 'ano', 'mes']);
  var lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try {
    var ss = planilha_();
    var p = abaPainel_(ss);
    var mesTxt = req.ano + '-' + ('0' + req.mes).slice(-2);
    var agora = new Date();
    var c = req.contagens || {};
    var cliente = req.cliente + (req.subpasta ? ' / ' + req.subpasta : '');
    var linha = [req.contabilidade, cliente, req.cnpj || '', mesTxt, agora, req.situacao || '']
      .concat(CHAVES.map(function (k) { return Number(c[k] || 0); }))
      .concat([req.arquivo || '', req.tamanho ? Math.round(req.tamanho / 1024) : '', req.maquina || '', txt_(req.versao), String(req.mensagem || '').slice(0, 400)]);

    var dados = p.getDataRange().getValues();
    var lin = -1;
    for (var i = 1; i < dados.length; i++) {
      if (normal_(dados[i][0]) === normal_(req.contabilidade) && normal_(dados[i][1]) === normal_(cliente) && mesTxt_(dados[i][3]) === mesTxt) { lin = i + 1; break; }
    }
    if (lin < 0) lin = Math.max(p.getLastRow(), 1) + 1;   // linha nova no fim
    p.getRange(lin, 4).setNumberFormat('@');                        // mês como texto ANTES de gravar
    p.getRange(lin, 1, 1, linha.length).setValues([linha]);
    p.getRange(lin, 5).setNumberFormat('dd/MM/yyyy HH:mm');
    p.getRange(lin, CAB_PAINEL.length).setFormula('=INT(NOW()-E' + lin + ')');
    var cor = /ERRO/.test(String(req.situacao)) ? '#fbe9e7' : '#ffffff';
    p.getRange(lin, 1, 1, CAB_PAINEL.length).setBackground(cor);

    if (req.situacao !== 'SEM ALTERAÇÃO' && req.situacao !== 'SEM MOVIMENTO') ss.getSheetByName('Histórico').appendRow([agora, req.contabilidade, cliente, "'" + mesTxt, req.situacao || '',
      req.arquivo || '', req.tamanho ? Math.round(req.tamanho / 1024) : '', req.maquina || '', String(req.mensagem || '').slice(0, 400)]);
  } finally { lock.releaseLock(); }
  PropertiesService.getScriptProperties().setProperty('DADOS_V', String(Date.now()));
  return { ok: true, painel: planilha_().getUrl() };
}

/* ---------- utilidades ---------- */

function obrigatorios_(req, campos) {
  campos.forEach(function (c) { if (req[c] === undefined || req[c] === null || req[c] === '') throw new Error('Campo obrigatório ausente: ' + c); });
}

// Rode esta função UMA VEZ pelo editor (botão Executar) para autorizar o acesso ao Drive
// e criar a pasta raiz e a planilha do painel.
function TESTAR_E_AUTORIZAR() {
  var raiz = pastaRaiz_();
  var ss = planilha_();
  abaUsuarios_(ss);
  abaAparencia_(ss);
  abaRegimes_(ss);
  abaPainel_(ss);
  abaAcessos_(ss);
  abaServidores_(ss);
  abaEventos_(ss);
  Logger.log('Backups: ' + pastaBackup_().getUrl());
  filha_(filha_(raiz, PASTA_PORTAL), 'agente');
  filha_(filha_(raiz, PASTA_PORTAL), 'portal');
  CacheService.getScriptCache().put('teste', '1', 10);
  Logger.log('Portal: abra o endereço do App da Web (termina em /exec) no navegador. Cadastre os contadores na aba "Usuários" da planilha.');
  ScriptApp.getOAuthToken();
  UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/about?fields=user', { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } });
  Logger.log('Pasta raiz: ' + raiz.getName() + '  ' + raiz.getUrl());
  Logger.log('Painel: ' + ss.getUrl());
  Logger.log('Exemplo de pasta do mês: ' + formatar_(CONFIG.FORMATO_ANO, 2026, 11) + ' / ' + formatar_(CONFIG.FORMATO_MES, 2026, 11));
}

/* ======================================================================
   ATUALIZAÇÃO AUTOMÁTICA DO AGENTE
   Coloque a versão nova do lcxml.ps1 em: ARQUIVOS FISCAIS CONTABEIS / _PORTAL_DADOS / agente / lcxml.ps1
   Na próxima execução cada agente baixa sozinho, se a versão do arquivo for maior que a dele.
   ====================================================================== */
function versaoAgente_(req) {
  var pasta = existente_(existente_(pastaRaiz_(), PASTA_PORTAL), 'agente');
  if (!pasta) return { ok: true };
  var it = pasta.getFilesByName('lcxml.ps1'), arq = null;
  while (it.hasNext()) { var f = it.next(); if (!f.isTrashed()) { arq = f; break; } }
  if (!arq) return { ok: true };
  var bytes = arq.getBlob().getBytes();
  var texto = Utilities.newBlob(bytes).getDataAsString('UTF-8');
  var m = texto.match(/\$VERSAO\s*=\s*'([\d.]+)'/);
  if (!m) return { ok: true };
  if (!versaoMaior_(m[1], String(req.versao || '0'))) return { ok: true, versao: m[1] };
  return { ok: true, versao: m[1], conteudo: Utilities.base64Encode(bytes) };
}
function versaoMaior_(a, b) {
  var x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (var i = 0; i < Math.max(x.length, y.length); i++) { var d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0; }
  return false;
}

// Acha subpasta pelo nome SEM criar (para consultas do portal)
function existente_(pai, nome) {
  if (!pai) return null;
  var alvo = normal_(String(nome).replace(/[\\\/:*?"<>|]/g, '-'));
  var it = pai.getFolders();
  while (it.hasNext()) { var f = it.next(); if (!f.isTrashed() && normal_(f.getName()) === alvo) return f; }
  return null;
}

/* ======================================================================
   PORTAL DOS CONTADORES
   Logins na aba "Usuários" da planilha do painel:
     Login | Nome | Contabilidades | Senha nova | (hash) | Ativo | Último acesso
   - Contabilidades: nomes separados por vírgula, exatamente como as pastas (ou * para todas).
   - Para criar/trocar senha: digite em "Senha nova". No primeiro login ela é criptografada e apagada.
   ====================================================================== */
var CAB_USU = ['Login', 'Nome', 'Contabilidades (separe por vírgula; * = todas)', 'Senha nova (digite aqui)', 'Senha criptografada (não mexer)', 'Ativo (S/N)', 'Último acesso', 'Empresa (login do BPO: CONTABILIDADE | CLIENTE)'];

function abaUsuarios_(ss) {
  var a = ss.getSheetByName('Usuários');
  if (a) return a;
  a = ss.insertSheet('Usuários');
  a.getRange(1, 1, 1, CAB_USU.length).setValues([CAB_USU]).setFontWeight('bold').setBackground('#0f6b55').setFontColor('#ffffff');
  a.setFrozenRows(1);
  a.getRange(2, 1, 1, 6).setValues([['admin', 'CPUSIS (administrador)', '*', 'troque-esta-senha', '', 'S']]);
  a.setColumnWidth(3, 320); a.setColumnWidth(5, 160);
  return a;
}

function hashSenha_(sal, senha) {
  var h = sal + ':' + senha;
  for (var i = 0; i < 300; i++) {
    h = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + ':' + sal, Utilities.Charset.UTF_8)
      .map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
  }
  return h;
}

function portalLogin(login, senha) {
  login = String(login || '').trim().toLowerCase();
  if (!login || !senha) return { ok: false, erro: 'Informe login e senha.' };
  var cache = CacheService.getScriptCache();
  var falhas = Number(cache.get('f_' + login) || 0);
  if (falhas >= 8) return { ok: false, erro: 'Muitas tentativas. Aguarde 15 minutos.' };
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var aba = abaUsuarios_(planilha_());
    var dados = aba.getDataRange().getValues();
    for (var i = 1; i < dados.length; i++) {
      if (String(dados[i][0]).trim().toLowerCase() !== login) continue;
      var lin = i + 1;
      if (String(dados[i][5]).trim().toUpperCase() === 'N') return { ok: false, erro: 'Acesso desativado. Fale com a CPUSIS.' };
      var guardado = String(dados[i][4] || '');
      if (String(dados[i][3] || '') !== '') {                       // senha nova digitada na planilha
        var sal = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
        guardado = sal + '$' + hashSenha_(sal, String(dados[i][3]));
        aba.getRange(lin, 4, 1, 2).setValues([['', guardado]]);
      }
      var partes = guardado.split('$');
      if (partes.length !== 2 || hashSenha_(partes[0], String(senha)) !== partes[1]) break;
      aba.getRange(lin, 7).setValue(new Date());
      cache.remove('f_' + login);
      var sessao = { login: login, nome: String(dados[i][1] || login), contabs: String(dados[i][2] || '').split(/[,;\n]/).map(function (s) { return s.trim(); }).filter(String) };
      var emp = String(dados[i][7] || '').split('|');   // login de empresa (BPO): só vê o financeiro dela
      if (emp.length === 2 && emp[0].trim() && emp[1].trim()) { sessao.empresa = { contabilidade: emp[0].trim(), cliente: emp[1].trim() }; sessao.contabs = []; }
      var token = Utilities.getUuid() + Utilities.getUuid();
      cache.put('s_' + token, JSON.stringify(sessao), 21600);
      logAcesso_(login, 'login', '');
      return { ok: true, token: token, nome: sessao.nome, admin: sessao.contabs.indexOf('*') >= 0, empresa: sessao.empresa || null };
    }
  } finally { lock.releaseLock(); }
  cache.put('f_' + login, String(falhas + 1), 900);
  return { ok: false, erro: 'Login ou senha incorretos.' };
}

function sessao_(token) {
  var s = token && CacheService.getScriptCache().get('s_' + token);
  if (!s) throw new Error('SESSAO_EXPIRADA');
  CacheService.getScriptCache().put('s_' + token, s, 21600);
  return JSON.parse(s);
}
function podeVer_(sessao, contab) {
  if (sessao.contabs.indexOf('*') >= 0) return true;
  var n = normal_(contab);
  return sessao.contabs.some(function (c) { return normal_(c) === n; });
}

function portalSair(token) { if (token) CacheService.getScriptCache().remove('s_' + token); return true; }

// Lista: contabilidades > clientes (unidades) > meses com resumo, + situação do painel
// Árvore de _PORTAL_DADOS (contabilidade > cliente [> subpasta] > AAAA-MM.json) lida com poucas chamadas à API do Drive
function versaoDados_() { return PropertiesService.getScriptProperties().getProperty('DADOS_V') || '0'; }
function arvorePortal_() {
  var cache = CacheService.getScriptCache(), chave = 'arv_' + versaoDados_() + '_' + versaoCfg_();
  var g = getGrande_(cache, chave); if (g) return JSON.parse(g);
  var props = PropertiesService.getScriptProperties(), pid = props.getProperty('PORTAL_DADOS_ID');
  if (!pid) { var b = existente_(pastaRaiz_(), PASTA_PORTAL); if (!b) return []; pid = b.getId(); props.setProperty('PORTAL_DADOS_ID', pid); }
  // 2 consultas no Drive inteiro (pastas e .json) e a árvore é montada aqui, sem URL gigante
  var PASTA = "mimeType='application/vnd.google-apps.folder'";
  var pastas = driveLista_(PASTA + ' and trashed=false', 'id,name,parents');
  var filhos = {};
  pastas.forEach(function (f) { (f.parents || []).forEach(function (p) { (filhos[p] = filhos[p] || []).push(f); }); });
  var contabs = (filhos[pid] || []).filter(function (c) { return ['agente', 'portal', 'cache', 'receptor'].indexOf(c.name) < 0 && c.name.charAt(0) !== '_'; });
  var cli = {}, sub = {};
  contabs.forEach(function (c) {
    (filhos[c.id] || []).forEach(function (k) {
      cli[k.id] = { contab: c.name, nome: k.name };
      (filhos[k.id] || []).forEach(function (s) { sub[s.id] = { cli: k.id, nome: s.name }; });
    });
  });
  var jsons = driveLista_("mimeType!='application/vnd.google-apps.folder' and name contains '.json' and trashed=false", 'id,name,parents,modifiedTime')
    .filter(function (f) { var p = (f.parents || [])[0]; return cli[p] || sub[p]; });
  var und = {};
  jsons.forEach(function (f) {
    var m = f.name.match(/^(\d{4}-\d{2})\.json$/); if (!m) return;
    var p = (f.parents || [])[0], u = und[p];
    if (!u) {
      if (cli[p]) u = { contabilidade: cli[p].contab, cliente: cli[p].nome, subpasta: '', pid: p, arqs: {} };
      else if (sub[p] && cli[sub[p].cli]) u = { contabilidade: cli[sub[p].cli].contab, cliente: cli[sub[p].cli].nome, subpasta: sub[p].nome, pid: p, arqs: {} };
      else return;
      und[p] = u;
    }
    u.arqs[m[1]] = { id: f.id, mod: Date.parse(f.modifiedTime) };
  });
  var lista = Object.keys(und).map(function (k) { var u = und[k]; u.meses = Object.keys(u.arqs).sort().reverse(); return u; });
  lista.sort(function (a, b) { return (a.contabilidade + a.cliente + a.subpasta).localeCompare(b.contabilidade + b.cliente + b.subpasta); });
  putGrande_(cache, chave, JSON.stringify(lista), 1800);
  return lista;
}

// Lista: contabilidades > clientes (unidades) > meses com resumo, + situação do painel
function portalDados(token) {
  var s = sessao_(token);
  if (s.empresa) return { nome: s.nome, empresa: s.empresa, unidades: [], painel: {}, regimes: {}, versao: VERSAO, admin: false };
  var cache = CacheService.getScriptCache();
  var chave = 'lista16_' + versaoDados_() + '_' + versaoCfg_() + '_' + Utilities.base64EncodeWebSafe(s.contabs.join('|')).slice(0, 200);
  var guardado = getGrande_(cache, chave);
  if (guardado) return JSON.parse(guardado);
  var unidades = arvorePortal_().filter(function (u) { return podeVer_(s, u.contabilidade); })
    .map(function (u) { return { contabilidade: u.contabilidade, cliente: u.cliente, subpasta: u.subpasta, meses: u.meses, pid: u.pid }; });
  // situação de envio (planilha do painel)
  var painel = {};
  try {
    var dados = abaPainel_(planilha_()).getDataRange().getValues();
    for (var i = 1; i < dados.length; i++) {
      if (!podeVer_(s, dados[i][0])) continue;
      var mesP = mesTxt_(dados[i][3]), chP = normal_(dados[i][0]) + '|' + normal_(dados[i][1]) + '|' + mesP;
      var ucP = dados[i][4] instanceof Date ? dados[i][4].toISOString() : '';
      if (painel[chP] && painel[chP].ultimoContato > ucP) continue;   // linha repetida: fica a do contato mais recente
      painel[chP] = {
        ultimoContato: ucP, situacao: String(dados[i][5] || ''), mensagem: String(dados[i][22] || ''),
        contabilidade: String(dados[i][0]), cliente: String(dados[i][1]), mes: mesP, maquina: String(dados[i][20] || ''), versao: verTxt_(dados[i][21])
      };
    }
  } catch (e) { }
  // regime informado à mão (aba "Regimes"), tem prioridade sobre o identificado pelos XML
  var regimes = {};
  try {
    var rg = abaRegimes_(planilha_()).getDataRange().getValues();
    for (var j = 1; j < rg.length; j++) {
      var reg = regimeTexto_(rg[j][2]);
      if (reg && podeVer_(s, rg[j][0])) regimes[normal_(rg[j][0]) + '|' + normal_(rg[j][1])] = reg;
    }
  } catch (e) { }
  var r = { nome: s.nome, unidades: unidades, painel: painel, regimes: regimes, versao: VERSAO, admin: s.contabs.indexOf('*') >= 0 };
  putGrande_(cache, chave, JSON.stringify(r), 600);
  return r;
}
function mesesDe_(pasta) {
  var out = [], it = pasta.getFiles();
  while (it.hasNext()) { var f = it.next(); var m = f.getName().match(/^(\d{4}-\d{2})\.json$/); if (m && !f.isTrashed()) out.push(m[1]); }
  return out.sort().reverse();
}
function pastaUnidade_(contab, cliente, subpasta) {
  var p = existente_(existente_(existente_(pastaRaiz_(), PASTA_PORTAL), contab), cliente);
  if (p && subpasta) p = existente_(p, subpasta);
  return p;
}

function portalResumo(token, contab, cliente, subpasta, mes) {
  var s = sessao_(token);
  if (!podeVer_(s, contab)) throw new Error('Sem permissão para esta contabilidade.');
  var p = pastaUnidade_(contab, cliente, subpasta);
  if (!p) throw new Error('Cliente não encontrado.');
  var it = p.getFilesByName(mes + '.json');
  while (it.hasNext()) { var f = it.next(); if (!f.isTrashed()) return f.getBlob().getDataAsString('UTF-8'); }
  throw new Error('Resumo do mês não encontrado.');
}

// ZIP do mês: localiza e devolve as informações para baixar em partes
var PARTE = 5 * 1024 * 1024;
function portalArquivo(token, contab, cliente, subpasta, mes) {
  var s = sessao_(token);
  logAcesso_(s.login, 'download', contab + ' / ' + cliente + (subpasta ? ' / ' + subpasta : '') + ' / ' + mes);
  if (!podeVer_(s, contab)) throw new Error('Sem permissão para esta contabilidade.');
  var ano = Number(mes.slice(0, 4)), m = Number(mes.slice(5, 7));
  var pAno = existente_(existente_(existente_(pastaRaiz_(), contab), cliente), formatar_(CONFIG.FORMATO_ANO, ano, m));
  var p = pAno;
  if (p && subpasta) p = existente_(p, subpasta);
  p = existente_(p, formatar_(CONFIG.FORMATO_MES, ano, m));
  if (!p && subpasta) p = existente_(pAno, formatar_(CONFIG.FORMATO_MES, ano, m));   // mês solto no ano (cliente com uma subpasta só)
  if (!p) throw new Error('Pasta do mês não encontrada no Drive.');
  var it = p.getFiles(), arq = null;
  var outros = null;
  while (it.hasNext()) {
    var f = it.next(); if (f.isTrashed() || !/\.zip$/i.test(f.getName())) continue;
    if (/ - XML \d{2}\.\d{4}\.zip$/i.test(f.getName())) { if (!arq || f.getLastUpdated() > arq.getLastUpdated()) arq = f; }   // ZIP do agente
    else if (!outros || f.getSize() > outros.getSize()) outros = f;                                                            // ZIP enviado à mão
  }
  if (!arq) arq = outros;
  if (!arq) throw new Error('ZIP do mês não encontrado.');
  var tam = arq.getSize();
  return { id: arq.getId(), nome: arq.getName(), tamanho: tam, partes: Math.max(1, Math.ceil(tam / PARTE)), atualizado: arq.getLastUpdated().toISOString() };
}
function portalParte(token, id, parte) {
  var s = sessao_(token);
  var arq = DriveApp.getFileById(id);
  // confere que o arquivo está dentro de uma contabilidade permitida
  var pai = arq.getParents(), ok = false, raizId = pastaRaiz_().getId();
  var atual = pai.hasNext() ? pai.next() : null, nivel = 0;
  while (atual && nivel < 8) {
    var pp = atual.getParents(); var acima = pp.hasNext() ? pp.next() : null;
    if (acima && acima.getId() === raizId) { ok = podeVer_(s, atual.getName()); break; }
    atual = acima; nivel++;
  }
  if (!ok) throw new Error('Sem permissão para este arquivo.');
  var bytes = arq.getBlob().getBytes();
  var ini = parte * PARTE, fim = Math.min(bytes.length, ini + PARTE);
  return Utilities.base64Encode(bytes.slice(ini, fim));
}


/* ======================================================================
   PAINEL GERAL DO PORTAL (todas as empresas juntas)
   Indicadores de cada cliente no mês, tirados do resumo (AAAA-MM.json).
   Guardados em cache por arquivo+data de alteração; a cada chamada processa
   o que der em ~25 s e avisa se faltou (o portal chama de novo).
   ====================================================================== */
var CAB_REG = ['Contabilidade', 'Cliente (como aparece no portal; filial: "CLIENTE / FILIAL")', 'Regime (SIMPLES, MEI, PRESUMIDO ou REAL)', 'Observação'];
function abaRegimes_(ss) {
  var a = ss.getSheetByName('Regimes');
  if (a) return a;
  a = ss.insertSheet('Regimes');
  a.getRange(1, 1, 1, CAB_REG.length).setValues([CAB_REG]).setFontWeight('bold').setBackground('#0f6b55').setFontColor('#ffffff');
  a.setFrozenRows(1); a.setColumnWidth(1, 200); a.setColumnWidth(2, 380); a.setColumnWidth(3, 260); a.setColumnWidth(4, 300);
  a.getRange(2, 4).setValue('Preencha só quando o portal identificar errado ou não conseguir identificar.');
  return a;
}
function regimeTexto_(v) {
  var s = normal_(v || '');
  if (!s) return '';
  if (/MEI/.test(s)) return 'MEI';
  if (/SIMPLES|^SN$/.test(s)) return 'SN';
  if (/PRESUMIDO/.test(s)) return 'PRESUMIDO';
  if (/REAL/.test(s)) return 'REAL';
  if (/NORMAL/.test(s)) return 'NORMAL';
  return '';
}

var CSOSN_ = { '101': 1, '102': 1, '103': 1, '201': 1, '202': 1, '203': 1, '300': 1, '400': 1, '500': 1, '900': 1 };
var CFOP_VENDA_ = /^[567](10[1-9]|11\d|12[0-5]|40[1-5]|50[12])$/;
function indicadores_(r) {
  var arred = function (v) { return Math.round((Number(v) || 0) * 100) / 100; };
  var tot = r.totais || {}, trib = r.tributacao || [];
  var o = { cnpj: r.cnpj || '', geradoEm: r.geradoEm || '', agente: r.agente || '',
    vendas: 0, saidas: 0, icms: 0, st: 0, ipi: 0, pis: 0, cofins: 0, ibs: 0, cbs: 0,
    compras: (tot.Compras || {}).valor || 0, comprasQtd: (tot.Compras || {}).qtd || 0, comprasST: (tot.Compras || {}).vST || 0,
    nfeQtd: (tot.NFe || {}).qtd || 0, nfeValor: (tot.NFe || {}).valor || 0, nfceQtd: (tot.NFCe || {}).qtd || 0, nfceValor: (tot.NFCe || {}).valor || 0,
    cancQtd: (r.canceladas || []).length, cancValor: 0, devVenda: 0, devVendaQtd: 0, devCompra: 0, devCompraQtd: 0,
    falhas: 0, inut: (r.inutilizacoes || []).length, cteQtd: (r.cte || {}).qtd || 0, cteValor: (r.cte || {}).valor || 0, mdfe: r.mdfe || 0 };
  var vSn = 0, vCst = 0;
  trib.forEach(function (x) {
    if (x.es !== 'S' || x.origem === 'Compras') return;
    o.saidas += x.valor || 0; o.icms += x.vICMS || 0; o.st += x.vST || 0; o.ipi += x.vIPI || 0; o.pis += x.vPIS || 0; o.cofins += x.vCOFINS || 0; o.ibs += x.vIBS || 0; o.cbs += x.vCBS || 0;
    if (CFOP_VENDA_.test(String(x.cfop))) o.vendas += x.valor || 0;
    var c = String(x.cst || '');
    if (CSOSN_[c]) vSn += x.valor || 0; else if (/^\d{2}$/.test(c)) vCst += x.valor || 0;
  });
  (r.canceladas || []).forEach(function (c) { o.cancValor += c.valor || 0; });
  (r.devolucoes || []).forEach(function (d) { if (/^Devolu..o de venda/.test(d.tipo)) { o.devVenda += d.valor || 0; o.devVendaQtd++; } else { o.devCompra += d.valor || 0; o.devCompraQtd++; } });
  (r.falhasNumeracao || []).forEach(function (f) { o.falhas += f.quantidade || 0; });
  // regime: 1) CRT do emitente (agente 1.3+)  2) CST x CSOSN das saídas  3) alíquota efetiva de PIS (presumido x real)
  var reg = '', fonte = '';
  var crt = String(r.crt || '');
  if (crt === '1' || crt === '2') { reg = 'SN'; fonte = 'CRT ' + crt; }
  else if (crt === '4') { reg = 'MEI'; fonte = 'CRT 4'; }
  else if (crt === '3') { reg = 'NORMAL'; fonte = 'CRT 3'; }
  else if (vSn > vCst) { reg = 'SN'; fonte = 'CSOSN nas saídas'; }
  else if (vCst > 0) { reg = 'NORMAL'; fonte = 'CST nas saídas'; }
  if (reg === 'NORMAL') {
    var bPis = 0, vPis = 0;
    (r.pisCofins || []).forEach(function (x) { if (x.origem !== 'Compras' && (x.cstPis === '01' || x.cstPis === '02')) { bPis += x.valor || 0; vPis += x.vPIS || 0; } });
    o.pisEfetivo = bPis ? Math.round(10000 * vPis / bPis) / 100 : null;
    if (bPis > 0 && o.pisEfetivo >= 1.0) { reg = 'REAL'; fonte += ' + PIS ' + o.pisEfetivo + '%'; }
    else if (bPis > 0 && o.pisEfetivo > 0.3) { reg = 'PRESUMIDO'; fonte += ' + PIS ' + o.pisEfetivo + '%'; }
  }
  o.regime = reg; o.regimeFonte = fonte;
  // segregação no DAS (monofásico PIS/COFINS e ICMS ST nas saídas) e CEST faltando em produto com ST
  var ST_ = { '10': 1, '30': 1, '60': 1, '70': 1, '201': 1, '202': 1, '203': 1, '500': 1 };
  o.monofasico = 0; o.stSaidas = 0;
  (r.pisCofins || []).forEach(function (x) { if (x.origem !== 'Compras' && x.cstPis === '04') o.monofasico += x.valor || 0; });
  trib.forEach(function (x) { if (x.es === 'S' && x.origem !== 'Compras' && ST_[String(x.cst)] && CFOP_VENDA_.test(String(x.cfop))) o.stSaidas += x.valor || 0; });
  var semCest = {};
  (r.ncm || []).forEach(function (x) { if (x.origem !== 'Compras' && ST_[String(x.cst)] && !x.cest) semCest[x.ncm] = 1; });
  o.ncmSemCest = Object.keys(semCest).length;
  // pendências do sistema (agente 1.5+): em digitação, rejeitadas, contingência, sem XML
  o.comPendencias = !!r.comPendencias;
  o.pendencias = (r.pendencias || []).slice(0, 40);
  o.pendQtd = (r.pendencias || []).length;
  o.semXml = 0;
  (r.porDia || []).forEach(function (d) { o.semXml += Math.max(0, (d.sisNfe || 0) - (d.sisNfeXml || 0)) + Math.max(0, (d.sisNfce || 0) - (d.sisNfceXml || 0)); });
  o.falhasLista = (r.falhasNumeracao || []).slice(0, 10);
  o.monofasico = arred(o.monofasico); o.stSaidas = arred(o.stSaidas);
  ['vendas', 'saidas', 'icms', 'st', 'ipi', 'pis', 'cofins', 'ibs', 'cbs', 'compras', 'comprasST', 'cancValor', 'devVenda', 'devCompra', 'nfeValor', 'nfceValor', 'cteValor'].forEach(function (k) { o[k] = arred(o[k]); });
  return o;
}

function portalIndicadores(token, mes) { return portalIndicadoresLote(token, [mes])[mes]; }

// Indicadores de vários meses numa chamada só. Guardados em cache (6 h) e num arquivo por mês
// em _PORTAL_DADOS/cache, para não recalcular quando o cache expira.
function pastaCache_() {
  var props = PropertiesService.getScriptProperties(), id = props.getProperty('CACHE_ID');
  if (id) { try { var f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) { } }
  var p = filha_(filha_(pastaRaiz_(), PASTA_PORTAL), 'cache');
  props.setProperty('CACHE_ID', p.getId());
  return p;
}
function lerMemoria_(mes) {
  try { var it = pastaCache_().getFilesByName('ind_' + mes + '.json'); while (it.hasNext()) { var f = it.next(); if (!f.isTrashed()) return { arq: f, mapa: JSON.parse(f.getBlob().getDataAsString('UTF-8')) }; } } catch (e) { }
  return { arq: null, mapa: {} };
}
function portalIndicadoresLote(token, meses) {
  var s = sessao_(token);
  meses = (meses || []).filter(function (m) { return /^\d{4}-\d{2}$/.test(String(m)); }).slice(0, 24);
  var unid = arvorePortal_().filter(function (u) { return podeVer_(s, u.contabilidade); });
  var cache = CacheService.getScriptCache(), inicio = Date.now(), res = {};
  meses.forEach(function (mes) {
    var lista = unid.filter(function (u) { return u.arqs[mes]; });
    var chaves = lista.map(function (u) { var f = u.arqs[mes]; return 'ind3_' + f.id + '_' + f.mod; });
    var tudo = {};
    for (var i = 0; i < chaves.length; i += 100) { var g = cache.getAll(chaves.slice(i, i + 100)); for (var k in g) tudo[k] = g[k]; }
    var mem = null, mudou = false, itens = [], faltam = 0;
    lista.forEach(function (u, i) {
      var ck = chaves[i], ind = null;
      if (tudo[ck]) ind = JSON.parse(tudo[ck]);
      else {
        if (!mem) mem = lerMemoria_(mes);
        if (mem.mapa[ck]) { ind = mem.mapa[ck]; try { cache.put(ck, JSON.stringify(ind), 21600); } catch (e) { } }
        else if (Date.now() - inicio < 25000) {
          try {
            ind = indicadores_(JSON.parse(DriveApp.getFileById(u.arqs[mes].id).getBlob().getDataAsString('UTF-8')));
            try { cache.put(ck, JSON.stringify(ind), 21600); } catch (e) { }
            mem.mapa[ck] = ind; mudou = true;
          } catch (e) { ind = { erro: String(e.message || e) }; }
        } else { faltam++; return; }
      }
      ind.contabilidade = u.contabilidade; ind.cliente = u.cliente; ind.subpasta = u.subpasta;
      itens.push(ind);
    });
    if (mudou) {
      // guarda só as chaves dos arquivos atuais (as antigas saem)
      var validas = {}; arvorePortal_().forEach(function (u) { var f = u.arqs[mes]; if (f) validas['ind3_' + f.id + '_' + f.mod] = 1; });
      var limpo = {}; for (var k2 in mem.mapa) if (validas[k2]) limpo[k2] = mem.mapa[k2];
      var lock = LockService.getScriptLock();
      if (lock.tryLock(5000)) {
        try { var txt = JSON.stringify(limpo); if (mem.arq) mem.arq.setContent(txt); else pastaCache_().createFile('ind_' + mes + '.json', txt, 'application/json'); }
        catch (e) { } finally { lock.releaseLock(); }
      }
    }
    res[mes] = { mes: mes, itens: itens, faltam: faltam, total: lista.length };
  });
  return res;
}

/* ======================================================================
   CONFIGURAÇÕES (só para logins com * em Contabilidades)
   Logins dos contadores, contabilidades, clientes e regimes direto pelo portal.
   ====================================================================== */
function versaoCfg_() { return PropertiesService.getScriptProperties().getProperty('CFG_V') || '0'; }
function mudouCfg_() { PropertiesService.getScriptProperties().setProperty('CFG_V', String(Date.now())); }
function admin_(token) {
  var s = sessao_(token);
  if (s.contabs.indexOf('*') < 0) throw new Error('Só o administrador pode mexer nas configurações.');
  return s;
}
function nomePasta_(n) { return String(n || '').replace(/[\\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().toUpperCase(); }

// Árvore do Drive: contabilidades > clientes > (subpastas usadas dentro de "XML AAAA")
function estrutura_() {
  var raizId = pastaRaiz_().getId();
  var pastas = driveLista_("mimeType='application/vnd.google-apps.folder' and trashed=false", 'id,name,parents');
  var filhos = {};
  pastas.forEach(function (f) { (f.parents || []).forEach(function (p) { (filhos[p] = filhos[p] || []).push(f); }); });
  var ordena = function (a, b) { return a.name.localeCompare(b.name, 'pt-BR'); };
  return (filhos[raizId] || []).filter(function (c) { return c.name.charAt(0) !== '_'; }).sort(ordena).map(function (c) {
    return { nome: c.name, clientes: (filhos[c.id] || []).sort(ordena).map(function (cl) {
      var anos = [], subs = [];
      (filhos[cl.id] || []).forEach(function (a) {
        var m = a.name.match(/^XML\s*(\d{4})$/i); if (!m) return;
        anos.push(m[1]);
        (filhos[a.id] || []).forEach(function (s) { if (!/^\d{1,2}[.\-_ ]\d{4}$/.test(s.name) && subs.indexOf(s.name) < 0) subs.push(s.name); });
      });
      return { nome: cl.name, anos: anos.sort(), subpastas: subs.sort() };
    }) };
  });
}

// registro de acessos ao portal (aba "Acessos" da planilha): login e downloads
function abaAcessos_(ss) {
  var a = ss.getSheetByName('Acessos');
  if (a) return a;
  a = ss.insertSheet('Acessos');
  a.getRange(1, 1, 1, 4).setValues([['Data/hora', 'Login', 'Ação', 'Detalhe']]).setFontWeight('bold').setBackground('#0f6b55').setFontColor('#ffffff');
  a.setFrozenRows(1);
  return a;
}
function logAcesso_(login, acao, detalhe) {
  try { abaAcessos_(planilha_()).appendRow([new Date(), login, acao, String(detalhe || '').slice(0, 200)]); } catch (e) { }
}

function portalAdmin(token) {
  admin_(token);
  var aba = abaUsuarios_(planilha_()), d = aba.getDataRange().getValues(), usuarios = [];
  for (var i = 1; i < d.length; i++) {
    if (!String(d[i][0]).trim()) continue;
    usuarios.push({ login: String(d[i][0]).trim(), nome: String(d[i][1] || ''), contabs: String(d[i][2] || '').split(/[,;\n]/).map(function (s) { return s.trim(); }).filter(String),
      temSenha: !!(d[i][4] || d[i][3]), ativo: String(d[i][5]).trim().toUpperCase() !== 'N', ultimo: d[i][6] instanceof Date ? d[i][6].toISOString() : '', empresa: String(d[i][7] || '') });
  }
  var regimes = [], rg = abaRegimes_(planilha_()).getDataRange().getValues();
  for (var j = 1; j < rg.length; j++) if (rg[j][0] && rg[j][1]) regimes.push({ contabilidade: String(rg[j][0]), cliente: String(rg[j][1]), regime: regimeTexto_(rg[j][2]) });
  // uso do portal nos últimos 30 dias
  var uso = {}, limite = Date.now() - 30 * 86400000;
  try {
    var ac = abaAcessos_(planilha_()), n = ac.getLastRow();
    if (n > 1) {
      var ini = Math.max(2, n - 5000), lin = ac.getRange(ini, 1, n - ini + 1, 3).getValues();
      lin.forEach(function (l) {
        if (!(l[0] instanceof Date) || l[0].getTime() < limite) return;
        var k = String(l[1]).toLowerCase(), u = uso[k] = uso[k] || { acessos: 0, downloads: 0, ultimo: '' };
        if (l[2] === 'login') u.acessos++; else if (l[2] === 'download') u.downloads++;
        var iso = l[0].toISOString(); if (iso > u.ultimo) u.ultimo = iso;
      });
    }
  } catch (e) { }
  usuarios.forEach(function (u) { var x = uso[u.login.toLowerCase()] || {}; u.acessos30 = x.acessos || 0; u.downloads30 = x.downloads || 0; });
  return { usuarios: usuarios, estrutura: estrutura_(), regimes: regimes, versao: VERSAO };
}

function portalSalvarUsuario(token, u) {
  var s = admin_(token);
  var login = String(u.login || '').trim().toLowerCase();
  if (!/^[a-z0-9._@-]{3,40}$/.test(login)) throw new Error('Login: use de 3 a 40 letras, números, ponto, hífen ou @ (sem espaço).');
  var contabs = (u.contabs || []).map(function (c) { return String(c).trim(); }).filter(String);
  if (!contabs.length) throw new Error('Escolha ao menos uma contabilidade.');
  if (u.senha && String(u.senha).length < 6) throw new Error('A senha precisa ter pelo menos 6 caracteres.');
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var aba = abaUsuarios_(planilha_()), d = aba.getDataRange().getValues(), lin = -1;
    var original = String(u.original || '').trim().toLowerCase();
    for (var i = 1; i < d.length; i++) {
      var l = String(d[i][0]).trim().toLowerCase();
      if (l === login && l !== original) throw new Error('Já existe o login "' + login + '".');
      if (original && l === original) lin = i + 1;
    }
    if (original && lin < 0) throw new Error('Login não encontrado. Atualize a página.');
    if (!original && !u.senha) throw new Error('Informe a senha do login novo.');
    if (original === s.login && (contabs.indexOf('*') < 0 || u.ativo === false)) throw new Error('Você não pode tirar o seu próprio acesso de administrador.');
    if (lin < 0) lin = Math.max(aba.getLastRow(), 1) + 1;
    var hash = lin <= d.length ? String(d[lin - 1][4] || '') : '';
    if (u.senha) { var sal = Utilities.getUuid().replace(/-/g, '').slice(0, 16); hash = sal + '$' + hashSenha_(sal, String(u.senha)); }
    aba.getRange(lin, 1, 1, 6).setValues([[login, String(u.nome || login), contabs.join(', '), '', hash, u.ativo === false ? 'N' : 'S']]);
  } finally { lock.releaseLock(); }
  return portalAdmin(token);
}

function portalExcluirUsuario(token, login) {
  var s = admin_(token);
  login = String(login || '').trim().toLowerCase();
  if (login === s.login) throw new Error('Você não pode excluir o seu próprio login.');
  var aba = abaUsuarios_(planilha_()), d = aba.getDataRange().getValues();
  for (var i = d.length - 1; i >= 1; i--) if (String(d[i][0]).trim().toLowerCase() === login) aba.deleteRow(i + 1);
  return portalAdmin(token);
}

function portalCriarContabilidade(token, nome) {
  admin_(token);
  nome = nomePasta_(nome);
  if (nome.length < 2 || nome.charAt(0) === '_') throw new Error('Nome inválido.');
  var raiz = pastaRaiz_();
  if (existente_(raiz, nome)) throw new Error('Já existe a contabilidade "' + nome + '".');
  raiz.createFolder(nome);
  mudouCfg_();
  return portalAdmin(token);
}

function portalCriarCliente(token, contab, cliente, subpastas, ano) {
  admin_(token);
  cliente = nomePasta_(cliente);
  if (cliente.length < 2) throw new Error('Nome do cliente inválido.');
  var c = existente_(pastaRaiz_(), contab);
  if (!c) throw new Error('Contabilidade não encontrada.');
  if (existente_(c, cliente)) throw new Error('Já existe o cliente "' + cliente + '" em ' + contab + '.');
  var pasta = c.createFolder(cliente);
  var a = pasta.createFolder(formatar_(CONFIG.FORMATO_ANO, Number(ano) || new Date().getFullYear(), 1));
  (subpastas || []).map(nomePasta_).filter(String).forEach(function (s) { filha_(a, s); });
  mudouCfg_();
  return portalAdmin(token);
}

function portalSalvarRegime(token, contab, cliente, regime) {
  admin_(token);
  var aba = abaRegimes_(planilha_()), d = aba.getDataRange().getValues(), lin = -1;
  for (var i = 1; i < d.length; i++) if (normal_(d[i][0]) === normal_(contab) && normal_(d[i][1]) === normal_(cliente)) { lin = i + 1; break; }
  var txt = { SN: 'SIMPLES', MEI: 'MEI', PRESUMIDO: 'PRESUMIDO', REAL: 'REAL' }[regime] || '';
  if (!txt) { if (lin > 0) aba.deleteRow(lin); }
  else {
    if (lin < 0) lin = Math.max(aba.getLastRow(), 1) + 1;
    aba.getRange(lin, 1, 1, 3).setValues([[contab, cliente, txt]]);
  }
  mudouCfg_();
  return portalAdmin(token);
}

/* ======================================================================
   XML ENVIADOS À MÃO (clientes sem agente)
   O "processador" (lcxml.ps1 -Manuais, num computador do escritório) pede a lista de meses,
   baixa os ZIP/XML em partes, monta o resumo fiscal e devolve para o portal.
   ====================================================================== */
var TIPOS_ARQ = ['application/zip', 'application/x-zip-compressed', 'application/x-zip', 'text/xml', 'application/xml', 'application/json'];

function driveLista_(q, campos) {
  var out = [], token = null, tk = ScriptApp.getOAuthToken();
  do {
    var url = 'https://www.googleapis.com/drive/v3/files?pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true&q=' + encodeURIComponent(q) +
      '&fields=' + encodeURIComponent('nextPageToken,files(' + campos + ')') + (token ? '&pageToken=' + encodeURIComponent(token) : '');
    var r = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + tk }, muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) throw new Error('Drive (lista): ' + r.getContentText().slice(0, 200));
    var j = JSON.parse(r.getContentText());
    out = out.concat(j.files || []); token = j.nextPageToken;
  } while (token);
  return out;
}

function listarMeses_(req) {
  var raizId = pastaRaiz_().getId();
  var q = "trashed=false and (mimeType='application/vnd.google-apps.folder' or " + TIPOS_ARQ.map(function (m) { return "mimeType='" + m + "'"; }).join(' or ') + ')';
  var todos = driveLista_(q, 'id,name,mimeType,parents,modifiedTime,size');
  var filhos = {};
  todos.forEach(function (f) { (f.parents || []).forEach(function (p) { (filhos[p] = filhos[p] || []).push(f); }); });
  var pastas = function (id) { return (filhos[id] || []).filter(function (f) { return f.mimeType === 'application/vnd.google-apps.folder'; }); };
  var arquivos = function (id) { return (filhos[id] || []).filter(function (f) { return f.mimeType !== 'application/vnd.google-apps.folder'; }); };
  var reAno = /^XML\s*(\d{4})$/i, reMes = /^(\d{1,2})[.\-_ ](\d{4})$/;

  // resumos existentes: _PORTAL_DADOS / CONTAB / CLIENTE [/ SUB] / AAAA-MM.json
  var resumos = {};
  pastas(raizId).forEach(function (pp) {
    if (pp.name !== PASTA_PORTAL) return;
    pastas(pp.id).forEach(function (c) {
      pastas(c.id).forEach(function (cl) {
        var marca = function (pasta, sub) { arquivos(pasta.id).forEach(function (a) { var m = a.name.match(/^(\d{4}-\d{2})\.json$/); if (m) resumos[[normal_(c.name), normal_(cl.name), normal_(sub), m[1]].join('|')] = a.modifiedTime; }); };
        marca(cl, ''); pastas(cl.id).forEach(function (s) { marca(s, s.name); });
      });
    });
  });

  var itens = [];
  var arqsMes = function (pastaMes) {
    var ok = function (a) { return /\.(zip|xml)$/i.test(a.name); };
    var l = arquivos(pastaMes.id).filter(ok);
    pastas(pastaMes.id).forEach(function (sub) { l = l.concat(arquivos(sub.id).filter(ok)); });
    return l.map(function (a) { return { id: a.id, nome: a.name, tamanho: Number(a.size || 0), mod: a.modifiedTime }; });
  };
  var porChave = {};
  var addMes = function (contab, cli, subNome, pm, m) {
    var mes = m[2] + '-' + ('0' + m[1]).slice(-2);
    var arqs = arqsMes(pm); if (!arqs.length) return;
    var ch = [normal_(contab.name), normal_(cli.name), normal_(subNome), mes].join('|');
    if (porChave[ch]) { porChave[ch].arquivos = porChave[ch].arquivos.concat(arqs); return; }   // mesmo mês em dois lugares: junta
    porChave[ch] = { contabilidade: contab.name.trim(), cliente: cli.name.trim(), subpasta: subNome, mes: mes, arquivos: arqs, resumoMod: resumos[ch] || null };
    itens.push(porChave[ch]);
  };
  pastas(raizId).forEach(function (contab) {
    if (contab.name === PASTA_PORTAL) return;
    pastas(contab.id).forEach(function (cli) {
      var anos = pastas(cli.id).filter(function (a) { return reAno.test(a.name.trim()); });
      // subpastas (MATRIZ/FILIAL...) que têm meses dentro, em qualquer ano do cliente
      var subs = {};
      anos.forEach(function (ano) { pastas(ano.id).forEach(function (x) {
        if (!reMes.test(x.name.trim()) && pastas(x.id).some(function (pm) { return reMes.test(pm.name.trim()); })) subs[normal_(x.name)] = x.name.trim();
      }); });
      var nomes = Object.keys(subs);
      // se o cliente tem UMA subpasta só (ex.: o LC envia em MATRIZ), os meses soltos vão para ela -> um cliente só no portal
      var destinoSoltos = nomes.length === 1 ? subs[nomes[0]] : '';
      anos.forEach(function (ano) {
        pastas(ano.id).forEach(function (x) {
          var m = x.name.trim().match(reMes);
          if (m) addMes(contab, cli, destinoSoltos, x, m);
          else pastas(x.id).forEach(function (pm) { var m2 = pm.name.trim().match(reMes); if (m2) addMes(contab, cli, x.name.trim(), pm, m2); });
        });
      });
    });
  });
  return { ok: true, itens: itens };
}

// Baixa um pedaço de um arquivo (até 8 MB) direto da API do Drive - funciona com arquivos de qualquer tamanho
function baixarParte_(req) {
  obrigatorios_(req, ['id']);
  var ini = Number(req.inicio || 0), tam = Math.min(Number(req.tamanho || 8388608), 8388608);
  var r = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(req.id) + '?alt=media&supportsAllDrives=true', {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), Range: 'bytes=' + ini + '-' + (ini + tam - 1) }, muteHttpExceptions: true });
  var c = r.getResponseCode();
  if (c === 416) return { ok: true, dados: '', fim: true };
  if (c !== 200 && c !== 206) throw new Error('Drive (download ' + c + '): ' + r.getContentText().slice(0, 200));
  var b = r.getContent();
  return { ok: true, dados: Utilities.base64Encode(b), lidos: b.length };
}

/* Refaz a aba Painel a partir do Histórico (uma linha por contabilidade + cliente + mês, com o envio mais recente).
   As contagens de notas voltam completas no próximo envio de cada cliente. Rodar uma vez pelo editor. */
function REFAZER_PAINEL() {
  var ss = planilha_(), p = abaPainel_(ss), h = ss.getSheetByName('Histórico');
  var hd = h.getDataRange().getValues(), atual = p.getDataRange().getValues(), ult = {};
  var chave = function (c, cl, m) { return normal_(c) + '|' + normal_(cl) + '|' + mesTxt_(m); };
  var existe = {}; for (var i = 1; i < atual.length; i++) existe[chave(atual[i][0], atual[i][1], atual[i][3])] = 1;
  for (var j = 1; j < hd.length; j++) {
    var r = hd[j]; if (!r[1] || !r[2] || !r[3]) continue;
    var k = chave(r[1], r[2], r[3]);
    if (!ult[k] || (r[0] instanceof Date && r[0] > ult[k][0])) ult[k] = r;
  }
  var novas = [];
  Object.keys(ult).forEach(function (k) {
    if (existe[k]) return;
    var r = ult[k], l = [r[1], r[2], '', mesTxt_(r[3]), r[0], r[4]];
    for (var n = 0; n < CHAVES.length; n++) l.push('');
    l.push(r[5], r[6], r[7], '', 'refeito do histórico: ' + String(r[8] || ''), '');
    novas.push(l);
  });
  if (!novas.length) { Logger.log('Nada a refazer.'); return; }
  var ini = Math.max(p.getLastRow(), 1) + 1;
  p.getRange(ini, 4, novas.length, 1).setNumberFormat('@');          // texto ANTES de gravar, senão vira data
  p.getRange(ini, 1, novas.length, CAB_PAINEL.length).setValues(novas);
  p.getRange(ini, 5, novas.length, 1).setNumberFormat('dd/MM/yyyy HH:mm');
  for (var x = 0; x < novas.length; x++) p.getRange(ini + x, CAB_PAINEL.length).setFormula('=INT(NOW()-E' + (ini + x) + ')');
  PropertiesService.getScriptProperties().setProperty('DADOS_V', String(Date.now()));
  Logger.log(novas.length + ' linha(s) recolocadas no Painel.');
}

/* Mês do Painel/Histórico sempre como 'AAAA-MM', venha como texto, data da planilha
   ou texto de data ("Thu Oct 01 2026 00:00:00 GMT-0500 ..."). */
var FUSO_PLAN_ = null;
function mesTxt_(v) {
  if (v instanceof Date) {
    if (!FUSO_PLAN_) { try { FUSO_PLAN_ = planilha_().getSpreadsheetTimeZone(); } catch (e) { FUSO_PLAN_ = Session.getScriptTimeZone(); } }
    return Utilities.formatDate(v, FUSO_PLAN_, 'yyyy-MM');
  }
  var t = String(v == null ? '' : v).trim().replace(/^'/, ''), m;
  if ((m = t.match(/^(\d{4})-(\d{1,2})(?:\D|$)/))) return m[1] + '-' + ('0' + m[2]).slice(-2);
  if ((m = t.match(/^[A-Za-z]{3}\s+([A-Za-z]{3})\s+\d{1,2}\s+(\d{4})/))) {
    var ix = 'janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(m[1].toLowerCase());
    if (ix >= 0 && ix % 3 === 0) return m[2] + '-' + ('0' + (ix / 3 + 1)).slice(-2);
  }
  if ((m = t.match(/^\d{1,2}\/(\d{1,2})\/(\d{4})/))) return m[2] + '-' + ('0' + m[1]).slice(-2);   // dd/MM/aaaa
  if ((m = t.match(/^(\d{1,2})\/(\d{4})$/))) return m[2] + '-' + ('0' + m[1]).slice(-2);           // MM/aaaa
  return t;
}

/* Conserta a aba Painel (rodar UMA vez pelo editor depois de atualizar para 1.7.1):
   - coluna Mês volta a ser texto 'AAAA-MM' (o REFAZER_PAINEL antigo gravou como data);
   - linhas repetidas da mesma contabilidade + cliente + mês viram uma só (fica a do contato mais recente,
     completando com as contagens de notas da outra quando a mais recente veio sem elas). */
function CORRIGIR_PAINEL() {
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var ss = planilha_(), p = abaPainel_(ss);
    var d = p.getDataRange().getValues(), n = CAB_PAINEL.length;
    if (d.length < 2) { Logger.log('Painel vazio.'); return; }
    var porChave = {}, ordem = [], antes = d.length - 1;
    for (var i = 1; i < d.length; i++) {
      var r = d[i].slice(0, n);
      if (!String(r[0]).trim() && !String(r[1]).trim()) continue;
      r[3] = mesTxt_(r[3]);
      var k = normal_(r[0]) + '|' + normal_(r[1]) + '|' + r[3];
      var t = r[4] instanceof Date ? r[4].getTime() : 0;
      if (!porChave[k]) { porChave[k] = { r: r, t: t }; ordem.push(k); continue; }
      var a = porChave[k], novo = t > a.t ? r : a.r, velho = t > a.t ? a.r : r;
      for (var c = 6; c < 6 + CHAVES.length; c++) if (novo[c] === '' || novo[c] == null) novo[c] = velho[c];   // contagens
      if (!novo[2]) novo[2] = velho[2];                                                                     // CNPJ
      porChave[k] = { r: novo, t: Math.max(t, a.t) };
    }
    var linhas = ordem.map(function (k) { var r = porChave[k].r; r[n - 1] = ''; return r; });
    linhas.sort(function (x, y) { return normal_(x[0]).localeCompare(normal_(y[0])) || normal_(x[1]).localeCompare(normal_(y[1])) || String(x[3]).localeCompare(String(y[3])); });
    // grava: limpa o corpo, põe Mês como texto ANTES, depois os valores
    p.getRange(2, 1, Math.max(p.getMaxRows() - 1, 1), n).clearContent().setBackground('#ffffff');
    if (linhas.length) {
      p.getRange(2, 4, linhas.length, 1).setNumberFormat('@');
      p.getRange(2, 1, linhas.length, n).setValues(linhas);
      p.getRange(2, 5, linhas.length, 1).setNumberFormat('dd/MM/yyyy HH:mm');
      var f = []; for (var x = 0; x < linhas.length; x++) f.push(['=INT(NOW()-E' + (x + 2) + ')']);
      p.getRange(2, n, linhas.length, 1).setFormulas(f);
      var cores = linhas.map(function (r) { var cor = /ERRO/.test(String(r[5])) ? '#fbe9e7' : '#ffffff'; var l = []; for (var c = 0; c < n; c++) l.push(cor); return l; });
      p.getRange(2, 1, linhas.length, n).setBackgrounds(cores);
    }
    var sobra = p.getMaxRows() - (linhas.length + 1);
    if (sobra > 50) p.deleteRows(linhas.length + 2, sobra - 20);
    // Histórico: só o formato da coluna Mês daqui pra frente (os valores antigos são lidos certo pelo mesTxt_)
    var h = ss.getSheetByName('Histórico'); if (h) h.getRange('D:D').setNumberFormat('@');
    PropertiesService.getScriptProperties().setProperty('DADOS_V', String(Date.now()));
    Logger.log('Painel corrigido: ' + antes + ' linha(s) antes, ' + linhas.length + ' depois (' + (antes - linhas.length) + ' repetida(s) unificada(s)).');
  } finally { lock.releaseLock(); }
}

/* ======================================================================
   SERVIDORES DOS CLIENTES: backup do banco e vigia do MySQL (só administrador)
   Abas "Servidores" (uma linha por cliente com LC) e "Eventos MySQL" (travamentos e reinícios)
   ====================================================================== */
var CAB_SRV = ['Contabilidade', 'Cliente', 'Máquina', 'Versão', 'Banco', 'Serviço MySQL', 'Fazer backup (S/N)', 'Reiniciar MySQL de madrugada (S/N)',
  'Último contato', 'Último backup OK', 'Tamanho backup (MB)', 'Tamanho banco (MB)', 'Situação backup', 'Mensagem backup', 'Arquivo backup (id)', 'Espaço usado (MB)', 'Último sinal do vigia'];
var CAB_EVT = ['Data/hora', 'Contabilidade', 'Cliente', 'Máquina', 'Tipo', 'Detalhe', 'Segundos', 'Forçado'];

function pastaBackup_() {
  if (CONFIG.PASTA_BACKUP_ID) return DriveApp.getFolderById(CONFIG.PASTA_BACKUP_ID);
  var props = PropertiesService.getScriptProperties(), id = props.getProperty('BACKUP_ID');
  if (id) { try { var f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) { } }
  var p = filha_(DriveApp.getRootFolder(), '_BACKUPS_CPUSIS');
  props.setProperty('BACKUP_ID', p.getId());
  return p;
}
function abaServidores_(ss) {
  var a = ss.getSheetByName('Servidores');
  if (a) return a;
  a = ss.insertSheet('Servidores');
  a.getRange(1, 1, 1, CAB_SRV.length).setValues([CAB_SRV]).setFontWeight('bold').setBackground('#0f6b55').setFontColor('#ffffff');
  a.setFrozenRows(1);
  return a;
}
function abaEventos_(ss) {
  var a = ss.getSheetByName('Eventos MySQL');
  if (a) return a;
  a = ss.insertSheet('Eventos MySQL');
  a.getRange(1, 1, 1, CAB_EVT.length).setValues([CAB_EVT]).setFontWeight('bold').setBackground('#0f6b55').setFontColor('#ffffff');
  a.setFrozenRows(1);
  return a;
}
// acha (ou cria) a linha do servidor; devolve { aba, lin, linha[] }
function linhaServidor_(contab, cliente) {
  var aba = abaServidores_(planilha_()), d = aba.getDataRange().getValues();
  for (var i = 1; i < d.length; i++) if (normal_(d[i][0]) === normal_(contab) && normal_(d[i][1]) === normal_(cliente)) return { aba: aba, lin: i + 1, linha: d[i] };
  var lin = Math.max(aba.getLastRow(), 1) + 1, nova = [contab, cliente, '', '', '', '', 'S', 'N', '', '', '', '', '', '', '', '', ''];
  aba.getRange(lin, 1, 1, nova.length).setValues([nova]);
  return { aba: aba, lin: lin, linha: nova };
}
function sn_(v, padrao) { var s = String(v == null ? '' : v).trim().toUpperCase(); if (!s) return padrao; return s === 'S' || s === 'SIM' || s === 'TRUE'; }

// o agente pede as opções no começo da rodada da noite
function servidor_(req) {
  obrigatorios_(req, ['contabilidade', 'cliente']);
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var x = linhaServidor_(req.contabilidade, req.cliente);
    x.aba.getRange(x.lin, 3, 1, 4).setValues([[req.maquina || '', txt_(req.versao), req.banco || '', req.servico || '']]);
    x.aba.getRange(x.lin, 9).setValue(new Date()).setNumberFormat('dd/MM/yyyy HH:mm');
    var backup = sn_(x.linha[6], true), reiniciar = sn_(x.linha[7], false);
  } finally { lock.releaseLock(); }
  var senha = String(segredo_('SENHA_BACKUP') || '');
  if (!senha || /^TROQUE/.test(senha)) { backup = false; senha = ''; }   // sem senha definida: não faz backup
  var bpo = null; try { bpo = bpoDoAgente_(req.contabilidade, req.cliente); } catch (e) { }
  return { ok: true, backup: backup, reiniciar: reiniciar, senhaBackup: senha, bpo: bpo };
}

function backupConcluir_(req) {
  obrigatorios_(req, ['contabilidade', 'cliente', 'situacao']);
  var apagados = 0, espaco = 0, id = '';
  if (req.situacao === 'OK') {
    try { var g = limparBackups_(req.contabilidade, req.cliente, req.arquivo); apagados = g.apagados; espaco = g.espaco; id = g.id; } catch (e) { }
  }
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var x = linhaServidor_(req.contabilidade, req.cliente);
    x.aba.getRange(x.lin, 3, 1, 2).setValues([[req.maquina || '', txt_(req.versao)]]);
    x.aba.getRange(x.lin, 9).setValue(new Date()).setNumberFormat('dd/MM/yyyy HH:mm');
    if (req.situacao === 'OK') {
      x.aba.getRange(x.lin, 10, 1, 7).setValues([[new Date(), Math.round(Number(req.tamanho || 0) / 1048576 * 10) / 10, Math.round(Number(req.tamanhoSql || 0) / 1048576 * 10) / 10,
        'OK', String(req.mensagem || '').slice(0, 300), id, Math.round(espaco / 1048576 * 10) / 10]]);
      x.aba.getRange(x.lin, 10).setNumberFormat('dd/MM/yyyy HH:mm');
    } else {
      x.aba.getRange(x.lin, 13, 1, 2).setValues([['ERRO', String(req.mensagem || '').slice(0, 300)]]);
    }
  } finally { lock.releaseLock(); }
  return { ok: true, apagados: apagados };
}

// Guarda os últimos N dias, o último de cada uma das N semanas e de cada um dos N meses; apaga o resto (de vez, para liberar espaço)
function limparBackups_(contab, cliente, atual) {
  var pasta = filha_(filha_(pastaBackup_(), contab), cliente);
  var arqs = [], it = pasta.getFiles();
  while (it.hasNext()) {
    var f = it.next(); if (f.isTrashed()) continue;
    var m = f.getName().match(/_(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})\.lcbk$/); if (!m) continue;
    arqs.push({ f: f, nome: f.getName(), d: new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]), tam: f.getSize() });
  }
  arqs.sort(function (a, b) { return b.d - a.d; });
  var manter = {}, dias = {}, semanas = {}, meses = {};
  var semana = function (d) { var x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x.toDateString(); };
  arqs.forEach(function (a) {
    var kd = a.d.toDateString(), ks = semana(a.d), km = a.d.getFullYear() + '-' + a.d.getMonth();
    if (!dias[kd] && Object.keys(dias).length < CONFIG.GUARDAR_DIAS) { dias[kd] = 1; manter[a.nome] = 1; }
    if (!semanas[ks] && Object.keys(semanas).length < CONFIG.GUARDAR_SEMANAS) { semanas[ks] = 1; manter[a.nome] = 1; }
    if (!meses[km] && Object.keys(meses).length < CONFIG.GUARDAR_MESES) { meses[km] = 1; manter[a.nome] = 1; }
  });
  if (atual) manter[atual] = 1;
  var apagados = 0, espaco = 0, id = '';
  arqs.forEach(function (a) {
    if (a.nome === atual) id = a.f.getId();
    if (manter[a.nome]) { espaco += a.tam; return; }
    var r = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + a.f.getId() + '?supportsAllDrives=true',
      { method: 'delete', headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
    if (r.getResponseCode() < 300) apagados++; else espaco += a.tam;
  });
  return { apagados: apagados, espaco: espaco, id: id };
}

// eventos do vigia (travou, reiniciou, falhou...) e sinal de vida
var TIPO_EVT = { reiniciado: 'Travou e foi reiniciado', falhou: 'Reinício falhou', limite: 'Travando sem parar', travado: 'Travado (sem reinício automático)', programado: 'Reinício programado', acesso: 'Acesso recusado (senha do banco)' };
function eventos_(req) {
  obrigatorios_(req, ['contabilidade', 'cliente']);
  var evs = req.eventos || [], linhas = [], sinal = null;
  evs.forEach(function (e) {
    var q = String(e.quando || '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
    var d = q ? new Date(+q[1], +q[2] - 1, +q[3], +q[4], +q[5], +q[6]) : new Date();
    if (!sinal || d > sinal) sinal = d;
    if (e.tipo === 'sinal') return;
    linhas.push([d, req.contabilidade, req.cliente, req.maquina || '', TIPO_EVT[e.tipo] || String(e.tipo), String(e.detalhe || '').slice(0, 400), e.segundos || '', e.forcado ? 'S' : '']);
  });
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var ss = planilha_();
    if (linhas.length) { var a = abaEventos_(ss), ini = Math.max(a.getLastRow(), 1) + 1; a.getRange(ini, 1, linhas.length, CAB_EVT.length).setValues(linhas); a.getRange(ini, 1, linhas.length, 1).setNumberFormat('dd/MM/yyyy HH:mm:ss'); }
    var x = linhaServidor_(req.contabilidade, req.cliente);
    if (req.maquina) x.aba.getRange(x.lin, 3, 1, 2).setValues([[req.maquina, txt_(req.versao)]]);
    if (sinal) x.aba.getRange(x.lin, 17).setValue(sinal).setNumberFormat('dd/MM/yyyy HH:mm');
  } finally { lock.releaseLock(); }
  return { ok: true, gravados: linhas.length };
}

// ---- portal (administrador)
function portalServidores(token) {
  admin_(token);
  var ss = planilha_(), d = abaServidores_(ss).getDataRange().getValues(), ev = abaEventos_(ss).getDataRange().getValues();
  var iso = function (v) { return v instanceof Date ? v.toISOString() : ''; };
  var limite = Date.now() - 30 * 864e5, cont = {};
  var eventos = [];
  for (var j = ev.length - 1; j >= 1; j--) {
    var dt = ev[j][0]; if (!(dt instanceof Date)) continue;
    var k = normal_(ev[j][1]) + '|' + normal_(ev[j][2]);
    if (dt.getTime() >= limite && ev[j][4] !== TIPO_EVT.programado) { cont[k] = cont[k] || { n: 0, ult: null }; cont[k].n++; if (!cont[k].ult || dt > cont[k].ult) cont[k].ult = dt; }
    if (eventos.length < 80) eventos.push({ quando: iso(dt), contabilidade: String(ev[j][1]), cliente: String(ev[j][2]), maquina: String(ev[j][3]), tipo: String(ev[j][4]), detalhe: String(ev[j][5]), segundos: ev[j][6] || '', forcado: ev[j][7] === 'S' });
  }
  var srv = [];
  for (var i = 1; i < d.length; i++) {
    if (!d[i][0] && !d[i][1]) continue;
    var c = cont[normal_(d[i][0]) + '|' + normal_(d[i][1])] || { n: 0, ult: null };
    srv.push({ contabilidade: String(d[i][0]), cliente: String(d[i][1]), maquina: String(d[i][2]), versao: verTxt_(d[i][3]), banco: String(d[i][4]), servico: String(d[i][5]),
      backup: sn_(d[i][6], true), reiniciar: sn_(d[i][7], false), contato: iso(d[i][8]), ultimoBackup: iso(d[i][9]), tamanhoMB: Number(d[i][10] || 0), bancoMB: Number(d[i][11] || 0),
      situacao: String(d[i][12] || ''), mensagem: String(d[i][13] || ''), arquivoId: String(d[i][14] || ''), espacoMB: Number(d[i][15] || 0), sinal: iso(d[i][16]),
      travamentos30: c.n, ultimoTravamento: c.ult ? c.ult.toISOString() : '' });
  }
  var senhaOk = !!segredo_('SENHA_BACKUP');
  return { servidores: srv, eventos: eventos, senhaOk: senhaOk, pasta: (function () { try { return pastaBackup_().getUrl(); } catch (e) { return ''; } })() };
}
function portalSalvarServidor(token, s) {
  admin_(token);
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var x = linhaServidor_(String(s.contabilidade || ''), String(s.cliente || ''));
    x.aba.getRange(x.lin, 7, 1, 2).setValues([[s.backup ? 'S' : 'N', s.reiniciar ? 'S' : 'N']]);
  } finally { lock.releaseLock(); }
  return portalServidores(token);
}

/* ======================================================================
   ATUALIZAÇÃO AUTOMÁTICA PELO GITHUB (Farol Contábil)
   A cada 15 minutos o carregador lê versao.json no repositório público
   CPUSISCODE/farol.contabil e, se houver versão nova:
     1) receptor: o carregador baixa este arquivo e passa a usá-lo na hora (mesma URL /exec);
     2) portal:   troca _PORTAL_DADOS/portal/Portal.html no Drive;
     3) agente:   troca _PORTAL_DADOS/agente/lcxml.ps1 no Drive (os agentes baixam sozinhos na próxima execução).
   Tudo fica registrado na aba "Atualizações" da planilha.
   ====================================================================== */
var GITHUB_RAW = 'https://raw.githubusercontent.com/CPUSISCODE/farol.contabil/main/';

/* Rodar UMA VEZ pelo editor depois de colar este código. Faz tudo:
   guarda as senhas nas Propriedades, cria as abas, conserta o Painel, liga a verificação a cada 15 min
   e já aplica o que estiver pendente no GitHub (inclusive publica a versão nova do App da Web). */
function INSTALAR_FAROL() {
  var props = PropertiesService.getScriptProperties();
  ['SENHA', 'SENHA_BACKUP'].forEach(function (k) {
    var c = String(CONFIG[k] || '');
    if (c && !/^TROQUE/.test(c)) props.setProperty(k, c);
    if (!props.getProperty(k)) Logger.log('ATENÇÃO: falta a propriedade ' + k + ' (Configurações do projeto > Propriedades do script).');
  });
  TESTAR_E_AUTORIZAR();
  try {   // nome do portal: Farol Contábil (só se ainda estiver com o nome padrão antigo)
    var ap = abaAparencia_(planilha_()), d = ap.getDataRange().getValues();
    for (var i = 1; i < d.length; i++) if (d[i][0] === 'Nome do portal' && String(d[i][1]).trim() === 'Portal Contábil') ap.getRange(i + 1, 2).setValue('Farol Contábil');
    CacheService.getScriptCache().remove('aparencia');
  } catch (e) { }
  if (!props.getProperty('PAINEL_171')) { CORRIGIR_PAINEL(); props.setProperty('PAINEL_171', '1'); }
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'VERIFICAR_ATUALIZACAO') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('VERIFICAR_ATUALIZACAO').timeBased().everyMinutes(15).create();
  Logger.log('Verificação automática ligada (a cada 15 min).');
  var r = ATUALIZAR_AGORA();
  Logger.log(JSON.stringify(r));
}

// Gatilho de 15 em 15 minutos
function VERIFICAR_ATUALIZACAO() {
  var props = PropertiesService.getScriptProperties();
  // tarefas que rodam uma vez depois de uma atualização do receptor
  try { if (!props.getProperty('PAINEL_171')) { CORRIGIR_PAINEL(); props.setProperty('PAINEL_171', '1'); } } catch (e) { logAtualizacao_('painel', '', '', 'ERRO: ' + e.message); }
  try { ATUALIZAR_AGORA(); } catch (e) { logAtualizacao_('verificação', '', '', 'ERRO: ' + e.message); }
}

// Pode rodar pelo editor para forçar a verificação na hora
function ATUALIZAR_AGORA() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { ok: false, erro: 'outra atualização em andamento' };
  var props = PropertiesService.getScriptProperties(), feito = {};
  try {
    var v = JSON.parse(baixarGit_('versao.json').getDataAsString('UTF-8'));
    // 1) receptor
    // 1) receptor: quem atualiza é o carregador (Carregador.gs) — aqui só portal e agente
    // 2) portal
    if (v.portal && props.getProperty('INST_PORTAL') !== String(v.portal)) {
      try {
        var html = baixarGit_('receptor/Portal.html');
        if (!/<\/html>\s*$/i.test(html.getDataAsString('UTF-8'))) throw new Error('Portal.html incompleto');
        trocarArquivoDrive_(pastaPortal_('portal'), 'Portal.html', html, 'text/html');
        props.setProperty('INST_PORTAL', String(v.portal)); feito.portal = v.portal;
        logAtualizacao_('portal', '', v.portal, 'OK');
      } catch (e) { logAtualizacao_('portal', '', v.portal, 'ERRO: ' + e.message); }
    }
    // 3) agente (só depois que o receptor já está na versão exigida)
    var publicada = props.getProperty('FAROL_RECEPTOR') ? VERSAO : String(props.getProperty('VERSAO_PUBLICADA') || '0');   // pelo carregador, o código que roda é o publicado
    if (v.agente && props.getProperty('INST_AGENTE') !== String(v.agente) && !versaoMaior_(String(v.receptorMinimoAgente || '0'), publicada)) {
      try {
        var ps = baixarGit_('agente/lcxml.ps1'), txt = ps.getDataAsString('UTF-8');
        var m = txt.match(/\$VERSAO\s*=\s*'([\d.]+)'/);
        if (!m || m[1] !== String(v.agente)) throw new Error('lcxml.ps1 do GitHub não é a versão ' + v.agente);
        trocarArquivoDrive_(pastaPortal_('agente'), 'lcxml.ps1', ps, 'application/octet-stream');
        props.setProperty('INST_AGENTE', String(v.agente)); feito.agente = v.agente;
        logAtualizacao_('agente', '', v.agente, 'OK (os agentes pegam na próxima execução)');
      } catch (e) { logAtualizacao_('agente', '', v.agente, 'ERRO: ' + e.message); }
    }
  } finally { lock.releaseLock(); }
  return { ok: true, feito: feito };
}

function baixarGit_(caminho) {
  var r = UrlFetchApp.fetch(GITHUB_RAW + caminho + '?t=' + Date.now(), { muteHttpExceptions: true, headers: { 'Cache-Control': 'no-cache' } });
  if (r.getResponseCode() !== 200) throw new Error('GitHub ' + caminho + ': HTTP ' + r.getResponseCode());
  return r.getBlob();
}

function pastaPortal_(sub) { return filha_(filha_(pastaRaiz_(), PASTA_PORTAL), sub); }

// Troca o conteúdo do arquivo (mantém o mesmo ID); cria se não existir
function trocarArquivoDrive_(pasta, nome, blob, tipo) {
  var it = pasta.getFilesByName(nome), f = null;
  while (it.hasNext()) { var x = it.next(); if (!x.isTrashed()) { f = x; break; } }
  if (!f) { pasta.createFile(blob.setName(nome).setContentType(tipo)); return; }
  var r = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files/' + f.getId() + '?uploadType=media&supportsAllDrives=true', {
    method: 'patch', contentType: tipo, payload: blob.getBytes(), muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }
  });
  if (r.getResponseCode() !== 200) throw new Error('Drive: ' + r.getContentText().slice(0, 200));
}

function logAtualizacao_(oque, de, para, resultado) {
  try {
    var ss = planilha_(), a = ss.getSheetByName('Atualizações');
    if (!a) { a = ss.insertSheet('Atualizações'); a.getRange(1, 1, 1, 5).setValues([['Data/hora', 'O quê', 'De', 'Para', 'Resultado']]).setFontWeight('bold').setBackground('#0f6b55').setFontColor('#ffffff'); a.setFrozenRows(1); a.getRange('C:D').setNumberFormat('@'); }
    a.appendRow([new Date(), oque, "'" + (de || ''), "'" + (para || ''), resultado]);
  } catch (e) { }
}


/* ======================================================================
   UNIFICAR CLIENTES DUPLICADOS (ex.: "COMERCIAL 59" e "COMERCIAL 59 / MATRIZ")
   Mesmo cliente com meses soltos (sem subpasta, em geral os enviados à mão) e meses numa subpasta
   (em geral MATRIZ, a do agente). Fica só a subpasta: o que faltar nela vem da parte solta.
   Quando os dois lados têm o mesmo arquivo, fica o maior na subpasta e o outro vai para
   _PORTAL_DADOS/_unificados (nada é apagado). Depois disso, envios novos sem subpasta desse cliente
   vão sozinhos para a subpasta (propriedade UNIFICADOS).
   Portal > Configurações > Clientes duplicados (primeiro mostra a prévia, depois executa).
   ====================================================================== */
var RE_MES_PASTA = /^\d{2}\.\d{4}$/, RE_ANO_PASTA = /^XML \d{4}$/i, RE_JSON_MES = /^\d{4}-\d{2}\.json$/;

function mapaUnificados_() { try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('UNIFICADOS') || '{}'); } catch (e) { return {}; } }
// envio sem subpasta de cliente já unificado: manda para a subpasta que ficou
function redirecionarUnificado_(req) {
  if (['iniciar', 'concluir', 'manuais'].indexOf(req.acao) < 0) return true;
  if (req.subpasta || !req.contabilidade || !req.cliente || req.destino === 'backup') return true;
  var alvo = mapaUnificados_()[normal_(req.contabilidade) + '|' + normal_(req.cliente)];
  if (alvo) req.subpasta = alvo;
  return true;
}
function pastasDe_(pai) { var o = [], it = pai.getFolders(); while (it.hasNext()) { var f = it.next(); if (!f.isTrashed()) o.push(f); } return o; }
function arquivosDe_(pai) { var o = [], it = pai.getFiles(); while (it.hasNext()) { var f = it.next(); if (!f.isTrashed()) o.push(f); } return o; }

// Levanta os casos: [{contabilidade, cliente, destino, ambiguo, subpastas, json:{mover,conflito}, xml:{mover,mesclar}}]
function casosUnificar_() {
  var raiz = pastaRaiz_(), pd = existente_(raiz, PASTA_PORTAL), casos = {};
  var caso = function (c, k) { var ch = normal_(c) + '|' + normal_(k); return casos[ch] = casos[ch] || { contabilidade: c, cliente: k, subs: {}, jsonsSoltos: [], mesesXmlSoltos: [] }; };
  // resumos do portal
  if (pd) pastasDe_(pd).forEach(function (pc) {
    if (['agente', 'portal', 'cache', 'receptor'].indexOf(pc.getName()) >= 0 || pc.getName().charAt(0) === '_') return;
    pastasDe_(pc).forEach(function (pk) {
      var x = caso(pc.getName(), pk.getName());
      arquivosDe_(pk).forEach(function (f) { if (RE_JSON_MES.test(f.getName())) x.jsonsSoltos.push(f.getName().slice(0, 7)); });
      pastasDe_(pk).forEach(function (ps) { x.subs[ps.getName().toUpperCase()] = 1; });
    });
  });
  // pastas dos XML
  pastasDe_(raiz).forEach(function (pc) {
    if (pc.getName() === PASTA_PORTAL || pc.getName().charAt(0) === '_') return;
    pastasDe_(pc).forEach(function (pk) {
      var x = null;
      pastasDe_(pk).forEach(function (pa) {
        if (!RE_ANO_PASTA.test(pa.getName())) return;
        pastasDe_(pa).forEach(function (pm) {
          x = x || caso(pc.getName(), pk.getName());
          if (RE_MES_PASTA.test(pm.getName())) x.mesesXmlSoltos.push(pa.getName() + ' / ' + pm.getName());
          else x.subs[pm.getName().toUpperCase()] = 1;
        });
      });
    });
  });
  return Object.keys(casos).map(function (k) { return casos[k]; }).filter(function (x) {
    return (x.jsonsSoltos.length || x.mesesXmlSoltos.length) && Object.keys(x.subs).length;
  }).map(function (x) {
    var subs = Object.keys(x.subs).sort();
    return { contabilidade: x.contabilidade, cliente: x.cliente, subpastas: subs, destino: subs.length === 1 ? subs[0] : '',
      ambiguo: subs.length !== 1, jsons: x.jsonsSoltos.sort(), xml: x.mesesXmlSoltos.sort() };
  }).sort(function (a, b) { return (a.contabilidade + a.cliente).localeCompare(b.contabilidade + b.cliente); });
}

// Move tudo de "de" para "para"; mesmo nome nos dois: fica o maior em "para", o outro vai para "sobras"
function mesclarPasta_(de, para, sobras, rel) {
  var r = { movidos: 0, conflitos: 0 };
  arquivosDe_(de).forEach(function (f) {
    var it = para.getFilesByName(f.getName()), g = null;
    while (it.hasNext()) { var y = it.next(); if (!y.isTrashed()) { g = y; break; } }
    if (!g) { f.moveTo(para); r.movidos++; return; }
    r.conflitos++;
    var dest = filha_(sobras, rel);
    if (f.getSize() > g.getSize()) { g.moveTo(dest); f.moveTo(para); } else f.moveTo(dest);
  });
  pastasDe_(de).forEach(function (sub) {
    var alvo = existente_(para, sub.getName());
    if (!alvo) { sub.moveTo(para); r.movidos++; return; }
    var q = mesclarPasta_(sub, alvo, sobras, rel + ' - ' + sub.getName()); r.movidos += q.movidos; r.conflitos += q.conflitos;
  });
  if (!arquivosDe_(de).length && !pastasDe_(de).length) de.setTrashed(true);
  return r;
}

// escolhas: [{contabilidade, cliente, destino}] (sem escolhas = só a prévia)
function portalUnificar(token, escolhas) {
  admin_(token);
  var todos = casosUnificar_();
  if (!escolhas || !escolhas.length) return { casos: todos };
  var casos = [];
  escolhas.forEach(function (e) {
    var x = todos.filter(function (c) { return normal_(c.contabilidade) === normal_(e.contabilidade) && normal_(c.cliente) === normal_(e.cliente); })[0];
    if (!x) return;
    var d = x.subpastas.filter(function (s) { return normal_(s) === normal_(e.destino); })[0];
    if (!d) throw new Error('Subpasta inválida para ' + x.cliente + ': ' + e.destino);
    x.destino = d; x.ambiguo = false; casos.push(x);
  });
  var lock = LockService.getScriptLock(); lock.waitLock(60000);
  var feitos = [], props = PropertiesService.getScriptProperties(), mapa = mapaUnificados_();
  try {
    var raiz = pastaRaiz_(), pd = filha_(raiz, PASTA_PORTAL), sobras = filha_(pd, '_unificados');
    casos.forEach(function (x) {
      if (x.ambiguo) return;
      var tot = { movidos: 0, conflitos: 0 }, soma = function (q) { tot.movidos += q.movidos; tot.conflitos += q.conflitos; };
      var sob = filha_(filha_(sobras, x.contabilidade), x.cliente);
      // resumos do portal: CLIENTE/AAAA-MM.json -> CLIENTE/SUBPASTA/
      var pk = existente_(existente_(pd, x.contabilidade), x.cliente);
      if (pk) {
        var alvoJ = existente_(pk, x.destino) || filha_(pk, x.destino);
        arquivosDe_(pk).forEach(function (f) {
          if (!RE_JSON_MES.test(f.getName())) return;
          var it = alvoJ.getFilesByName(f.getName()), g = null;
          while (it.hasNext()) { var y = it.next(); if (!y.isTrashed()) { g = y; break; } }
          if (!g) { f.moveTo(alvoJ); tot.movidos++; }
          else { tot.conflitos++; if (f.getSize() > g.getSize()) { g.moveTo(filha_(sob, 'resumos')); f.moveTo(alvoJ); } else f.moveTo(filha_(sob, 'resumos')); }
        });
      }
      // XML: CLIENTE/XML AAAA/MM.AAAA -> CLIENTE/XML AAAA/SUBPASTA/MM.AAAA
      var ck = existente_(existente_(raiz, x.contabilidade), x.cliente);
      if (ck) pastasDe_(ck).forEach(function (pa) {
        if (!RE_ANO_PASTA.test(pa.getName())) return;
        var alvoS = null;
        pastasDe_(pa).forEach(function (pm) {
          if (!RE_MES_PASTA.test(pm.getName())) return;
          alvoS = alvoS || existente_(pa, x.destino) || filha_(pa, x.destino);
          var alvoM = existente_(alvoS, pm.getName());
          if (!alvoM) { pm.moveTo(alvoS); tot.movidos++; }
          else soma(mesclarPasta_(pm, alvoM, sob, pa.getName() + ' - ' + pm.getName()));
        });
      });
      renomearClientePlanilha_(x.contabilidade, x.cliente, x.cliente + ' / ' + x.destino);
      mapa[normal_(x.contabilidade) + '|' + normal_(x.cliente)] = x.destino;
      feitos.push({ contabilidade: x.contabilidade, cliente: x.cliente, destino: x.destino, movidos: tot.movidos, conflitos: tot.conflitos });
    });
    props.setProperty('UNIFICADOS', JSON.stringify(mapa));
    props.setProperty('DADOS_V', String(Date.now())); mudouCfg_();
  } finally { lock.releaseLock(); }
  if (feitos.length) { try { CORRIGIR_PAINEL(); } catch (e) { } }   // junta as linhas do Painel que ficaram iguais
  try { logAcesso_(sessao_(token).login, 'unificar', feitos.map(function (f) { return f.contabilidade + '/' + f.cliente + '>' + f.destino; }).join('; ').slice(0, 400)); } catch (e) { }
  return { feitos: feitos, casos: casosUnificar_() };
}

// Painel e Histórico: "CLIENTE" passa a ser "CLIENTE / SUBPASTA"
function renomearClientePlanilha_(contab, de, para) {
  var ss = planilha_();
  [['Painel', 0, 1], ['Histórico', 1, 2]].forEach(function (a) {
    var aba = ss.getSheetByName(a[0]); if (!aba || aba.getLastRow() < 2) return;
    var col = aba.getRange(2, a[2] + 1, aba.getLastRow() - 1, 1).getValues(), cs = aba.getRange(2, a[1] + 1, aba.getLastRow() - 1, 1).getValues(), mudou = false;
    for (var i = 0; i < col.length; i++) if (normal_(cs[i][0]) === normal_(contab) && normal_(col[i][0]) === normal_(de)) { col[i][0] = para; mudou = true; }
    if (mudou) aba.getRange(2, a[2] + 1, col.length, 1).setValues(col);
  });
}

/* ======================================================================
   FINANCEIRO (BPO) — clientes com o serviço ligado na aba "BPO" da planilha
   Dados no Drive: _PORTAL_DADOS/_financeiro/CONTABILIDADE/CLIENTE/
       indice.json                       contas bancárias, meses, última importação
       contas/<conta>/<AAAA-MM>.json      lançamentos do extrato (OFX), já categorizados
       regras.json                       regras aprendidas deste cliente
       ofx/  anexos/                     arquivos originais e comprovantes
   Quem vê: administrador (operador CPUSIS) tudo; contabilidade só consulta os clientes dela;
   login de empresa vê só a própria empresa e responde as pendências.
   ====================================================================== */
var CAB_BPO = ['Contabilidade', 'Cliente', 'BPO ativo (S/N)', 'Início (AAAA-MM-DD)', 'Operador', 'Observação', 'Último OFX', 'Pendências abertas', 'Saldo nos bancos (R$)', 'Atualizado em'];

// Plano de contas padrão (comércio). g = grupo da DRE; fora = não entra na DRE (só no fluxo de caixa)
var PLANO_FIN = [
  { id: 'rec_vendas', nome: 'Vendas / recebimentos de clientes', g: 'Receitas' },
  { id: 'rec_cartao', nome: 'Recebimentos de cartão', g: 'Receitas' },
  { id: 'rec_pix', nome: 'PIX recebidos', g: 'Receitas' },
  { id: 'rec_boleto', nome: 'Boletos recebidos', g: 'Receitas' },
  { id: 'rec_deposito', nome: 'Depósitos em dinheiro', g: 'Receitas' },
  { id: 'rec_outras', nome: 'Outras receitas', g: 'Receitas' },
  { id: 'imp_impostos', nome: 'Impostos (DAS, ICMS, federais)', g: 'Impostos' },
  { id: 'cus_mercadorias', nome: 'Compras de mercadorias (revenda)', g: 'Custo das mercadorias' },
  { id: 'cus_frete', nome: 'Fretes sobre compras', g: 'Custo das mercadorias' },
  { id: 'des_folha', nome: 'Salários e encargos (FGTS, INSS)', g: 'Despesas com pessoal' },
  { id: 'des_prolabore', nome: 'Pró-labore', g: 'Despesas com pessoal' },
  { id: 'des_aluguel', nome: 'Aluguel e condomínio', g: 'Despesas operacionais' },
  { id: 'des_energia', nome: 'Energia elétrica', g: 'Despesas operacionais' },
  { id: 'des_agua', nome: 'Água e esgoto', g: 'Despesas operacionais' },
  { id: 'des_telefone', nome: 'Telefone e internet', g: 'Despesas operacionais' },
  { id: 'des_combustivel', nome: 'Combustível', g: 'Despesas operacionais' },
  { id: 'des_manutencao', nome: 'Manutenção e reparos', g: 'Despesas operacionais' },
  { id: 'des_material', nome: 'Material de uso e consumo', g: 'Despesas operacionais' },
  { id: 'des_sistemas', nome: 'Sistemas e software', g: 'Despesas operacionais' },
  { id: 'des_contabilidade', nome: 'Contabilidade e honorários', g: 'Despesas operacionais' },
  { id: 'des_marketing', nome: 'Marketing e propaganda', g: 'Despesas operacionais' },
  { id: 'des_outras', nome: 'Outras despesas', g: 'Despesas operacionais' },
  { id: 'fin_tarifas', nome: 'Tarifas bancárias', g: 'Despesas financeiras' },
  { id: 'fin_taxas_cartao', nome: 'Taxas de cartão', g: 'Despesas financeiras' },
  { id: 'fin_juros', nome: 'Juros e multas', g: 'Despesas financeiras' },
  { id: 'fin_iof', nome: 'IOF', g: 'Despesas financeiras' },
  { id: 'fin_rendimentos', nome: 'Rendimentos de aplicações', g: 'Receitas financeiras' },
  { id: 'nop_transf', nome: 'Transferência entre contas da empresa', g: 'Fora da DRE', fora: true },
  { id: 'nop_aplicacao', nome: 'Aplicação financeira', g: 'Fora da DRE', fora: true },
  { id: 'nop_resgate', nome: 'Resgate de aplicação', g: 'Fora da DRE', fora: true },
  { id: 'nop_emprestimo_in', nome: 'Empréstimo recebido', g: 'Fora da DRE', fora: true },
  { id: 'nop_emprestimo_out', nome: 'Pagamento de empréstimo', g: 'Fora da DRE', fora: true },
  { id: 'nop_retirada', nome: 'Retirada de sócios', g: 'Fora da DRE', fora: true },
  { id: 'nop_aporte', nome: 'Aporte de sócios', g: 'Fora da DRE', fora: true },
  { id: 'nop_ativo', nome: 'Compra de ativo imobilizado', g: 'Fora da DRE', fora: true }
];
// Regras padrão pelo texto do extrato (s: C = só entradas, D = só saídas, '' = as duas)
var REGRAS_FIN = [
  [/\bIOF\b/, 'fin_iof', 'D'],
  [/TARIFA|\bTAR\b|CESTA DE SERV|PACOTE DE SERV|PACOTE SERV|MANUT(ENCAO)? (DE )?CONTA|ANUIDADE|TX\.? ?MANUT|\bTAXA DE SERV/, 'fin_tarifas', 'D'],
  [/JUROS|MULTA|ENCARGO|\bMORA\b|ADIANT(AMENTO)? A DEPOSITANTE|\bCHEQUE ESPECIAL/, 'fin_juros', 'D'],
  [/RENDIMENTO|REND\.? APLIC|REMUNERACAO (DE )?APLIC|JUROS S\/ ?CAPITAL/, 'fin_rendimentos', 'C'],
  [/CIELO|REDE ?CARD|\bREDE\b|STONE|GETNET|PAGSEGURO|PAGBANK|SUMUP|SAFRAPAY|MERCADO ?PAGO|MERCADOPAGO|SIPAG|\bVERO\b|\bTON\b|BIN ?SERV|GLOBAL ?PAYMENTS|FISERV|CABAL|VISA ELECTRON|MASTERCARD|ELO SERV|ANTECIPACAO (DE )?RECEB/, 'rec_cartao', 'C'],
  [/SIMPLES NAC|\bDAS\b|RECEITA FED|\bDARF\b|SEFAZ|\bICMS\b|\bGNRE\b|\bIPVA\b|\bIPTU\b|PREFEITURA|\bDAE\b|TRIBUT/, 'imp_impostos', 'D'],
  [/\bFGTS\b|\bINSS\b|\bGPS\b|SALARIO|FOLHA (DE )?PAG|\bFERIAS\b|RESCISAO|13O SAL/, 'des_folha', 'D'],
  [/PRO ?LABORE/, 'des_prolabore', 'D'],
  [/ENERGISA|ELETROACRE|ELETROBRAS|ENERGIA|\bCEMIG\b|\bCOPEL\b|EQUATORIAL|NEOENERGIA|\bENEL\b|\bLIGHT\b|CELPA|COELBA/, 'des_energia', 'D'],
  [/SANEAMENTO|DEPASA|\bSAAE\b|SANEAGO|SABESP|AGUAS? (DE|DO)|CAERD|COSANPA/, 'des_agua', 'D'],
  [/\bVIVO\b|\bCLARO\b|\bTIM\b|TELEFONICA|\bOI\b|EMBRATEL|STARLINK|INTERNET|TELECOM|PROVEDOR/, 'des_telefone', 'D'],
  [/ALUGUEL|CONDOMINIO|LOCACAO DE IMOVEL/, 'des_aluguel', 'D'],
  [/\bPOSTO\b|COMBUST|SHELL|IPIRANGA|PETROBRAS|\bBR DISTRIB|AUTO POSTO/, 'des_combustivel', 'D'],
  [/HONORARIO|CONTABIL/, 'des_contabilidade', 'D'],
  [/APLICACAO|APLIC\.? ?(AUT|FINANC|CDB|RDB)|\bCDB\b|\bRDB\b|POUPANCA|INVEST(IMENTO)? AUT/, 'nop_aplicacao', 'D'],
  [/RESGATE|RESG\.? ?(AUT|APLIC|CDB|RDB)/, 'nop_resgate', 'C'],
  [/EMPRESTIMO|EMPREST|FINANCIAMENTO|CAPITAL DE GIRO|\bCCB\b/, 'nop_emprestimo_in', 'C'],
  [/EMPRESTIMO|EMPREST|FINANCIAMENTO|PARC(ELA)? (DE )?EMPR|CAPITAL DE GIRO|\bCCB\b|CONSORCIO/, 'nop_emprestimo_out', 'D'],
  [/MESMA TITULARIDADE|ENTRE CONTAS|TRANSF(ERENCIA)? (ENTRE|P\/ ?MESMA)|\bTEF\b/, 'nop_transf', ''],
  [/DEP(OSITO)?\.? ?(EM )?(DINHEIRO|ESPECIE)|DEP\.? ?CX|DEPOSITO ?(ONLINE|CAIXA|BALCAO|TERMINAL)|DEP ATM|DEPOSITO$/, 'rec_deposito', 'C'],
  [/COBRANCA|LIQ(UIDACAO)?\.? ?(DE )?(BOLETO|TITULO|COBR)|CRED(ITO)? ?COBR|BOLETO RECEB|TITULO RECEB/, 'rec_boleto', 'C'],
  [/PIX ?(RECEBIDO|REC|CRED|-? ?CREDITO|ENTRADA)|RECEBIMENTO PIX|CRED(ITO)? PIX|TRANSF(ERENCIA)? RECEBIDA|TED RECEBIDA|DOC RECEBIDO/, 'rec_pix', 'C']
];

function planoFin_() { var o = {}; PLANO_FIN.forEach(function (c) { o[c.id] = c; }); return o; }
function finTexto_(t) { return normal_(String(t || '')).replace(/[^A-Z0-9\/\.\- ]/g, ' ').replace(/\s+/g, ' ').trim(); }
// "PIX ENVIADO 12/11 JOAO DA SILVA 123456" -> "PIX ENVIADO JOAO DA SILVA" (chave das regras aprendidas)
function finChave_(t) { return finTexto_(t).replace(/\b\d+([\/\.\-]\d+)*\b/g, ' ').replace(/[\/\.\-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60); }

function finCategorizar_(tr, regras) {
  var txt = finTexto_(tr.desc), ch = finChave_(tr.desc), sinal = tr.valor < 0 ? 'D' : 'C';
  for (var i = 0; i < regras.length; i++) {   // regras deste cliente primeiro (aprendidas com o operador)
    var r = regras[i];
    if ((!r.sinal || r.sinal === sinal) && r.chave && (ch === r.chave || (r.chave.length >= 8 && ch.indexOf(r.chave) >= 0))) return { cat: r.cat, origem: 'regra' };
  }
  for (var j = 0; j < REGRAS_FIN.length; j++) {
    var p = REGRAS_FIN[j];
    if ((!p[2] || p[2] === sinal) && p[0].test(txt)) return { cat: p[1], origem: 'padrao' };
  }
  return { cat: '', origem: '' };
}

/* ---------- planilha "BPO" ---------- */
function abaBpo_(ss) {
  var a = ss.getSheetByName('BPO');
  if (a) return a;
  a = ss.insertSheet('BPO');
  a.getRange(1, 1, 1, CAB_BPO.length).setValues([CAB_BPO]).setFontWeight('bold').setBackground('#0f6b55').setFontColor('#ffffff');
  a.setFrozenRows(1); a.getRange('D:D').setNumberFormat('@');
  return a;
}
function bpoLinhas_() {
  var d = abaBpo_(planilha_()).getDataRange().getValues(), o = [];
  for (var i = 1; i < d.length; i++) {
    if (!String(d[i][0]).trim() || !String(d[i][1]).trim()) continue;
    var ini = d[i][3] instanceof Date ? Utilities.formatDate(d[i][3], Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(d[i][3] || '').trim();
    o.push({ lin: i + 1, contabilidade: String(d[i][0]).trim(), cliente: String(d[i][1]).trim(), ativo: sn_(d[i][2], false), inicio: ini, operador: String(d[i][4] || ''),
      obs: String(d[i][5] || ''), ultimoOfx: d[i][6] instanceof Date ? d[i][6].toISOString() : '', pendencias: Number(d[i][7] || 0), saldo: Number(d[i][8] || 0) });
  }
  return o;
}
function bpoDe_(contab, cliente) {
  return bpoLinhas_().filter(function (b) { return normal_(b.contabilidade) === normal_(contab) && normal_(b.cliente) === normal_(cliente); })[0] || null;
}
// o agente pergunta toda noite; ele manda o nome do cliente sem a subpasta ("COMERCIAL 59" vale para "COMERCIAL 59 / MATRIZ")
function bpoDoAgente_(contab, cliente) {
  var b = bpoLinhas_().filter(function (x) { return x.ativo && normal_(x.contabilidade) === normal_(contab) && normal_(x.cliente.split(' / ')[0]) === normal_(cliente); });
  if (!b.length) return { ativo: false };
  return { ativo: true, inicio: b.map(function (x) { return x.inicio; }).sort()[0] || '', empresas: b.map(function (x) { return { cliente: x.cliente, inicio: x.inicio }; }) };
}

/* ---------- acesso ---------- */
// nivel: 'ver' (contabilidade e empresa), 'responder' (empresa e operador), 'operar' (só operador)
function finAcesso_(token, contab, cliente, nivel) {
  var s = sessao_(token), adm = s.contabs.indexOf('*') >= 0;
  if (adm) return { s: s, operador: true };
  if (s.empresa) {
    if (normal_(s.empresa.contabilidade) !== normal_(contab) || normal_(s.empresa.cliente) !== normal_(cliente)) throw new Error('Sem acesso a esta empresa.');
    if (nivel === 'operar') throw new Error('Só o operador do BPO pode fazer isso.');
    return { s: s, empresa: true };
  }
  if (nivel !== 'ver' || !podeVer_(s, contab)) throw new Error('Sem acesso a esta empresa.');
  return { s: s, contabilidade: true };
}

/* ---------- Drive ---------- */
function finRaiz_() {
  var props = PropertiesService.getScriptProperties(), id = props.getProperty('FIN_ID');
  if (id) { try { var f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) { } }
  var p = filha_(filha_(pastaRaiz_(), PASTA_PORTAL), '_financeiro'); props.setProperty('FIN_ID', p.getId()); return p;
}
function finPasta_(contab, cliente) { return filha_(filha_(finRaiz_(), contab), cliente); }
function arqJson_(pasta, nome) { var it = pasta.getFilesByName(nome); while (it.hasNext()) { var f = it.next(); if (!f.isTrashed()) return f; } return null; }
function lerJson_(pasta, nome, padrao) { var f = arqJson_(pasta, nome); if (!f) return padrao; try { return JSON.parse(f.getBlob().getDataAsString('UTF-8')); } catch (e) { return padrao; } }
function gravarJson_(pasta, nome, obj) { var f = arqJson_(pasta, nome), t = JSON.stringify(obj); if (f) f.setContent(t); else pasta.createFile(nome, t, 'application/json'); }
function finIdConta_(c) { return [c.banco || 'banco', c.agencia || '0', c.conta || '0'].join('-').replace(/[^\w\-]/g, ''); }

var BANCOS_BR = { '001': 'Banco do Brasil', '003': 'Banco da Amazônia', '004': 'Banco do Nordeste', '033': 'Santander', '041': 'Banrisul', '070': 'BRB', '077': 'Inter', '104': 'Caixa',
  '136': 'Unicred', '197': 'Stone', '208': 'BTG Pactual', '212': 'Original', '237': 'Bradesco', '260': 'Nubank', '290': 'PagBank', '323': 'Mercado Pago', '336': 'C6 Bank',
  '341': 'Itaú', '380': 'PicPay', '403': 'Cora', '422': 'Safra', '748': 'Sicredi', '756': 'Sicoob', '085': 'Ailos', '133': 'Cresol', '274': 'Grafeno', '332': 'Acesso', '637': 'Sofisa' };

/* ---------- carteira (operador) ---------- */
function portalFinPlano(token) { sessao_(token); return { plano: PLANO_FIN, bancos: BANCOS_BR }; }

function portalFinCarteira(token) {
  var s = sessao_(token), adm = s.contabs.indexOf('*') >= 0;
  var L = bpoLinhas_().filter(function (b) { return adm || podeVer_(s, b.contabilidade); });
  var usu = abaUsuarios_(planilha_()).getDataRange().getValues(), logins = {};
  for (var i = 1; i < usu.length; i++) if (usu[i][7]) logins[normal_(String(usu[i][7]).replace(/\s*\|\s*/, '|'))] = String(usu[i][0]);
  L.forEach(function (b) { b.login = logins[normal_(b.contabilidade + '|' + b.cliente)] || ''; delete b.lin; });
  return { carteira: L, operador: adm, plano: PLANO_FIN };
}
function portalFinSalvarBpo(token, b) {
  admin_(token);
  var contab = String(b.contabilidade || '').trim(), cliente = String(b.cliente || '').trim();
  if (!contab || !cliente) throw new Error('Escolha a contabilidade e o cliente.');
  if (b.inicio && !/^\d{4}-\d{2}-\d{2}$/.test(b.inicio)) throw new Error('Data de início inválida.');
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var aba = abaBpo_(planilha_()), x = bpoDe_(contab, cliente), lin = x ? x.lin : Math.max(aba.getLastRow(), 1) + 1;
    aba.getRange(lin, 4).setNumberFormat('@');
    aba.getRange(lin, 1, 1, 6).setValues([[contab, cliente, b.ativo ? 'S' : 'N', b.inicio || '', String(b.operador || ''), String(b.obs || '')]]);
  } finally { lock.releaseLock(); }
  return portalFinCarteira(token);
}
// cria/atualiza o login da empresa (vê só o financeiro dela)
function portalFinLoginEmpresa(token, u) {
  admin_(token);
  var login = String(u.login || '').trim().toLowerCase();
  if (!/^[a-z0-9._@-]{3,40}$/.test(login)) throw new Error('Login: use de 3 a 40 letras, números, ponto, hífen ou @ (sem espaço).');
  if (u.senha && String(u.senha).length < 6) throw new Error('A senha precisa ter pelo menos 6 caracteres.');
  var emp = String(u.contabilidade || '').trim() + ' | ' + String(u.cliente || '').trim();
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var aba = abaUsuarios_(planilha_()), d = aba.getDataRange().getValues(), lin = -1;
    if (!String(aba.getRange(1, 8).getValue())) aba.getRange(1, 8).setValue(CAB_USU[7]).setFontWeight('bold').setBackground('#0f6b55').setFontColor('#ffffff');
    for (var i = 1; i < d.length; i++) {
      var l = String(d[i][0]).trim().toLowerCase();
      if (l === login) { if (normal_(String(d[i][7] || '').replace(/\s*\|\s*/, '|')) !== normal_(emp.replace(/\s*\|\s*/, '|'))) throw new Error('Já existe o login "' + login + '" para outro uso.'); lin = i + 1; }
    }
    if (lin < 0 && !u.senha) throw new Error('Informe a senha do login novo.');
    if (lin < 0) lin = Math.max(aba.getLastRow(), 1) + 1;
    var hash = lin <= d.length ? String(d[lin - 1][4] || '') : '';
    if (u.senha) { var sal = Utilities.getUuid().replace(/-/g, '').slice(0, 16); hash = sal + '$' + hashSenha_(sal, String(u.senha)); }
    aba.getRange(lin, 1, 1, 8).setValues([[login, String(u.nome || login), '', '', hash, u.ativo === false ? 'N' : 'S', lin <= d.length ? d[lin - 1][6] : '', emp]]);
  } finally { lock.releaseLock(); }
  return portalFinCarteira(token);
}

/* ---------- dados de um cliente ---------- */
// mes = 'AAAA-MM' (vazio = o mais recente com extrato)
function portalFinCliente(token, contab, cliente, mes) {
  var ac = finAcesso_(token, contab, cliente, 'ver');
  var bpo = bpoDe_(contab, cliente);
  if (!bpo && !ac.operador) throw new Error('Esta empresa não está no BPO.');
  var pasta = finPasta_(contab, cliente), ind = lerJson_(pasta, 'indice.json', { contas: {}, meses: [] });
  var meses = (ind.meses || []).slice().sort().reverse();
  var hoje = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
  if (!mes || !/^\d{4}-\d{2}$/.test(mes)) mes = meses.indexOf(hoje) >= 0 ? hoje : (meses.filter(function (m) { return m <= hoje; })[0] || meses[0] || hoje);
  var contas = {};
  Object.keys(ind.contas || {}).forEach(function (id) {
    var pc = existente_(existente_(pasta, 'contas'), id);
    contas[id] = pc ? lerJson_(pc, mes + '.json', null) : null;
  });
  // pendências abertas de todos os meses (para a fila), sem carregar meses inteiros duas vezes
  var pend = [];
  meses.slice(0, 6).forEach(function (m) {
    Object.keys(ind.contas || {}).forEach(function (id) {
      var d = m === mes ? contas[id] : (function () { var pc = existente_(existente_(pasta, 'contas'), id); return pc ? lerJson_(pc, m + '.json', null) : null; })();
      (d && d.trans || []).forEach(function (t) { if (t.st && t.st !== 'ok') pend.push({ conta: id, mes: m, t: t }); });
    });
  });
  return { bpo: bpo ? { ativo: bpo.ativo, inicio: bpo.inicio, operador: bpo.operador } : null, indice: ind, meses: meses, mes: mes, contas: contas,
    pendencias: pend, regras: ac.operador ? lerJson_(pasta, 'regras.json', []) : [], plano: PLANO_FIN, papel: ac.operador ? 'operador' : (ac.empresa ? 'empresa' : 'contabilidade') };
}

/* ---------- importação do OFX (lido no navegador, conferido aqui) ---------- */
function portalFinImportar(token, contab, cliente, ofx) {
  finAcesso_(token, contab, cliente, 'operar');
  if (!ofx || !Array.isArray(ofx.trans)) throw new Error('Arquivo OFX sem lançamentos.');
  var conta = { banco: String(ofx.banco || '').replace(/\D/g, '').slice(-3).padStart(3, '0'), agencia: String(ofx.agencia || '').trim(), conta: String(ofx.conta || '').trim() };
  conta.nome = BANCOS_BR[conta.banco] || String(ofx.bancoNome || ('Banco ' + conta.banco));
  var id = finIdConta_(conta), pasta = finPasta_(contab, cliente), regras = lerJson_(pasta, 'regras.json', []);
  var lock = LockService.getScriptLock(); lock.waitLock(60000);
  var res = { conta: conta.nome + ' ag ' + conta.agencia + ' cc ' + conta.conta, novos: 0, repetidos: 0, pendentes: 0, meses: [] };
  try {
    try { if (ofx.texto) filha_(pasta, 'ofx').createFile(Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd_HHmm') + '_' + String(ofx.arquivo || 'extrato.ofx').replace(/[\\\/:*?"<>|]/g, '-'), String(ofx.texto), 'text/plain'); } catch (e) { }
    var porMes = {};
    ofx.trans.forEach(function (t, i) {
      var data = String(t.data || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return;
      var valor = Math.round(Number(t.valor) * 100) / 100; if (!isFinite(valor) || !valor) return;
      var tid = String(t.fitid || '').trim() || (data + '_' + valor + '_' + finChave_(t.desc).slice(0, 20) + '_' + i);
      (porMes[data.slice(0, 7)] = porMes[data.slice(0, 7)] || []).push({ id: tid, data: data, valor: valor, desc: String(t.desc || '').slice(0, 200), doc: String(t.doc || '').slice(0, 40) });
    });
    var pc = filha_(filha_(pasta, 'contas'), id);
    Object.keys(porMes).sort().forEach(function (m) {
      var d = lerJson_(pc, m + '.json', { conta: id, mes: m, trans: [] }), ja = {};
      d.trans.forEach(function (t) { ja[t.id] = 1; });
      porMes[m].forEach(function (t) {
        if (ja[t.id]) { res.repetidos++; return; }
        var c = finCategorizar_(t, regras);
        t.cat = c.cat; t.orig = c.origem; t.st = c.cat ? 'ok' : 'pend';
        if (!c.cat) res.pendentes++;
        d.trans.push(t); ja[t.id] = 1; res.novos++;
      });
      d.trans.sort(function (a, b) { return a.data < b.data ? -1 : a.data > b.data ? 1 : 0; });
      gravarJson_(pc, m + '.json', d); res.meses.push(m);
    });
    var ind = lerJson_(pasta, 'indice.json', { contas: {}, meses: [] });
    var ci = ind.contas[id] || {}; ci.banco = conta.banco; ci.nome = conta.nome; ci.agencia = conta.agencia; ci.conta = conta.conta;
    if (ofx.saldo != null && ofx.dataSaldo && (!ci.dataSaldo || String(ofx.dataSaldo) >= ci.dataSaldo)) { ci.saldo = Number(ofx.saldo); ci.dataSaldo = String(ofx.dataSaldo); }
    ci.ultimaImportacao = new Date().toISOString(); ind.contas[id] = ci;
    res.meses.forEach(function (m) { if (ind.meses.indexOf(m) < 0) ind.meses.push(m); }); ind.meses.sort();
    ind.ultimoOfx = ci.ultimaImportacao;
    gravarJson_(pasta, 'indice.json', ind);
  } finally { lock.releaseLock(); }
  finAtualizarPlanilha_(contab, cliente);
  return res;
}

// conta pendências e saldo e grava na aba BPO (visão da carteira)
function finAtualizarPlanilha_(contab, cliente) {
  try {
    var pasta = finPasta_(contab, cliente), ind = lerJson_(pasta, 'indice.json', { contas: {}, meses: [] }), pend = 0, saldo = 0;
    Object.keys(ind.contas).forEach(function (id) {
      saldo += Number(ind.contas[id].saldo || 0);
      var pc = existente_(existente_(pasta, 'contas'), id);
      (ind.meses || []).slice(-6).forEach(function (m) { var d = pc ? lerJson_(pc, m + '.json', null) : null; (d && d.trans || []).forEach(function (t) { if (t.st && t.st !== 'ok') pend++; }); });
    });
    var x = bpoDe_(contab, cliente); if (!x) return;
    abaBpo_(planilha_()).getRange(x.lin, 7, 1, 4).setValues([[ind.ultimoOfx ? new Date(ind.ultimoOfx) : '', pend, Math.round(saldo * 100) / 100, new Date()]]);
  } catch (e) { }
}

function finAlterar_(contab, cliente, conta, mes, fn) {
  var pasta = finPasta_(contab, cliente), pc = existente_(existente_(pasta, 'contas'), conta);
  if (!pc) throw new Error('Conta não encontrada.');
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try { var d = lerJson_(pc, mes + '.json', null); if (!d) throw new Error('Mês não encontrado.'); var r = fn(d, pasta); gravarJson_(pc, mes + '.json', d); return r; }
  finally { lock.releaseLock(); }
}

// operador define a categoria; com "regra", vale para os próximos lançamentos parecidos (e os pendentes deste mês)
function portalFinCategorizar(token, contab, cliente, conta, mes, ids, cat, criarRegra) {
  finAcesso_(token, contab, cliente, 'operar');
  if (!planoFin_()[cat]) throw new Error('Categoria inválida.');
  ids = [].concat(ids || []);
  var n = finAlterar_(contab, cliente, conta, mes, function (d, pasta) {
    var alvo = d.trans.filter(function (t) { return ids.indexOf(t.id) >= 0; }), extra = 0;
    alvo.forEach(function (t) { t.cat = cat; t.orig = 'manual'; t.st = 'ok'; });
    if (criarRegra && alvo.length) {
      var regras = lerJson_(pasta, 'regras.json', []), ch = finChave_(alvo[0].desc), sinal = alvo[0].valor < 0 ? 'D' : 'C';
      if (ch.length >= 4) {
        regras = regras.filter(function (r) { return !(r.chave === ch && r.sinal === sinal); });
        regras.unshift({ chave: ch, sinal: sinal, cat: cat, criada: new Date().toISOString() });
        gravarJson_(pasta, 'regras.json', regras.slice(0, 500));
        d.trans.forEach(function (t) { if (t.st === 'pend' && finCategorizar_(t, regras).cat === cat && finCategorizar_(t, regras).origem === 'regra') { t.cat = cat; t.orig = 'regra'; t.st = 'ok'; extra++; } });
      }
    }
    return alvo.length + extra;
  });
  finAtualizarPlanilha_(contab, cliente);
  return { ok: true, alterados: n };
}
// operador pede para a empresa justificar
function portalFinSolicitar(token, contab, cliente, conta, mes, ids, pergunta) {
  finAcesso_(token, contab, cliente, 'operar');
  ids = [].concat(ids || []);
  finAlterar_(contab, cliente, conta, mes, function (d) {
    d.trans.forEach(function (t) { if (ids.indexOf(t.id) >= 0 && t.st !== 'ok') { t.st = 'cliente'; t.pergunta = String(pergunta || '').slice(0, 300); } });
  });
  return { ok: true };
}
// empresa (ou operador) responde; anexo = { nome, tipo, base64 } até 5 MB
function portalFinJustificar(token, contab, cliente, conta, mes, id, texto, anexo) {
  var ac = finAcesso_(token, contab, cliente, 'responder');
  if (!String(texto || '').trim() && !anexo) throw new Error('Escreva a justificativa ou anexe o comprovante.');
  var anexoId = '';
  if (anexo && anexo.base64) {
    var bytes = Utilities.base64Decode(anexo.base64);
    if (bytes.length > 5 * 1024 * 1024) throw new Error('O comprovante pode ter no máximo 5 MB.');
    var nome = mes + '_' + String(id).replace(/[^\w\-]/g, '').slice(0, 30) + '_' + String(anexo.nome || 'comprovante').replace(/[\\\/:*?"<>|]/g, '-');
    anexoId = filha_(finPasta_(contab, cliente), 'anexos').createFile(Utilities.newBlob(bytes, anexo.tipo || 'application/octet-stream', nome)).getId();
  }
  finAlterar_(contab, cliente, conta, mes, function (d) {
    var t = d.trans.filter(function (x) { return x.id === id; })[0]; if (!t) throw new Error('Lançamento não encontrado.');
    t.just = { texto: String(texto || '').slice(0, 1000), anexo: anexoId || (t.just && t.just.anexo) || '', anexoNome: anexo ? String(anexo.nome || '') : ((t.just && t.just.anexoNome) || ''), quem: ac.s.nome, quando: new Date().toISOString() };
    if (t.st !== 'ok') t.st = 'just';
  });
  finAtualizarPlanilha_(contab, cliente);
  return { ok: true };
}
function portalFinAnexo(token, contab, cliente, anexoId) {
  finAcesso_(token, contab, cliente, 'ver');
  var f = DriveApp.getFileById(anexoId), pai = f.getParents();
  var ok = false; while (pai.hasNext()) { if (pai.next().getId() === filha_(finPasta_(contab, cliente), 'anexos').getId()) ok = true; }
  if (!ok) throw new Error('Arquivo não pertence a esta empresa.');
  var b = f.getBlob(); return { nome: f.getName(), tipo: b.getContentType(), base64: Utilities.base64Encode(b.getBytes()) };
}
function portalFinRemoverRegra(token, contab, cliente, chave, sinal) {
  finAcesso_(token, contab, cliente, 'operar');
  var pasta = finPasta_(contab, cliente), regras = lerJson_(pasta, 'regras.json', []);
  gravarJson_(pasta, 'regras.json', regras.filter(function (r) { return !(r.chave === chave && r.sinal === sinal); }));
  return { ok: true };
}
