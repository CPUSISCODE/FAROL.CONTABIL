// Farol Contábil — conferência IBS/CBS com a Calculadora de Tributos da Receita (Edge Function "rtc").
//   GET  ?acao=tabela&data=AAAA-MM-DD  -> alíquotas de referência e cClassTrib (reduções) do mês, para o agente.
//        Dado público; guardado no banco e renovado no máximo a cada 3 dias (a Receita não é chamada a cada pedido).
//   POST {acao:'confirmar', token}      -> (agendado de madrugada) confere na calculadora oficial as notas que o
//        agente marcou com divergência e testa se o NCM pode usar o cClassTrib. Poucas chamadas por noite, espaçadas.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const API = 'https://piloto-cbs.tributos.gov.br/servico/calculadora-consumo/api/calculadora';
const MAX_NOTAS = 25, MAX_PARES = 25, PAUSA = 2500;   // devagar: o firewall da Receita bloqueia rajadas (roda de hora em hora, de dia)
const json = (o: unknown, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' } });
const dorme = (ms: number) => new Promise((r) => setTimeout(r, ms));
const COMP = ['vProd', 'vFrete', 'vSeg', 'vOutro', 'vII', 'vDesc', 'vPIS', 'vCOFINS', 'vICMS', 'vFCP', 'vICMSUFDest', 'vFCPUFDest', 'vICMSMono', 'vISSQN'];

function iguais(a: string, b: string) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

async function receita(caminho: string, corpo?: unknown): Promise<{ st: number; j: any }> {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch(API + caminho, corpo ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo), signal: ctl.signal } : { signal: ctl.signal });
    const txt = await r.text(); let j: any = null; try { j = JSON.parse(txt); } catch { j = { bruto: txt.slice(0, 300) }; }
    if (j?.bruto && /Request Rejected/i.test(j.bruto)) throw new Error('BLOQUEIO');   // firewall da Receita: para tudo por hoje
    return { st: r.status, j };
  } finally { clearTimeout(t); }
}

// ------------------------------------------------------------------ tabela do mês
async function montarTabela(data: string) {
  const igual = (xs: (number | null)[]) => xs.every((x) => x != null && x === xs[0]) ? xs[0] : null;
  const ali = async (c: string) => { const { st, j } = await receita('/dados-abertos/' + c + '&data=' + data); return st === 200 && typeof j?.aliquotaReferencia === 'number' ? j.aliquotaReferencia : null; };
  const cbs = await ali('aliquota-uniao?x=1');
  const ufs = []; for (const uf of [12, 35, 52]) ufs.push(await ali('aliquota-uf?codigoUf=' + uf));
  const mun = []; for (const m of [1200252, 3550308, 5208707]) mun.push(await ali('aliquota-municipio?codigoMunicipio=' + m));
  const { st, j } = await receita('/dados-abertos/classificacoes-tributarias/cbs-ibs?data=' + data);
  const classes = st === 200 && Array.isArray(j) ? j.map((c: any) => ({
    c: c.codigo, rCBS: Number(c.percentualReducaoCbs) || 0, rUF: Number(c.percentualReducaoIbsUf) || 0, rMun: Number(c.percentualReducaoIbsMun) || 0,
    padrao: String(c.tipoAliquota || '') === 'Padrão', d: String(c.descricao || '').slice(0, 140), trat: String(c.descricaoTratamentoTributario || '').slice(0, 80), nom: c.nomenclatura || '',
  })) : [];
  const { j: v } = await receita('/dados-abertos/versao');
  return { fonte: 'Calculadora de Tributos RFB', versao: (v?.versaoDb || '') + ' ' + (v?.versaoApp || ''), data, cbs, ibsUF: igual(ufs), ibsMun: igual(mun), classes, geradaEm: new Date().toISOString() };
}
async function tabela(data: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) throw new Error('data inválida');
  const chave = data.slice(0, 7), lim = new Date(Date.now() + 40 * 864e5).toISOString().slice(0, 7);
  if (chave < '2026-01' || chave > lim) throw new Error('mês fora do período da reforma');   // evita pedidos à toa na Receita
  const { data: tb } = await db.from('rtc_tabela').select('dados, atualizado_em').eq('chave', chave).maybeSingle();
  const velha = !tb || Date.now() - new Date(tb.atualizado_em).getTime() > 3 * 864e5;
  if (!velha) return tb!.dados;
  try {
    const nova = await montarTabela(data);
    if (nova.classes.length && nova.cbs != null) { await db.from('rtc_tabela').upsert({ chave, dados: nova, atualizado_em: new Date().toISOString() }); return nova; }
  } catch (_) { /* Receita fora: fica com a cópia anterior */ }
  if (tb) return tb.dados;
  throw new Error('Calculadora da Receita indisponível agora');
}

