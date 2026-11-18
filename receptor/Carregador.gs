/**
 * FAROL CONTÁBIL — CARREGADOR DO RECEPTOR (CPUSIS)
 *
 * Este é o ÚNICO código que fica no Apps Script. Ele não muda mais.
 * O receptor de verdade (receptor/Codigo.gs) vem do GitHub:
 *     https://github.com/CPUSISCODE/farol.contabil
 * A cada 15 minutos ele confere o versao.json do GitHub; se houver receptor novo, baixa, testa,
 * guarda uma cópia no Drive (_PORTAL_DADOS/receptor) e passa a usar na hora — mesma URL /exec,
 * sem "Nova implantação". Se o GitHub estiver fora do ar, continua com a última cópia boa do Drive.
 * As senhas ficam em Configurações do projeto > Propriedades do script (SENHA e SENHA_BACKUP).
 */
var FAROL_GIT = 'https://raw.githubusercontent.com/CPUSISCODE/farol.contabil/main/';
var FAROL_RAIZ_ID = '1VXlk5Ungt-qFSFNbqCiwPrZtk1ksbK2V';   // ARQUIVOS FISCAIS CONTABEIS
var FAROL_EXPORTA = ['doGet', 'doPost', 'INSTALAR_FAROL', 'ATUALIZAR_AGORA', 'TESTAR_E_AUTORIZAR', 'CORRIGIR_PAINEL', 'REFAZER_PAINEL'];
var FAROL_APP = null;

/* ---------- entradas (o Google chama estas) ---------- */
function doGet(e) { return app_().doGet(e); }
function doPost(e) {
  try { return app_().doPost(e); }
  catch (err) { return ContentService.createTextOutput(JSON.stringify({ ok: false, erro: 'Receptor indisponível: ' + err.message })).setMimeType(ContentService.MimeType.JSON); }
}
// rodar pelo editor
function INSTALAR_FAROL() { farolAtualizarReceptor_(true); app_().INSTALAR_FAROL(); }
function ATUALIZAR_AGORA() { Logger.log(JSON.stringify(farolAtualizarReceptor_(true))); FAROL_APP = null; Logger.log(JSON.stringify(app_().ATUALIZAR_AGORA())); }
function TESTAR_E_AUTORIZAR() { app_().TESTAR_E_AUTORIZAR(); }
function CORRIGIR_PAINEL() { app_().CORRIGIR_PAINEL(); }
function REFAZER_PAINEL() { app_().REFAZER_PAINEL(); }
// gatilho de 15 em 15 minutos
function VERIFICAR_ATUALIZACAO() {
  try { farolAtualizarReceptor_(false); } catch (e) { farolLog_('receptor', '', '', 'ERRO: ' + e.message); }
  FAROL_APP = null;
  var a = app_(); if (a.VERIFICAR_ATUALIZACAO) a.VERIFICAR_ATUALIZACAO(); else a.ATUALIZAR_AGORA();
}

/* ---------- carrega o receptor: cache (rápido) > cópia no Drive > GitHub ---------- */
function app_() {
  if (FAROL_APP) return FAROL_APP;
  var props = PropertiesService.getScriptProperties(), cache = CacheService.getScriptCache();
  var ver = props.getProperty('FAROL_RECEPTOR') || '', codigo = ver ? farolCacheLer_(cache, 'farol_cod_' + ver) : null;
  if (!codigo) {
    var id = props.getProperty('FAROL_RECEPTOR_ID');
    if (id) { try { codigo = DriveApp.getFileById(id).getBlob().getDataAsString('UTF-8'); } catch (e) { codigo = null; } }
    if (!codigo) { farolAtualizarReceptor_(true); return app_(); }
    farolCacheGravar_(cache, 'farol_cod_' + ver, codigo);
  }
  FAROL_APP = farolMontar_(codigo);
  return FAROL_APP;
}
function farolMontar_(codigo) {
  var fim = '\nreturn {' + FAROL_EXPORTA.concat(['VERIFICAR_ATUALIZACAO', 'VERSAO']).map(function (n) { return n + ': (typeof ' + n + " !== 'undefined' ? " + n + ' : undefined)'; }).join(', ') + '};';
  var a = new Function(codigo + fim)();
  if (typeof a.doGet !== 'function' || typeof a.doPost !== 'function') throw new Error('receptor sem doGet/doPost');
  return a;
}

