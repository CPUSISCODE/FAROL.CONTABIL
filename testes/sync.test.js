const vm = require('vm'), fs = require('fs'), crypto = require('crypto');
const props = { SENHA: 'segredo-teste' }, cache = {}, enviados = [];
const folha = (linhas) => ({
  getDataRange: () => ({ getValues: () => linhas.map(l => l.slice()) }),
  getRange: (r, c, nr, nc) => ({ setValues: (v) => { v.forEach((row, i) => row.forEach((x, j) => { linhas[r - 1 + i][c - 1 + j] = x; })); }, getValues: () => linhas.slice(r - 1, r - 1 + nr).map(l => l.slice(c - 1, c - 1 + nc)) }),
  getLastRow: () => linhas.length,
});
const usuarios = [['Login', 'Nome', 'C', 'Nova', 'Hash', 'Ativo', 'Ult', 'Empresa'],
  ['Admin', 'CPUSIS', '*', '', 'abcd$xyz', 'S', '', ''],
  ['elo', 'Elo', 'ELO CONTABIL, OUTRA', 'senha123', '', 'S', '', ''],
  ['merc', 'Mercantil', '', '', 'a$b', 'N', '', 'ELO CONTABIL | MERCANTIL']];
const regimes = [['C', 'Cl', 'R', 'O'], ['ELO CONTABIL', 'CLIENTE A', 'SIMPLES', ''], ['ELO', '', '', '']];
const painel = [new Array(24).fill('h'), ['ELO CONTABIL', 'CLIENTE A', '123', '2026-11', new Date('2026-11-20T05:00:00Z'), 'ENVIADO', 1, 0, 5, 0, 2, 0, 0, 0, 0, 0, 0, 0, 'a.zip', 10, 'PC1', "'2.0", 'ok', 1]];
const hist = [['h'], [new Date(), 'ELO', 'A', "'2026-11", 'ENVIADO', 'a.zip', 10, 'PC1', 'm'], [new Date(), 'ELO', 'B', '2026-10', 'ERRO', '', '', 'PC2', 'x']];
const arquivos = { f1: JSON.stringify({ totais: {}, cnpj: '1' }), f2: '{ruim' };
let cacheArq = null;
const ctx = {
  console, JSON, Date, Math, String, Number, Object, Array, RegExp, Error, isNaN, isFinite, parseInt, parseFloat,
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
  CacheService: { getScriptCache: () => ({ get: k => cache[k] || null, put: (k, v) => { cache[k] = v; }, remove: k => { delete cache[k]; }, getAll: ks => { const o = {}; ks.forEach(k => { if (cache[k]) o[k] = cache[k]; }); return o; } }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
  Utilities: { getUuid: () => crypto.randomUUID(), DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 },
    computeDigest: (a, t) => Array.from(crypto.createHash('sha256').update(t, 'utf8').digest()).map(b => b > 127 ? b - 256 : b),
    base64EncodeWebSafe: s => Buffer.from(s).toString('base64url'), formatDate: () => '2026-11' },
  UrlFetchApp: { fetch: (url, o) => { const b = JSON.parse(o.payload); enviados.push(b); return { getResponseCode: () => 200, getContentText: () => JSON.stringify(b.itens.some(i => i.t === 'estado') ? { ok: true, resumos: [{ k: 'ELO CONTABIL|CLIENTE A||2026-11' }, { k: 'VELHA|SUMIU||2026-01' }] } : { ok: true }) }; } },
  DriveApp: { getFileById: id => ({ getBlob: () => ({ getDataAsString: () => arquivos[id] }) }) },
  Session: { getScriptTimeZone: () => 'America/Rio_Branco' },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('/home/claude/farol.contabil/receptor/Codigo.gs', 'utf8'), ctx);
const ss = { getSheetByName: n => n === 'Histórico' ? folha(hist) : null };
Object.assign(ctx, {
  planilha_: () => ss, abaUsuarios_: () => folha(usuarios), abaRegimes_: () => folha(regimes), abaPainel_: () => folha(painel),
  aparencia_: () => ({ nome: 'Farol' }), logAtualizacao_: (...a) => console.log('LOG', a.join(' | ')),
  arvorePortal_: () => [{ contabilidade: 'ELO CONTABIL', cliente: 'CLIENTE A', subpasta: '', pid: 'p1', arqs: { '2026-11': { id: 'f1', mod: 5 }, '2026-10': { id: 'f2', mod: 6 } } }],
  pastaCache_: () => ({ getFilesByName: () => ({ hasNext: () => !!cacheArq, next: () => cacheArq }), createFile: (n, t) => { cacheArq = { getBlob: () => ({ getDataAsString: () => cacheArq.t }), setContent: x => { cacheArq.t = x; }, t }; } }),
});
const ok = (c, m) => { if (!c) { console.log('FALHOU:', m); process.exitCode = 1; } else console.log('ok -', m); };

const r = vm.runInContext('SINCRONIZAR_BANCO()', ctx);
console.log(JSON.stringify(r));
const it = enviados.flatMap(e => e.itens);
const usu = it.find(i => i.t === 'usuarios').linhas;
ok(enviados.every(e => e.senha === 'segredo-teste'), 'manda a senha do receptor');
ok(usu.length === 3 && usu[0].login === 'admin', 'usuários em minúsculo');
ok(!JSON.stringify(usu).includes('senha123'), 'senha em texto não sai');
ok(/^[0-9a-f]{16}\$[0-9a-f]{64}$/.test(usu[1].senha_hash) && usuarios[2][3] === '' && usuarios[2][4] === usu[1].senha_hash, 'senha nova criptografada e gravada na planilha');
ok(usu[1].contabs.join('|') === 'ELO CONTABIL|OUTRA', 'contabilidades separadas');
ok(usu[2].ativo === false && usu[2].empresa_cliente === 'MERCANTIL', 'empresa do BPO e desativado');
ok(it.find(i => i.t === 'regimes').linhas.length === 1, 'só regimes válidos');
const env = it.find(i => i.t === 'envios').linhas[0];
ok(env.mes === '2026-11' && env.versao === '2.0' && env.dados.nfce === 5 && env.ultimo_contato === '2026-11-20T05:00:00.000Z', 'linha do painel');
const h = it.find(i => i.t === 'historico').linhas;
ok(h.length === 2 && h[0].mes === '2026-11' && props.DB_HIST_LIN === '3', 'histórico novo e marcador');
const res = it.filter(i => i.t === 'resumo');
ok(res.length === 1 && res[0].mes === '2026-11' && res[0].ind && res[0].pid === 'p1', 'resumo com indicadores (o JSON ruim é pulado)');
ok(it.some(i => i.t === 'remover_unidade' && i.cliente === 'SUMIU'), 'cliente que sumiu do Drive sai do banco');
// segunda rodada: nada de resumo novo, histórico não repete
enviados.length = 0; vm.runInContext('SINCRONIZAR_BANCO()', ctx);
const it2 = enviados.flatMap(e => e.itens);
ok(!it2.some(i => i.t === 'resumo') && !it2.some(i => i.t === 'historico'), 'segunda rodada não repete');
// portalInterno: sessão vinda do banco
ctx.portalServidores = (tok) => ({ quem: JSON.parse(cache['s_' + tok]).login });
const pi = vm.runInContext("portalInterno_({ fn: 'portalServidores', sessao: { login: 'admin', contabs: ['*'] }, args: ['x'] })", ctx);
console.log(JSON.stringify(pi));
const pl = vm.runInContext("portalInterno_({ fn: 'portalLogin', args: ['a','b'] })", ctx);
ok(pl.ok === false, 'login não passa pelo repasse');
const pr = vm.runInContext("portalInterno_({ fn: 'eval', args: [] })", ctx);
ok(pr.ok === false, 'função fora da lista recusada');