// ------------------------------------------------------------------ confirmação noturna
function pedidoNota(n: any) {
  return {
    id: String(n.chave).slice(-20), versao: '0.0.1', tpDoc: Number(n.modelo) === 65 ? 65 : 55, dhFatoGerador: n.dh || (n.data + 'T12:00:00-03:00'),
    municipio: Number(n.mun) || 0, uf: n.uf || undefined,
    itens: (n.erros || []).map((e: any, i: number) => {
      const g: Record<string, number> = {}; COMP.forEach((k) => (g[k] = Number(e.comp?.[k]) || 0));
      g.vDesc = Math.round((g.vDesc + (Number(e.comp?.vICMSDeson) || 0)) * 100) / 100;   // ICMS desonerado abatido do preço entra como desconto
      return { numero: i + 1, ncm: e.ncm || undefined, cst: e.cst, cClassTrib: e.cc, quantidade: 1, unidade: 'UN', gComponentesBC: g };
    }),
  };
}
function lerOficial(n: any, j: any) {
  const objs = j?.objetos || [];
  return (n.erros || []).map((e: any, i: number) => {
    const g = objs[i]?.tribCalc?.IBSCBS?.gIBSCBS || {};
    const of = { vBC: Number(g.vBC), vUF: Number(g.gIBSUF?.vIBSUF), vMun: Number(g.gIBSMun?.vIBSMun), vCBS: Number(g.gCBS?.vCBS), pUF: Number(g.gIBSUF?.pIBSUF), pCBS: Number(g.gCBS?.pCBS) };
    const nota = e.nota || {};
    return { n: e.n, of, baseConfere: Math.abs(of.vBC - Number(nota.vBC)) <= 0.05, valorConfere: Math.abs((of.vUF + of.vMun + of.vCBS) - (N(nota.vUF) + N(nota.vMun) + N(nota.vCBS))) <= 0.02 };
  });
}
const N = (v: unknown) => Number(v) || 0;

async function confirmar() {
  const hoje = new Date(); const m0 = hoje.toISOString().slice(0, 7);
  const ant = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const { data: linhas, error } = await db.from('resumos').select('unidade_id, mes, rtc:dados->rtc').in('mes', [m0, ant]);
  if (error) throw new Error(error.message);
  const notas: any[] = [], pares = new Map<string, string>();
  for (const l of linhas || []) {
    const r: any = (l as any).rtc; if (!r) continue;
    for (const n of r.notas || []) notas.push(n);
    for (const p of r.pares || []) pares.set(p + '|' + l.mes, l.mes);
  }
  const res = { notas: notas.length, conferidas: 0, pares: pares.size, paresConferidos: 0, bloqueio: false };
  // só o que ainda não foi conferido com os mesmos itens
  const chaves = notas.map((n) => n.chave);
  const ja = new Map<string, string>();
  for (let i = 0; i < chaves.length; i += 300) {
    const { data } = await db.from('rtc_confirmacoes').select('chave, assinatura').in('chave', chaves.slice(i, i + 300));
    (data || []).forEach((x: any) => ja.set(x.chave, x.assinatura));
  }
  try {
    for (const n of notas) {
      if (res.conferidas >= MAX_NOTAS) break;
      const ass = (n.erros || []).map((e: any) => e.nota?.vBC + ':' + e.bcEsp).join(',');
      if (ja.get(n.chave) === ass || !(n.erros || []).length || !n.mun) continue;
      const { st, j } = await receita('/regime-geral', pedidoNota(n));
      const resultado = st === 200 ? { ok: true, itens: lerOficial(n, j) } : { ok: false, status: st, titulo: j?.title || '', detalhe: String(j?.detail || j?.bruto || '').slice(0, 400) };
      await db.from('rtc_confirmacoes').upsert({ chave: n.chave, assinatura: ass, resultado, em: new Date().toISOString() });
      res.conferidas++; await dorme(PAUSA);
    }
    const lista = [...pares.keys()];
    const { data: jaP } = await db.from('rtc_ncm').select('par').in('par', lista.slice(0, 2000));
    const feitos = new Set((jaP || []).map((x: any) => x.par));
    for (const par of lista) {
      if (res.paresConferidos >= MAX_PARES) break;
      if (feitos.has(par)) continue;
      const [ncm, cc, mes] = par.split('|');
      const { st, j } = await receita('/dados-abertos/classificacoes-tributarias/ncm-aplicavel?ncm=' + encodeURIComponent(ncm) + '&cClassTrib=' + encodeURIComponent(cc) + '&dataOcorrenciaFatoGerador=' + mes + '-15');
      // grava sempre (sem resposta válida fica nulo), senão o mesmo par volta para a fila em toda rodada
      await db.from('rtc_ncm').upsert({ par, valido: st === 200 && typeof j?.valido === 'boolean' ? j.valido : null, em: new Date().toISOString() });
      res.paresConferidos++; await dorme(PAUSA);
    }
  } catch (e) {
    if (String((e as Error).message) === 'BLOQUEIO') res.bloqueio = true; else throw e;
  }
  await db.from('rtc_execucoes').insert({ resultado: res });
  return res;
}


