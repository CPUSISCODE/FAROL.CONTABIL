const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  for (const q of ['', '?banco=0', '?banco=1']) {
    const p = await b.newPage(); const hits = [];
    await p.route('**/*', r => { const u = r.request().url(); if (/supabase|script\.google/.test(u)) { hits.push(/supabase/.test(u) ? 'banco' : 'google'); return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, r: { nome: 'X' } }) }); } r.continue(); });
    await p.goto('file:///home/claude/farol.contabil/receptor/Portal.html' + q); await p.waitForTimeout(800);
    const badge = await p.evaluate(() => document.body.innerText.includes('Caminho antigo'));
    console.log(JSON.stringify(q || '(sem)'), [...new Set(hits)].join(','), 'aviso reserva:', badge);
    await p.close();
  }
  await b.close();
})();
