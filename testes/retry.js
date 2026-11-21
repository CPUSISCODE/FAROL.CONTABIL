const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage(); let n = 0;
  await p.route('**/functions/v1/farol', r => { n++; if (n === 1) return r.abort('failed'); return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, r: { nome: 'Farol OK' } }) }); });
  await p.goto('file:///home/claude/farol.contabil/receptor/Portal.html'); await p.waitForTimeout(500);
  const r = await p.evaluate(() => chamar('portalAparencia').then(x => x.nome, e => 'ERRO ' + e.message));
  const w = await p.evaluate(() => { var t = 0; return chamar('portalLogin', 'a', 'b').then(x => 'ok', e => 'ERRO ' + e.message); });
  console.log('leitura com 1 falha de rede:', r, '| tentativas:', n);
  n = 0; await p.unroute('**/functions/v1/farol');
  await p.route('**/functions/v1/farol', r => { n++; return r.abort('failed'); });
  const w2 = await p.evaluate(() => chamar('portalFinImportar', 't').then(() => 'ok', e => 'ERRO ' + e.message));
  console.log('gravação com falha:', w2, '| tentativas:', n);
  await b.close();
})();
