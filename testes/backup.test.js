// Teste do BACKUP_BANCO do receptor com Apps Script simulado
const fs = require('fs'), vm = require('vm'), zlib = require('zlib');
let falhas = 0; const ok = (c, m) => { console.log((c ? 'ok - ' : 'FALHOU - ') + m); if (!c) falhas++; };
const props = { SENHA: 'segredo-teste' }, arquivos = [], compart = [];
let horaFake = 3, respostaFake = { ok: true, contagem: { bpo: 1, fin_lancamentos: 2 }, tabelas: { bpo: [{ id: 1 }], fin_lancamentos: [{}, {}] } }, chamadas = [];
const pasta = {
  getId: () => 'P1', isTrashed: () => false, getUrl: () => 'url', setSharing: (a, b) => compart.push(['pasta', a, b]),
  createFile: (blob) => { const f = { nome: blob.nome, criado: new Date(), lixo: false, bytes: blob.bytes, getName() { return this.nome; }, getDateCreated() { return this.criado; }, setTrashed(v) { this.lixo = v; }, setSharing: (a, b) => compart.push(['arq', a, b]) }; arquivos.push(f); return f; },
  getFiles: () => { let i = 0; const l = arquivos.filter(f => !f.lixo); return { hasNext: () => i < l.length, next: () => l[i++] }; },
};
const ctx = {
  console, JSON, Date, Math, Number, String, Object, Array, RegExp, Error,
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = String(v); }, deleteProperty: k => { delete props[k]; } }) },
  Session: { getScriptTimeZone: () => 'America/Rio_Branco' },
  Utilities: {
    formatDate: (d, tz, f) => f === 'H' ? String(horaFake) : f === 'yyyy-MM-dd' ? '2026-11-22' : '2026-11-22_0300',
    newBlob: (txt, tipo, nome) => ({ txt, nome }), gzip: (b, nome) => { const bytes = zlib.gzipSync(b.txt); return { nome, bytes, getBytes: () => bytes }; },
    getUuid: () => 'x', DigestAlgorithm: {}, Charset: {},
  },
  UrlFetchApp: { fetch: (url, o) => { chamadas.push({ url, corpo: JSON.parse(o.payload) }); return { getResponseCode: () => 200, getContentText: () => JSON.stringify(respostaFake) }; } },
  DriveApp: { Access: { PRIVATE: 'PRIVATE' }, Permission: { NONE: 'NONE' }, getFolderById: () => pasta, getRootFolder: () => ({ getFoldersByName: () => ({ hasNext: () => false }), createFolder: () => pasta }) },
  Logger: { log: () => {} }, LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + '/../receptor/Codigo.gs', 'utf8'), ctx);
// 1) fora da janela (meio-dia): não faz nada
horaFake = 12; vm.runInContext('BACKUP_BANCO_NOITE_()', ctx);
ok(chamadas.length === 0, 'fora do horário (12h) não faz cópia');
// 2) às 3h faz a cópia
horaFake = 3; vm.runInContext('BACKUP_BANCO_NOITE_()', ctx);
ok(chamadas.length === 1 && /\/functions\/v1\/backup$/.test(chamadas[0].url), 'às 3h chama a função backup do banco');
ok(chamadas[0].corpo.senha === 'segredo-teste', 'envia a senha do receptor');
ok(arquivos.length === 1 && /^banco_.*\.json\.gz$/.test(arquivos[0].nome), 'grava um arquivo .json.gz');
ok(JSON.parse(zlib.gunzipSync(arquivos[0].bytes).toString()).tabelas.fin_lancamentos.length === 2, 'o arquivo descompactado tem os dados');
ok(compart.some(c => c[0] === 'pasta' && c[1] === 'PRIVATE') && compart.some(c => c[0] === 'arq' && c[1] === 'PRIVATE'), 'pasta e arquivo ficam privados');
ok(JSON.parse(props.BACKUP_BANCO_ULTIMO).contagem.bpo === 1, 'registra o resultado');
// 3) segunda vez na mesma noite: não repete
vm.runInContext('BACKUP_BANCO_NOITE_()', ctx);
ok(chamadas.length === 1, 'não repete na mesma noite');
// 4) apaga só cópias com mais de 30 dias
const velho = pasta.createFile({ nome: 'banco_2026-10-01_0300.json.gz', bytes: Buffer.from('') }); velho.criado = new Date(Date.now() - 40 * 864e5);
const outro = pasta.createFile({ nome: 'outro-arquivo.txt', bytes: Buffer.from('') }); outro.criado = new Date(Date.now() - 400 * 864e5);
vm.runInContext('BACKUP_BANCO()', ctx);
ok(velho.lixo === true, 'apaga cópia com mais de 30 dias');
ok(outro.lixo === false, 'não mexe em outros arquivos da pasta');
ok(arquivos.filter(f => !f.lixo && /^banco_/.test(f.nome)).length === 2, 'mantém as cópias recentes');
// 5) erro do banco: não grava nada e avisa
respostaFake = { ok: false, erro: 'Senha inválida.' }; const antes = arquivos.length; let erro = '';
try { vm.runInContext('BACKUP_BANCO()', ctx); } catch (e) { erro = e.message; }
ok(arquivos.length === antes && /Senha inválida/.test(erro), 'se o banco recusa, não grava e mostra o erro');
console.log(falhas ? falhas + ' FALHA(S)' : 'todos os testes passaram'); process.exit(falhas ? 1 : 0);
