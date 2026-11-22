// Farol Contábil — robô do Avante Web (CPUSIS)
// Entra pelo Painel do Parceiro, abre cada cliente pelo CNPJ e baixa:
//   - Fiscal → Gestão de Documentos: ZIP de XML por tipo de documento e mês
//   - Relatórios → Financeiro: Lançamentos Financeiros e Contas a Receber/Pagar (Excel)
// e manda tudo para a pasta do cliente no Drive pelo receptor do Farol.
// SÓ CONSULTA E BAIXA: nunca clica em salvar, excluir, enviar ou no menu "Ações".
//
// Uso:  node robo.js                      -> mês atual (e o anterior até o dia 10)
//       node robo.js --meses 2026-09,2026-10
//       node robo.js --listar             -> abre o navegador, entra no painel e grava empresas.json
//       node robo.js --visivel            -> mostra o navegador (para validar o código de 2 fatores)
//       node robo.js --so-baixar          -> baixa na pasta "saida" e NÃO envia ao Drive (teste)
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { chromium } = require('playwright-core');

const BASE = __dirname;
const SITE = process.env.FAROL_TESTE_SITE || 'https://www.avanteweb.com.br/sistema';   // FAROL_TESTE_SITE só para teste com Avante simulado
const PAINEL = SITE + '/pages/privado/indexParceiroPrincipal';
const URL_GESTAO = SITE + '/pages/privado/fiscal/gestao/gestaoDocumentos';
const URL_LANC = SITE + '/pages/privado/financeiro/relatorios/lancamentosFinanceiros';
const URL_CONTAS = SITE + '/pages/privado/financeiro/relatorios/titulosReceberVencimentos';
const TIPOS_PADRAO = ['NFe', 'NFCe', 'CTe', 'MDFe', 'NFe Entradas'];

const args = process.argv.slice(2);
const opt = (n) => args.includes(n);
const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const CFG = JSON.parse(fs.readFileSync(path.join(BASE, 'config.json'), 'utf8'));
const SENHA_AVANTE = process.env.FAROL_AVANTE_SENHA || '';
const pasta = (p) => { fs.mkdirSync(p, { recursive: true }); return p; };
const LOGS = pasta(path.join(BASE, 'logs')), TEMP = pasta(path.join(BASE, 'temp'));
const ARQ_LOG = path.join(LOGS, 'robo_' + new Date().toISOString().slice(0, 7) + '.log');
const ARQ_ESTADO = path.join(BASE, 'estado.json');
function log(m) { const l = new Date().toLocaleString('pt-BR') + '  ' + m; console.log(l); try { fs.appendFileSync(ARQ_LOG, l + '\n'); } catch (e) { } }
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const dmy = (d) => String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const nomeSeguro = (s) => String(s).replace(/[\\/:*?"<>|]/g, '-').trim();

function mesesAlvo() {
  const lista = val('--meses');
  if (lista) return lista.split(',').map((s) => s.trim()).filter((s) => /^\d{4}-\d{2}$/.test(s));
  const h = new Date(), atual = h.toISOString().slice(0, 7);
  const ant = new Date(h.getFullYear(), h.getMonth() - 1, 1);
  const antS = ant.getFullYear() + '-' + String(ant.getMonth() + 1).padStart(2, '0');
  return h.getDate() <= (CFG.diasMesAnterior || 10) ? [antS, atual] : [atual];
}
function limitesMes(m) { const [a, mm] = m.split('-').map(Number); return [new Date(a, mm - 1, 1), new Date(a, mm, 0)]; }

// ---------------------------------------------------------------- receptor do Farol (Google)
async function receptor(obj) {
  const r = await fetch(CFG.receptorUrl, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ ...obj, senha: CFG.senha }), redirect: 'follow' });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { throw new Error('receptor respondeu ' + r.status + ': ' + t.slice(0, 120)); }
  if (j.ok === false) throw new Error('receptor: ' + (j.erro || 'erro'));
  return j;
}
async function enviar(emp, mes, arquivo, nome, destino, tipo) {
  const buf = fs.readFileSync(arquivo), [a, m] = mes.split('-').map(Number);
  for (let t = 1; ; t++) {
    try {
      const ini = await receptor({ acao: 'iniciar', destino, contabilidade: emp.contabilidade, cliente: emp.cliente, subpasta: emp.subpasta || '', ano: a, mes: m, arquivo: nome, tamanho: buf.length, tipo });
      const r = await fetch(ini.uploadUrl, { method: 'PUT', headers: { 'Content-Type': tipo }, body: buf });
      if (r.status >= 300) throw new Error('Drive respondeu ' + r.status);
      return ini;
    } catch (e) { if (t >= 3) throw e; log('   tentativa ' + t + ' falhou (' + e.message + '); de novo em 30s'); await esperar(30000); }
  }
}
async function avisar(situacao, mensagem, emp, mes) {   // registra no painel do portal (aba de envios), como o agente faz
  try {
    const [a, m] = (mes || new Date().toISOString().slice(0, 7)).split('-').map(Number);
    await receptor({ acao: 'concluir', contabilidade: emp.contabilidade, cliente: emp.cliente, subpasta: emp.subpasta || '', cnpj: emp.cnpj, ano: a, mes: m,
      arquivo: 'Avante Web (robô)', situacao, maquina: require('os').hostname(), versao: 'robo-avante-' + CFG.versao, mensagem: String(mensagem).slice(0, 500) });
  } catch (e) { log('   (não consegui avisar o portal: ' + e.message + ')'); }
}

