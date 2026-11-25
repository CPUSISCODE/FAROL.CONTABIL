// ===== Ponte Farol Contábil (montada por ferramentas/montar_calc.py) =====
// Usa o login do portal, a base NCM do banco do Farol, recebe XML do portal e põe a logo da CPUSIS na impressão.
(function () {
  'use strict';
  var C = window.FAROL_CALC || {}, SN = C.regime === 'SN', pref = SN ? 'sn' : 'lp';
  var API = 'https://cidvuirvojpsmukfxpll.supabase.co/functions/v1/farol';
  var LOGO = new URL('../img/cpusis_logo.jpg', location.href).href;
  var $ = function (id) { return document.getElementById(id); };
  var EMBUTIDA = window.parent !== window;
  function token() {
    try { if (EMBUTIDA && window.parent.TOKEN) return window.parent.TOKEN; } catch (e) { }
    try { return sessionStorage.getItem('portal_token'); } catch (e) { return null; }
  }
  function status(t) { try { atualizarStatusBase(t); } catch (e) { } }
  var gate = $('authGate'), app = $('appRoot');
  document.body.classList.remove('auth-locked'); document.body.classList.add('auth-ready');

  function esconder(id) { var e = $(id); if (e) { e.hidden = true; e.style.display = 'none'; } }
  // Dentro do portal a calculadora veste o visual do Farol: mesma fonte, cores e espaçamentos, sem moldura nem rolagem própria.
  var TEMA = [
    'body.farol-embutida{--ink:#15211c;--ink-soft:#5a6a62;--paper:transparent;--paper-raised:#fff;--line:#dbe2de;--gold:#0f6b55;--gold-soft:#e1efe9;--green:#0f6b55;--green-soft:#e1efe9;',
    '--serif:"Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif;--sans:"Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif;padding:0 0 8px;overflow:hidden}',
    'body.farol-embutida .wrap{max-width:none;padding:0 2px}',
    'body.farol-embutida .tabs{margin:0 0 16px;gap:4px;border-bottom:1px solid var(--line)}',
    'body.farol-embutida .tabs button{background:transparent;border:0;border-bottom:2px solid transparent;border-radius:0;color:var(--ink-soft);padding:10px 14px;margin-bottom:-1px}',
    'body.farol-embutida .tabs button.active{background:transparent;color:#0f6b55;border-bottom-color:#0f6b55}',
    'body.farol-embutida .tabs button:not(.active):hover{background:transparent;color:var(--ink)}',
    'body.farol-embutida .search-block,body.farol-embutida .panel,body.farol-embutida table,body.farol-embutida .xml-summary,body.farol-embutida .settings-row{border-radius:12px;border-color:var(--line);box-shadow:none}',
    'body.farol-embutida .search-block{margin-top:0}',
    'body.farol-embutida button{border-radius:7px;background:#0f6b55;border-color:#0f6b55}',
    'body.farol-embutida button:hover{background:#0c5a47}',
    'body.farol-embutida button.ghost,body.farol-embutida .suggestions button{background:transparent;color:#0f6b55;border-color:#0f6b55}',
    'body.farol-embutida button.ghost:hover{background:#e1efe9}',
    'body.farol-embutida .tabs button{background:transparent;border-color:transparent}',
    'body.farol-embutida .search-row input[type=text]{border:1px solid var(--line);border-radius:7px;font-size:15px}',
    'body.farol-embutida .search-row input[type=text]:focus,body.farol-embutida select:focus,body.farol-embutida input:focus{outline:2px solid #0f6b55;outline-offset:1px}',
    'body.farol-embutida select,body.farol-embutida input[type=number],body.farol-embutida input[type=text]{border-radius:7px;background:#fff}',
    'body.farol-embutida .badge-code,body.farol-embutida .total-box{background:#15211c}',
    'body.farol-embutida .note{background:#eef3f0;border-left-color:#0f6b55;border-radius:6px}',
    'body.farol-embutida th{background:#eef3f0}',
    'body.farol-embutida tr.data-row:hover{background:#f3f7f5}',
    'body.farol-embutida h1,body.farol-embutida h2{font-family:var(--sans);letter-spacing:-.01em}',
    'body.farol-embutida hr,body.farol-embutida .divider{border-color:var(--line)}',
    // números: a mesma fonte do portal, com algarismos de largura igual (alinham nas colunas) e um pouco maiores
    'body.farol-embutida{--mono:"Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif;font-variant-numeric:tabular-nums}',
    'body.farol-embutida td,body.farol-embutida td.num,body.farol-embutida .cell-input,body.farol-embutida input{font-family:var(--sans);font-variant-numeric:tabular-nums lining-nums}',
    'body.farol-embutida td{font-size:13.5px;color:var(--ink)}',
    'body.farol-embutida td.num{font-weight:500;letter-spacing:0}',
    'body.farol-embutida td b,body.farol-embutida td.num b{font-weight:700}',
    'body.farol-embutida th{font-family:var(--sans);font-size:11px;letter-spacing:.04em;font-weight:600}',
    'body.farol-embutida .cell-input{font-size:13.5px;padding:4px 6px;border:1px solid var(--line);border-radius:6px}',
    'body.farol-embutida td .hint{font-size:11.5px;color:var(--ink-soft)}',
    'body.farol-embutida td input{font-size:13.5px!important;font-family:var(--sans)!important;font-variant-numeric:tabular-nums}',
    'body.farol-embutida td input[type=number]:not(.frac-input):not(.lp-frac-input),body.farol-embutida td input[type=text]{min-width:82px;text-align:right}',
    'body.farol-embutida .total-box .v,body.farol-embutida .totals .v,body.farol-embutida [class*=total] b{font-family:var(--sans);font-variant-numeric:tabular-nums}',
    'body.farol-embutida .row .v{font-family:var(--sans);font-variant-numeric:tabular-nums}',
    'body.farol-embutida .badge-code{font-family:var(--sans);font-weight:700;letter-spacing:.02em}',
    'body.farol-embutida .xml-section,body.farol-embutida .manage{border-top:1px solid var(--line);margin-top:28px}'
  ].join('');
  function mostrarApp() {
    if (gate) gate.style.display = 'none';
    if (app) { app.hidden = false; app.style.display = ''; }
    esconder('userBar'); esconder('tabBtnAdmin'); esconder('esperaLiberacao'); esconder('tabAdmin');
    var cf = $('conteudoFerramenta'); if (cf) { cf.hidden = false; cf.style.display = ''; }
    var t = $(pref + 'ArchiveTitle'); if (t && t.closest('section')) t.closest('section').style.display = 'none';
    document.querySelectorAll('p.hint').forEach(function (p) { if (/guardados automaticamente/i.test(p.textContent)) p.textContent = 'O XML é lido aqui no seu computador; nada é guardado na calculadora. Os XML do cliente ficam na pasta dele no Farol.'; });
    if (EMBUTIDA) { document.body.classList.add('farol-embutida'); var m = document.querySelector('.masthead'); if (m) m.style.display = 'none'; }
    var topo = document.createElement('div'); topo.id = 'farolImpTopo';
    topo.innerHTML = '<img alt="CPUSIS" src="' + LOGO + '"><div><b>Farol Contábil · Calculadora ' + (SN ? 'Simples Nacional' : 'Lucro Presumido') + '</b><span>CPUSIS — Cem Por Um Sistemas · impresso em ' + new Date().toLocaleString('pt-BR') + '</span></div>';
    document.body.insertBefore(topo, document.body.firstChild);
    var st = document.createElement('style');
    st.textContent = '#farolImpTopo{display:none}@media print{#farolImpTopo{display:flex!important;align-items:center;gap:14px;border-bottom:2px solid #0b2545;padding:0 0 8px;margin:0 0 12px}' +
      '#farolImpTopo img{height:60px}#farolImpTopo b{display:block;font-size:15px;color:#0b2545}#farolImpTopo span{font-size:11px;color:#444}}' +
      'body.farol-embutida{background:transparent}' + TEMA;
    document.head.appendChild(st);
  }
  function bloquear(msg) {
    if (app) { app.hidden = true; app.style.display = 'none'; }
    if (gate) {
      gate.style.display = '';
      Array.prototype.forEach.call(gate.querySelectorAll('form, .auth-tabs, [id^="authTab"], #authConteudo'), function (x) { x.style.display = 'none'; });
      var c = $('authCarregando'); if (c) { c.hidden = false; c.style.display = ''; c.textContent = msg; }
      else gate.insertAdjacentHTML('beforeend', '<p style="padding:20px">' + msg + '</p>');
    }
  }
  var tk = token();
  if (!tk) { bloquear('Abra a calculadora pelo portal Farol Contábil, com o seu login.'); return; }
  mostrarApp();

  // ---------- base fiscal (NCM, ST do Acre, MVA, monofásico) vinda do banco do Farol ----------
  var CH = 'farol-base-ncm';
  function ler() { try { var c = JSON.parse(localStorage.getItem(CH) || 'null'); return c && c.versao && c.rows ? c : null; } catch (e) { return null; } }
  function registros(b) {
    return b.rows.map(function (r) {
      var p = r.split('|');
      return { ncm: p[0], descricao: p[1], segmento: p[2] === '' ? null : b.segs[+p[2]], mva: p[3] === '' ? null : p[3], monofasico: p[4] === '' ? null : b.monos[+p[4]] };
    });
  }
  var cache = ler();
  if (cache) aplicarBaseNcm(registros(cache)); else status('Baixando a base fiscal…');
  var pronta = fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ acao: 'portal', fn: 'portalNcmBase', args: [tk, cache ? cache.versao : ''] }) })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j.ok) {
        if (/SESSAO_EXPIRADA/.test(j.erro)) bloquear('Sua sessão do portal expirou. Entre de novo no Farol Contábil.');
        else status(cache ? null : 'Não foi possível baixar a base fiscal: ' + j.erro);
        return;
      }
      if (j.r.igual) return;
      aplicarBaseNcm(registros(j.r));
      try { localStorage.setItem(CH, JSON.stringify({ versao: j.r.versao, segs: j.r.segs, monos: j.r.monos, rows: j.r.rows })); } catch (e) { }
    })
    .catch(function () { status(cache ? null : 'Sem conexão para baixar a base fiscal. Recarregue a página.'); });

  // ---------- XML vindo do portal (espelho da nota de compra) ----------
  function abrirXml(texto) {
    var aba = $(SN ? 'tabBtnConsulta' : 'tabBtnLP'); if (aba) aba.click();
    return pronta.then(function () {
      var parsed = parseNFeXML(texto);
      if (SN) loadXmlItems(parsed); else lpLoadXmlItems(parsed);
      var alvo = $(SN ? 'xmlFile' : 'lpXmlFile');
      avisar();
      if (alvo) {
        if (EMBUTIDA) { try { window.parent.postMessage({ tipo: 'farolCalcRolar', y: alvo.getBoundingClientRect().top + window.scrollY }, location.origin); } catch (e) { } }
        else if (alvo.scrollIntoView) alvo.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }).catch(function (e) { alert('Não consegui abrir este XML na calculadora: ' + e.message); });
  }
  window.farolAbrirXml = abrirXml;
  window.addEventListener('message', function (ev) {
    if (ev.origin !== location.origin || !ev.data) return;
    if (ev.data.tipo === 'xml' && typeof ev.data.texto === 'string') abrirXml(ev.data.texto);
  });
  try { var pend = localStorage.getItem('farol_calc_xml'); if (pend) { localStorage.removeItem('farol_calc_xml'); abrirXml(pend); } } catch (e) { }

  // ---------- cClassTrib (IBS/CBS) pela tabela oficial da Receita, não só pelas regras próprias da calculadora ----------
  if (typeof window.classifyRT === 'function' && typeof window.farolClassificarRT === 'function') {
    var regraCalc = window.classifyRT;
    window.classifyRT = function (n) { return window.farolClassificarRT(n, regraCalc); };
  }

  // ---------- ICMS na entrada: dados de ST da própria nota e a situação escrita na coluna ----------
  // O leitor de XML dos guias não guarda o ICMS-ST retido nem o CST/CSOSN do fornecedor; aqui eles entram no item.
  if (typeof window.parseNFeXML === 'function') {
    var lerNota = window.parseNFeXML;
    window.parseNFeXML = function (texto) {
      var p = lerNota(texto);
      try {
        var doc = new DOMParser().parseFromString(texto, 'text/xml'), dets = doc.getElementsByTagNameNS('*', 'det');
        (p.items || []).forEach(function (it, i) {
          var d = dets[i], ic = d && d.getElementsByTagNameNS('*', 'ICMS')[0];
          var g = function (t) { var e = ic && ic.getElementsByTagNameNS('*', t)[0]; return e ? e.textContent : ''; };
          it.icmsCst = g('CST'); it.icmsCsosn = g('CSOSN');
          it.vICMSST = parseFloat(g('vICMSST')) || 0; it.vICMSSTRet = parseFloat(g('vICMSSTRet')) || 0; it.vFCPST = parseFloat(g('vFCPST')) || 0;
        });
      } catch (e) { }
      return p;
    };
  }
  function reais(v) { return 'R$ ' + (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  // devolve [texto curto para a coluna, explicação completa para o "passar o mouse"]
  function situacaoEntrada(r, item, uf) {
    var temST = SN ? r.hasCest : r.hasST, cst = item.icmsCst || '', csosn = item.icmsCsosn || '';
    var stNaNota = (item.vICMSST || 0) > 0, stAntes = /^(60|10|30|70)$/.test(cst) || /^(500|201|202|203)$/.test(csosn) || (item.vICMSSTRet || 0) > 0;
    var pct = (String(r.aliqLabel || '').match(/(\d+(?:[.,]\d+)?)%/) || [])[1] || '';
    if (r.tipo === 'cesta') return r.icms > 0 ? ['DIFAL cesta · encerra', r.aliqLabel + ' — cesta básica do Acre, o recolhimento encerra a tributação']
                                              : ['Cesta AC · encerra', 'Cesta básica comprada no Acre: a carga de 7% é paga pelo fornecedor e encerra a tributação'];
    if (r.tipo === 'st') return ['ST ' + pct + '% · encerra', r.aliqLabel + ' — ICMS-ST na entrada, com encerramento' + (stNaNota ? '; a nota já traz ' + reais(item.vICMSST) + ' de ST retido' : '')];
    if (r.tipo === 'antecipacao') return ['Antecip. ' + pct + '% · sem encerr.', r.aliqLabel + ' — antecipação parcial, sem encerramento' + (SN ? '' : '; vira crédito na apuração')];
    if (r.tipo === 'interna') {
      if (temST) {
        if (stNaNota) return ['ST retido · encerra', 'Compra no Acre: ST de ' + reais(item.vICMSST) + ' retido pelo fornecedor na nota; encerra, sem custo a mais'];
        if (stAntes) return ['ST anterior · encerra', 'Compra no Acre: ST já recolhido antes (' + (cst ? 'CST ' + cst : 'CSOSN ' + csosn) + '); encerra, sem custo a mais'];
        return ['ST não retido · conferir', 'Compra no Acre de produto com ST, mas a nota não traz ST retido: conferir se cabe antecipação com encerramento'];
      }
      return SN ? ['Compra AC · sem antecip.', 'Compra no Acre sem ST: não há antecipação; o ICMS da venda vai no DAS']
                : ['ICMS normal' + ((item.vICMS || 0) > 0 ? ' · créd. ' + reais(item.vICMS) : ''), 'Compra no Acre sem ST: ICMS normal' + ((item.vICMS || 0) > 0 ? ', com crédito de ' + reais(item.vICMS) : ', sem destaque na nota')];
    }
    return [r.aliqLabel || '', r.aliqLabel || ''];
  }
  ['computeIcmsEntradaXml', 'computeIcmsEntradaLP'].forEach(function (nome) {
    if (typeof window[nome] !== 'function') return;
    var orig = window[nome];
    window[nome] = function (item, uf, crt) { var r = orig.apply(this, arguments); try { var x = situacaoEntrada(r, item || {}, uf); r.aliqLabel = x[0]; r.aliqTitulo = x[1]; } catch (e) { } return r; };
  });

  // ---------- impressão: relatórios com a logo da CPUSIS ----------
  if (typeof window.openReportWindow === 'function') {
    var orig = window.openReportWindow;
    window.openReportWindow = function (h) {
      var cab = '<div style="display:flex;align-items:center;gap:14px;border-bottom:2px solid #0b2545;padding:0 0 8px;margin:0 0 12px;font-family:Arial,sans-serif">' +
        '<img src="' + LOGO + '" style="height:60px" alt="CPUSIS"><div><b style="display:block;font-size:15px;color:#0b2545">Farol Contábil · CPUSIS</b>' +
        '<span style="font-size:11px;color:#444">Cem Por Um Sistemas · Epitaciolândia/AC</span></div></div>';
      return orig(String(h).replace(/<body([^>]*)>/i, '<body$1>' + cab));
    };
  }

  // ---------- altura da página para o portal ajustar o quadro ----------
  var ultima = 0;
  function avisar() {
    if (!EMBUTIDA) return;
    var r = app ? app.getBoundingClientRect() : null;
    var h = Math.ceil(r ? r.height + (r.top + window.scrollY) : document.body.scrollHeight) + 12;
    if (Math.abs(h - ultima) > 8) { ultima = h; try { window.parent.postMessage({ tipo: 'farolCalcAltura', h: h }, location.origin); } catch (e) { } }
  }
  if (EMBUTIDA) { setInterval(avisar, 500); window.addEventListener('load', avisar); window.addEventListener('resize', avisar); if (window.ResizeObserver && app) new ResizeObserver(avisar).observe(app); }
})();