// ------------------------------------------------------------------ tela do portal (sessão do contador)
const normal = (x: unknown) => String(x ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
async function sessao(token: unknown): Promise<{ contabs: string[]; empresa?: { contabilidade: string; cliente: string } | null; modulos?: string[] }> {
  const t = String(token || '');
  if (!/^[0-9a-f]{64}$/.test(t)) throw new Error('SESSAO_EXPIRADA');
  const { data } = await db.from('sessoes').select('dados, expira_em, absoluta_ate').eq('token', t).maybeSingle();
  if (!data || new Date(data.expira_em).getTime() < Date.now()) throw new Error('SESSAO_EXPIRADA');
  if (data.absoluta_ate && new Date(data.absoluta_ate).getTime() < Date.now()) throw new Error('SESSAO_EXPIRADA');
  return data.dados as { contabs: string[]; empresa?: { contabilidade: string; cliente: string } | null; modulos?: string[] };
}
// o que a calculadora oficial respondeu para as notas e os pares NCM x cClassTrib do mês
async function tela(req: any) {
  const s = await sessao(req.token), cs = s.contabs || [];
  if (s.modulos && !s.modulos.some((m) => m === 'conferencia' || m === 'produtos')) throw new Error('Seu acesso não inclui esta função.');
  if (s.empresa) {   // login de cliente: só a própria empresa
    if (normal(s.empresa.contabilidade) !== normal(req.contabilidade) || normal(s.empresa.cliente) !== normal(req.cliente)) throw new Error('Sem permissão para esta empresa.');
  } else if (!cs.length || !(cs.includes('*') || cs.some((x) => normal(x) === normal(req.contabilidade)))) throw new Error('Sem permissão para esta contabilidade.');
  const mes = String(req.mes || ''); if (!/^\d{4}-\d{2}$/.test(mes)) throw new Error('Mês inválido.');
  const chaves = (Array.isArray(req.chaves) ? req.chaves : []).map(String).filter((c: string) => /^\d{44}$/.test(c)).slice(0, 300);
  const pares = (Array.isArray(req.pares) ? req.pares : []).map(String).filter((p: string) => /^[0-9A-Za-z.]{2,10}\|\d{6}$/.test(p)).slice(0, 600).map((p: string) => p + '|' + mes);
  const [c1, c2, c3] = await Promise.all([
    chaves.length ? db.from('rtc_confirmacoes').select('chave, resultado, em').in('chave', chaves) : Promise.resolve({ data: [] as any[] }),
    pares.length ? db.from('rtc_ncm').select('par, valido').in('par', pares) : Promise.resolve({ data: [] as any[] }),
    db.from('rtc_tabela').select('dados, atualizado_em').eq('chave', mes).maybeSingle(),
  ]);
  const conf: Record<string, unknown> = {}; ((c1 as any).data || []).forEach((x: any) => (conf[x.chave] = { ...x.resultado, em: x.em }));
  const ncm: Record<string, boolean> = {}; ((c2 as any).data || []).forEach((x: any) => (ncm[x.par.split('|').slice(0, 2).join('|')] = x.valido));
  const tb: any = (c3 as any).data?.dados || {};
  const classes: Record<string, unknown> = {}; (tb.classes || []).forEach((c: any) => (classes[c.c] = { d: c.d, trat: c.trat, r: c.rCBS }));
  return { conf, ncm, classes, versao: tb.versao || '', cbs: tb.cbs, ibsUF: tb.ibsUF, tabelaEm: (c3 as any).data?.atualizado_em || null };
}

// ---------------------------------------------------------------- atualizações da Receita (IBS/CBS · cClassTrib)
// O robô do GitHub (.github/workflows/receita.yml) confere todo dia o código-fonte oficial da Calculadora de Tributos e,
// quando a Receita muda a tabela, grava dados/rtc_novidades.json. Aqui: a novidade nova entra no banco, a tabela do mês
// é renovada e o banco cruza os NCMs que mudaram com o que cada cliente vende (rtc_impacto) para o portal avisar.
const NOVIDADES = 'https://raw.githubusercontent.com/CPUSISCODE/FAROL.CONTABIL/main/dados/rtc_novidades.json';
async function processarNovidades() {
  const r = await fetch(NOVIDADES + '?t=' + Date.now(), { headers: { 'Cache-Control': 'no-cache' } });
  if (!r.ok) return { ok: false, erro: 'GitHub respondeu ' + r.status };
  const lista: any[] = (await r.json()).novidades || [];
  const feitas: string[] = [];
  for (const n of lista.slice(-5)) {
    const { data: ja } = await db.from('rtc_novidades').select('id, processada_em').eq('id', n.id).maybeSingle();
    if (ja?.processada_em) continue;
    await db.from('rtc_novidades').upsert({ id: n.id, em: n.em, dados: n });
    const ncms = (n.ncms || []).map((x: any) => x.ncm).filter((x: string) => /^\d{8}$/.test(x));
    const { data: qtd, error } = await db.rpc('rtc_calcular_impacto', { p_id: n.id, p_ncms: ncms });
    if (error) throw new Error('impacto: ' + error.message);
    await db.from('rtc_tabela').update({ atualizado_em: '2000-01-01T00:00:00Z' }).gte('chave', new Date(Date.now() - 40 * 86400e3).toISOString().slice(0, 7));   // força renovar a tabela do mês
    await db.from('rtc_novidades').update({ processada_em: new Date().toISOString() }).eq('id', n.id);
    feitas.push(n.id + ': ' + qtd + ' cliente(s)');
  }
  return { ok: true, feitas };
}
// o que o login vê: as últimas novidades e os clientes dele que vendem produtos afetados
async function avisos(req: any) {
  const s = await sessao(req.token), cs = s.contabs || [];
  const { data: nov } = await db.from('rtc_novidades').select('id, em, dados').order('em', { ascending: false }).limit(3);
  const ids = (nov || []).map((n: any) => n.id);
  let imp: any[] = [];
  if (ids.length) {
    const { data } = await db.from('rtc_impacto').select('novidade_id, mes, ncms, unidades(contabilidade, cliente, subpasta)').in('novidade_id', ids);
    imp = (data || []).filter((x: any) => {
      const u = x.unidades; if (!u) return false;
      if (s.empresa) return normal(s.empresa.contabilidade) === normal(u.contabilidade) && normal(s.empresa.cliente) === normal(u.cliente);
      return cs.includes('*') || cs.some((c) => normal(c) === normal(u.contabilidade));
    }).map((x: any) => ({ novidade: x.novidade_id, mes: x.mes, ncms: x.ncms, contabilidade: x.unidades.contabilidade, cliente: x.unidades.cliente, subpasta: x.unidades.subpasta }));
  }
  return { novidades: (nov || []).map((n: any) => ({ id: n.id, em: n.em, resumo: n.dados.resumo, base: n.dados.base_depois, baseAntes: n.dados.base_antes, classes: n.dados.classes, ncms: (n.dados.ncms || []).slice(0, 400), totalNcms: n.dados.total_ncms })), impacto: imp };
}

Deno.serve(async (r) => {
  if (r.method === 'OPTIONS') return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type' } });
  try {
    const u = new URL(r.url);
    if (r.method === 'GET' && u.searchParams.get('acao') === 'tabela') {
      const data = u.searchParams.get('data') || new Date().toISOString().slice(0, 10);
      return json({ ok: true, tabela: await tabela(data) });
    }
    if (r.method === 'POST') {
      const req = JSON.parse(await r.text());
      if (req.acao === 'tela') {
        try { return json({ ok: true, r: await tela(req) }); } catch (e) { return json({ ok: false, erro: String((e as Error)?.message || e) }); }
      }
      if (req.acao === 'avisos') {
        try { return json({ ok: true, r: await avisos(req) }); } catch (e) { return json({ ok: false, erro: String((e as Error)?.message || e) }); }
      }
      if (req.acao === 'novidades') {   // agendado: mesmo token do confirmar
        const { data: cfg } = await db.from('rtc_config').select('token').eq('id', 1).maybeSingle();
        const TOKEN = String(cfg?.token || '');
        if (TOKEN.length < 32 || !iguais(String(req.token || ''), TOKEN)) return json({ ok: false, erro: 'não autorizado' }, 401);
        return json(await processarNovidades());
      }
      if (req.acao === 'confirmar') {
        const { data: cfg } = await db.from('rtc_config').select('token').eq('id', 1).maybeSingle();   // token guardado no banco (o agendamento lê dali)
        const TOKEN = String(cfg?.token || '');
        if (TOKEN.length < 32 || !iguais(String(req.token || ''), TOKEN)) return json({ ok: false, erro: 'não autorizado' }, 401);
        // responde na hora e continua em segundo plano (a chamada do agendamento não fica esperando)
        const tarefa = confirmar().catch(async (e) => { await db.from('rtc_execucoes').insert({ resultado: { erro: String((e as Error)?.message || e) } }); });
        const rt = (globalThis as any).EdgeRuntime;
        if (rt?.waitUntil) { rt.waitUntil(tarefa); return json({ ok: true, iniciado: true }, 202); }
        await tarefa; return json({ ok: true });
      }
    }
    return json({ ok: false, erro: 'Ação desconhecida.' }, 400);
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