/* ---------- baixa receptor novo do GitHub (testa antes de usar) ---------- */
function farolAtualizarReceptor_(forcar) {
  var props = PropertiesService.getScriptProperties();
  var v = JSON.parse(farolBaixar_('versao.json').getDataAsString('UTF-8'));
  var atual = props.getProperty('FAROL_RECEPTOR') || '';
  if (!v.receptor || (atual === String(v.receptor) && props.getProperty('FAROL_RECEPTOR_ID'))) return { receptor: atual, novo: false };
  var codigo = farolBaixar_('receptor/Codigo.gs').getDataAsString('UTF-8');
  if (codigo.indexOf("var VERSAO = '" + v.receptor + "'") < 0) throw new Error('Codigo.gs do GitHub não é a versão ' + v.receptor);
  var a = farolMontar_(codigo);                          // testa: se não montar, continua na versão atual
  if (String(a.VERSAO) !== String(v.receptor)) throw new Error('versão montada diferente: ' + a.VERSAO);
  // guarda a cópia no Drive (_PORTAL_DADOS/receptor/Codigo.gs) — é dela que o receptor roda se o GitHub cair
  var pasta = farolPasta_(farolPasta_(DriveApp.getFolderById(FAROL_RAIZ_ID), '_PORTAL_DADOS'), 'receptor');
  var nome = 'Codigo.gs', it = pasta.getFilesByName(nome), f = null;
  while (it.hasNext()) { var x = it.next(); if (!x.isTrashed()) { f = x; break; } }
  if (f) {
    try { pasta.createFile('Codigo_' + (atual || 'anterior') + '.gs', f.getBlob().getDataAsString('UTF-8'), 'text/plain'); } catch (e) { }
    f.setContent(codigo);
  } else f = pasta.createFile(nome, codigo, 'text/plain');
  farolCacheGravar_(CacheService.getScriptCache(), 'farol_cod_' + v.receptor, codigo);
  props.setProperty('FAROL_RECEPTOR_ID', f.getId());
  props.setProperty('FAROL_RECEPTOR', String(v.receptor));
  FAROL_APP = a;
  farolLog_('receptor', atual, v.receptor, 'OK (já está valendo no endereço /exec)');
  return { receptor: v.receptor, novo: true };
}

/* ---------- utilidades do carregador ---------- */
function farolBaixar_(caminho) {
  var r = UrlFetchApp.fetch(FAROL_GIT + caminho + '?t=' + Date.now(), { muteHttpExceptions: true, headers: { 'Cache-Control': 'no-cache' } });
  if (r.getResponseCode() !== 200) throw new Error('GitHub ' + caminho + ': HTTP ' + r.getResponseCode());
  return r.getBlob();
}
function farolPasta_(pai, nome) { var it = pai.getFoldersByName(nome); while (it.hasNext()) { var f = it.next(); if (!f.isTrashed()) return f; } return pai.createFolder(nome); }
function farolCacheGravar_(cache, chave, txt) {
  try { var n = Math.ceil(txt.length / 90000), o = {}; for (var i = 0; i < n; i++) o[chave + '_' + i] = txt.slice(i * 90000, (i + 1) * 90000); o[chave] = String(n); cache.putAll(o, 21600); } catch (e) { }
}
function farolCacheLer_(cache, chave) {
  var n = Number(cache.get(chave) || 0); if (!n) return null;
  var ks = []; for (var i = 0; i < n; i++) ks.push(chave + '_' + i);
  var g = cache.getAll(ks), s = ''; for (var j = 0; j < n; j++) { if (g[ks[j]] == null) return null; s += g[ks[j]]; }
  return s;
}
function farolLog_(oque, de, para, resultado) {
  try {
    var ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('PLANILHA_ID')), a = ss.getSheetByName('Atualizações');
    if (!a) { a = ss.insertSheet('Atualizações'); a.appendRow(['Data/hora', 'O quê', 'De', 'Para', 'Resultado']); a.setFrozenRows(1); }
    a.appendRow([new Date(), oque, "'" + (de || ''), "'" + (para || ''), resultado]);
  } catch (e) { }
}