// ---------------------------------------------------------------- navegador
async function abrir(visivel) {
  return chromium.launchPersistentContext(pasta(path.join(BASE, 'perfil')), {
    ...(process.env.FAROL_NAVEGADOR ? { executablePath: process.env.FAROL_NAVEGADOR } : { channel: 'msedge' }), headless: !visivel, acceptDownloads: true, viewport: { width: 1366, height: 860 }, locale: 'pt-BR', timezoneId: 'America/Rio_Branco',
  });
}
async function ajaxQuieto(page) { try { await page.waitForLoadState('networkidle', { timeout: 20000 }); } catch (e) { } await esperar(600); }
// entra no painel; se pedir login, preenche; se pedir o código de 2 fatores, só segue com o navegador visível
async function entrarNoPainel(page, visivel) {
  await page.goto(PAINEL, { waitUntil: 'domcontentloaded' }); await ajaxQuieto(page);
  if (page.url().includes('indexParceiroPrincipal')) return;
  const email = page.locator('input[type="email"], input[id*="mail" i], input[name*="mail" i]').filter({ visible: true }).first();
  const senha = page.locator('input[type="password"]').filter({ visible: true }).first();
  if (await email.count() && await senha.count()) {
    if (!CFG.usuarioAvante || !SENHA_AVANTE) throw new Error('login do Avante não configurado');
    await email.fill(CFG.usuarioAvante); await senha.fill(SENHA_AVANTE);
    await page.locator('button:has-text("Entrar"), input[type=submit][value*="Entrar" i]').first().click();
    await ajaxQuieto(page);
  }
  if (!page.url().includes('indexParceiroPrincipal')) {
    if (!visivel) throw new Error('o Avante pediu o código de 2 fatores: rode "Configurar robô" (navegador visível) e digite o código uma vez');
    log('Digite o código de 2 fatores no navegador... (até 5 minutos)');
    await page.waitForURL(/indexParceiroPrincipal|privado\/index/, { timeout: 300000 });
    if (!page.url().includes('indexParceiroPrincipal')) { await page.goto(PAINEL); await ajaxQuieto(page); }
  }
}
async function listarEmpresas(page) {
  return page.$$eval('[id="form:listaEmpresas"] tbody tr', (trs) => trs.map((tr) => ({
    nome: tr.children[0] ? tr.children[0].innerText.trim() : '', cnpj: tr.children[1] ? tr.children[1].innerText.trim() : '', plano: tr.children[2] ? tr.children[2].innerText.trim() : '',
  })).filter((e) => /^\d{11,14}$/.test(e.cnpj)));
}
// abre o ambiente do cliente pela seta "Logar" da linha com o CNPJ exato (nunca toca em "Ações")
async function entrarNoCliente(page, cnpj, visivel) {
  await entrarNoPainel(page, visivel);
  const filtro = page.locator('[id="form:listaEmpresas:cpfcnpj:filter"]');
  if (await filtro.count()) { await filtro.fill(cnpj); await filtro.press('Enter'); await ajaxQuieto(page); }
  const linha = page.locator('[id="form:listaEmpresas"] tbody tr').filter({ has: page.locator('td:nth-child(2)', { hasText: new RegExp('^\\s*' + cnpj + '\\s*$') }) });
  const n = await linha.count();
  if (n !== 1) throw new Error(n ? 'mais de uma empresa com o CNPJ ' + cnpj : 'CNPJ ' + cnpj + ' não está no Painel do Parceiro');
  await Promise.all([page.waitForURL(/privado\/index(?!Parceiro)/, { timeout: 60000 }), linha.locator('td:nth-child(4) a').first().click()]);
  await ajaxQuieto(page);
}
async function preencherData(page, id, d) {
  const c = page.locator('[id="' + id + '"]');
  await c.click({ clickCount: 3 }); await c.press('Control+A'); await c.press('Backspace');
  await c.pressSequentially(dmy(d), { delay: 35 }); await c.press('Tab'); await esperar(300);
  const v = await c.inputValue();
  if (v !== dmy(d)) throw new Error('não consegui preencher a data ' + id + ' (ficou "' + v + '")');
}
async function escolher(page, idBase, texto) {   // SelectOneMenu do PrimeFaces
  await page.locator('[id="' + idBase + '_label"]').click();
  const item = page.locator('[id="' + idBase + '_items"] li').filter({ hasText: new RegExp('^\\s*' + texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$') });
  if (!(await item.count())) throw new Error('opção "' + texto + '" não existe em ' + idBase);
  await item.first().click(); await ajaxQuieto(page);
}
// clica e espera o download; se em vez do arquivo aparecer uma mensagem (ex.: nenhum documento), devolve a mensagem
async function baixar(page, botao, destino) {
  const msg = page.locator('.ui-growl-message, .ui-messages-info, .ui-messages-warn, .ui-messages-error').filter({ visible: true });
  const dl = page.waitForEvent('download', { timeout: 180000 }).then((d) => ({ d })).catch(() => ({}));
  await botao.click();
  const aviso = (async () => { for (let i = 0; i < 360; i++) { await esperar(500); if (await msg.count()) return { m: (await msg.first().innerText()).trim() }; } return {}; })();
  const r = await Promise.race([dl, aviso]);
  if (r.d) { await r.d.saveAs(destino); return { ok: true }; }
  const r2 = r.m ? r : await dl;
  if (r2.d) { await r2.d.saveAs(destino); return { ok: true }; }
  return { ok: false, mensagem: r2.m || 'o Avante não gerou o arquivo' };
}

// ---------------------------------------------------------------- um cliente
async function processarCliente(page, emp, meses, estado, visivel) {
  log('== ' + emp.cliente + (emp.subpasta ? ' / ' + emp.subpasta : '') + ' (' + emp.cnpj + ')');
  await entrarNoCliente(page, emp.cnpj, visivel);
  const tipos = emp.tipos || CFG.tipos || TIPOS_PADRAO, saida = pasta(path.join(BASE, 'saida', nomeSeguro(emp.cliente)));
  let erros = 0, enviados = 0;
  for (const mes of meses) {
    const [ini, fim] = limitesMes(mes), mmyyyy = mes.slice(5) + '.' + mes.slice(0, 4);
    // 1) XML de cada tipo de documento
    for (const tipo of tipos) {
      try {
        await page.goto(URL_GESTAO, { waitUntil: 'domcontentloaded' }); await ajaxQuieto(page);
        await preencherData(page, 'form:dataEmissaoInicial_input', ini); await preencherData(page, 'form:dataEmissaoFinal_input', fim);
        await escolher(page, 'form:tipoDocumento', tipo); await escolher(page, 'form:selectFormatoArquivo', 'XML');
        const nome = nomeSeguro(emp.cliente) + ' - Avante ' + tipo + ' ' + mmyyyy + '.zip', arq = path.join(TEMP, nome);
        const r = await baixar(page, page.getByRole('button', { name: /Baixar Documento/i }), arq);
        if (!r.ok) { log('   ' + tipo + ' ' + mmyyyy + ': ' + r.mensagem); continue; }
        const buf = fs.readFileSync(arq), h = sha(buf), chave = emp.cnpj + '|' + tipo + '|' + mes;
        if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) throw new Error('o arquivo baixado não é um ZIP');
        if (opt('--so-baixar')) { fs.copyFileSync(arq, path.join(saida, nome)); log('   ' + tipo + ' ' + mmyyyy + ': baixado (' + Math.round(buf.length / 1024) + ' KB) em saida\\'); continue; }
        if (estado[chave] === h) { log('   ' + tipo + ' ' + mmyyyy + ': sem alteração'); continue; }
        await enviar(emp, mes, arq, nome, 'xml', 'application/zip');
        estado[chave] = h; fs.writeFileSync(ARQ_ESTADO, JSON.stringify(estado, null, 1)); enviados++;
        log('   ' + tipo + ' ' + mmyyyy + ': enviado ao Drive (' + Math.round(buf.length / 1024) + ' KB)');
      } catch (e) { erros++; log('   ERRO ' + tipo + ' ' + mmyyyy + ': ' + e.message); } finally { try { fs.unlinkSync(path.join(TEMP, nomeSeguro(emp.cliente) + ' - Avante ' + tipo + ' ' + mmyyyy + '.zip')); } catch (e) { } }
    }
    // 2) financeiro do mês: lançamentos financeiros (movimento no mês)
    if (CFG.financeiro !== false) {
      try {
        await page.goto(URL_LANC, { waitUntil: 'domcontentloaded' }); await ajaxQuieto(page);
        await preencherData(page, 'form:tabView:dataMovimentoInicial_input', ini); await preencherData(page, 'form:tabView:dataMovimentoFinal_input', fim);
        await page.getByRole('button', { name: /^Consultar$/ }).click(); await ajaxQuieto(page);
        const nome = 'financeiro_lancamentos_' + mes + '.xlsx', arq = path.join(TEMP, nome);
        const r = await baixar(page, page.locator('[id="form:gerarXls"]'), arq);
        if (r.ok) {
          if (opt('--so-baixar')) fs.copyFileSync(arq, path.join(saida, nome)); else await enviar(emp, mes, arq, nome, 'portal', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
          log('   financeiro ' + mmyyyy + ': lançamentos ' + (opt('--so-baixar') ? 'baixados' : 'enviados')); try { fs.unlinkSync(arq); } catch (e) { }
        } else log('   financeiro ' + mmyyyy + ': ' + r.mensagem);
      } catch (e) { erros++; log('   ERRO financeiro ' + mmyyyy + ': ' + e.message); }
    }
  }
  // 3) contas a receber e a pagar (posição de hoje: 1 ano para trás e 1 para frente)
  if (CFG.financeiro !== false) {
    const hoje = new Date(), de = new Date(hoje.getFullYear() - 1, hoje.getMonth(), 1), ate = new Date(hoje.getFullYear() + 1, hoje.getMonth() + 1, 0);
    for (const [rotulo, chave] of [['Contas a Receber', 'receber'], ['Contas a Pagar', 'pagar']]) {
      try {
        await page.goto(URL_CONTAS, { waitUntil: 'domcontentloaded' }); await ajaxQuieto(page);
        await preencherData(page, 'form:tabView:dataInicial_input', de); await preencherData(page, 'form:tabView:dataPagamentoFinal_input', ate);
        await escolher(page, 'form:tabView:tipo', rotulo);
        await page.getByRole('button', { name: /^Consultar$/ }).click(); await ajaxQuieto(page);
        const mesHoje = hoje.toISOString().slice(0, 7), nome = 'financeiro_contas_' + chave + '_' + hoje.toISOString().slice(0, 10) + '.xlsx', arq = path.join(TEMP, nome);
        const r = await baixar(page, page.locator('[id="form:datatable:gerarXls"]'), arq);
        if (r.ok) {
          if (opt('--so-baixar')) fs.copyFileSync(arq, path.join(saida, nome)); else await enviar(emp, mesHoje, arq, nome, 'portal', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
          log('   ' + rotulo.toLowerCase() + ': ' + (opt('--so-baixar') ? 'baixado' : 'enviado')); try { fs.unlinkSync(arq); } catch (e) { }
        } else log('   ' + rotulo.toLowerCase() + ': ' + r.mensagem);
      } catch (e) { erros++; log('   ERRO ' + rotulo.toLowerCase() + ': ' + e.message); }
    }
  }
  return { erros, enviados };
}

// ---------------------------------------------------------------- principal
(async () => {
  const visivel = opt('--visivel') || opt('--listar');
  const trava = path.join(BASE, 'em_execucao.lock');
  try { if (fs.existsSync(trava) && Date.now() - fs.statSync(trava).mtimeMs < 6 * 3600e3) { log('Já existe uma execução em andamento. Saindo.'); process.exit(0); } } catch (e) { }
  fs.writeFileSync(trava, String(process.pid));
  let ctx, codigo = 0;
  try {
    log('===== robô Avante ' + CFG.versao + ' - início =====');
    ctx = await abrir(visivel);
    const page = ctx.pages()[0] || await ctx.newPage();
    page.setDefaultTimeout(45000);
    if (opt('--listar')) {
      await entrarNoPainel(page, true);
      const lista = await listarEmpresas(page);
      fs.writeFileSync(path.join(BASE, 'empresas.json'), JSON.stringify(lista, null, 1));
      log(lista.length + ' empresas no Painel do Parceiro gravadas em empresas.json');
    } else {
      const meses = mesesAlvo(), estado = fs.existsSync(ARQ_ESTADO) ? JSON.parse(fs.readFileSync(ARQ_ESTADO, 'utf8')) : {};
      log('Meses: ' + meses.join(', '));
      for (const emp of (CFG.empresas || []).filter((e) => e.ativo !== false)) {
        try {
          const r = await processarCliente(page, emp, meses, estado, visivel);
          if (r.erros) codigo = 1;
          if (!opt('--so-baixar')) await avisar(r.erros ? 'ERRO' : 'ENVIADO', r.erros ? r.erros + ' erro(s) no robô do Avante - veja o log em ' + LOGS : 'Avante: ' + r.enviados + ' arquivo(s) novo(s)', emp, meses[meses.length - 1]);
        } catch (e) {
          codigo = 1; log('   ERRO no cliente: ' + e.message);
          if (!opt('--so-baixar')) await avisar('ERRO', 'robô do Avante: ' + e.message, emp, meses[meses.length - 1]);
          if (/2 fatores|login do Avante/.test(e.message)) break;   // sem login não adianta seguir
        }
      }
    }
  } catch (e) { codigo = 1; log('ERRO: ' + e.message); }
  finally { try { if (ctx) await ctx.close(); } catch (e) { } try { fs.unlinkSync(trava); } catch (e) { } log('===== fim ====='); }
  process.exit(codigo);
})();
