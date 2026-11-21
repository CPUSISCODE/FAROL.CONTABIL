// Farol Contábil — Modo Reunião e visão da carteira (Edge Function "reuniao").
// Só leitura. Usa as sessões do portal (tabela sessoes) e as funções do banco reuniao() e termometro().
// Enquanto está em teste, só o login CPUSIS (contabs '*') usa.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const MARGEM = Number(Deno.env.get('MARGEM_MINIMA') || '0.20');   // vendas devem ser ao menos 20% acima das compras
const MESES_MIN = 6;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, authorization, apikey, x-client-info' };
const json = (o: unknown) => new Response(JSON.stringify(o), { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
const normal = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
const r2 = (v: number) => Math.round((v || 0) * 100) / 100;
const N = (v: unknown) => Number(v) || 0;
type Sessao = { login: string; nome: string; contabs: string[]; empresa?: unknown };

async function sessao(token: unknown): Promise<Sessao> {
  const t = String(token || '');
  if (!/^[0-9a-f]{64}$/.test(t)) throw new Error('SESSAO_EXPIRADA');
  const { data } = await db.from('sessoes').select('dados, expira_em').eq('token', t).maybeSingle();
  if (!data || new Date(data.expira_em).getTime() < Date.now()) throw new Error('SESSAO_EXPIRADA');
  return data.dados as Sessao;
}
const podeVer = (s: Sessao, c: string) => s.contabs.includes('*') || s.contabs.some((x) => normal(x) === normal(c));

export function termometro(t: { meses: number; vendas: number; transferencias: number; compras: number; transf_recebidas: number } | null) {
  const meses = t ? N(t.meses) : 0;
  const saidas = t ? N(t.vendas) + N(t.transferencias) : 0, entradas = t ? N(t.compras) + N(t.transf_recebidas) : 0;
  const esperado = entradas * (1 + MARGEM), pct = esperado > 0 ? (100 * saidas) / esperado : null;
  let st = 'ok', txt = 'Dentro do esperado';
  if (meses < MESES_MIN) { st = 'poucos'; txt = 'Só ' + meses + ' mês(es) no portal: ainda pouco para concluir'; }
  else if (!entradas || (pct as number) > 400) { st = 'compras'; txt = 'Notas de compra incompletas no portal'; }
  else if ((pct as number) < 85) { st = 'risco'; txt = 'Risco de notificação'; }
  else if ((pct as number) < 100) { st = 'atencao'; txt = 'Atenção'; }
  return { meses, saidas: r2(saidas), entradas: r2(entradas), esperado: r2(esperado), pct: pct == null ? null : Math.floor(pct), diferenca: r2(saidas - esperado), st, txt, margem: MARGEM };
}

function saude(ind: any, termo: any) {
  let nota = 100; const itens: { ok: boolean; txt: string }[] = [];
  const semXml = N(ind?.semXml), pend = N(ind?.pendQtd), falhas = N(ind?.falhas);
  if (semXml) { nota -= 15; itens.push({ ok: false, txt: semXml + ' nota(s) sem XML autorizado' }); } else itens.push({ ok: true, txt: 'Todos os XML no portal' });
  if (pend) { nota -= Math.min(20, 3 * pend); itens.push({ ok: false, txt: pend + ' nota(s) pendente(s) na SEFAZ' }); }
  if (falhas) { nota -= 10; itens.push({ ok: false, txt: falhas + ' falha(s) na numeração' }); }
  const rf = ind?.rf, normalReg = ind?.regime && !/^(SN|MEI)$/.test(ind.regime);
  if (normalReg && rf && N(rf.docs)) {
    const pronto = rf.det ? N(rf.docsCom) >= N(rf.docs) : N(rf.vIBS) + N(rf.vCBS) + N(ind?.ibs) + N(ind?.cbs) > 0;
    if (pronto) itens.push({ ok: true, txt: 'Pronto para a Reforma (IBS/CBS)' });
    else { nota -= 10; itens.push({ ok: false, txt: 'Notas ainda sem IBS/CBS' }); }
  }
  if (termo.st === 'risco') { nota -= 20; itens.push({ ok: false, txt: 'Vendas abaixo do esperado pelas compras' }); }
  else if (termo.st === 'atencao') { nota -= 10; itens.push({ ok: false, txt: 'Vendas perto do limite esperado' }); }
  nota = Math.max(0, Math.min(100, nota));
  return { nota, rotulo: nota >= 90 ? 'Muito boa' : nota >= 75 ? 'Boa' : nota >= 55 ? 'Atenção' : 'Crítica', itens: itens.slice(0, 4) };
}

async function reuniao(req: any) {
  const s = await sessao(req.token);
  if (!s.contabs.includes('*')) throw new Error('O Modo Reunião ainda está em teste.');
  if (!podeVer(s, req.contabilidade)) throw new Error('Sem permissão para esta contabilidade.');
  const mes = String(req.mes || ''); if (!/^\d{4}-\d{2}$/.test(mes)) throw new Error('Mês inválido.');
  const { data: u } = await db.from('unidades').select('id, contabilidade, cliente, subpasta').eq('contab_n', normal(req.contabilidade)).eq('cliente_n', normal(req.cliente)).eq('subpasta_n', normal(req.subpasta)).maybeSingle();
  if (!u) throw new Error('Cliente não encontrado.');
  const [{ data: ms, error }, { data: tm }, { data: rg }, { data: bp }] = await Promise.all([
    db.rpc('reuniao', { p_unidade: u.id, p_mes: mes }),
    db.rpc('termometro', { p_unidades: [u.id], p_mes: mes, p_janela: Number(req.janela) === 3 ? 3 : 12 }),
    db.from('regimes').select('regime').eq('contab_n', normal(u.contabilidade)).eq('cliente_n', normal(u.cliente)).maybeSingle(),
    db.from('bpo').select('ativo, saldo').eq('contab_n', normal(u.contabilidade)).eq('cliente_n', normal(u.cliente)).maybeSingle(),
  ]);
  if (error) throw new Error('Banco: ' + error.message);
  const meses = (ms || []).map((m: any) => ({ mes: m.mes, ...m.n, ind: m.ind }));
  const atual = meses.find((m: any) => m.mes === mes) || null, ant = meses.filter((m: any) => m.mes < mes).pop() || null;
  const ind = atual?.ind || {};
  const regime = rg?.regime || ind.regime || (atual?.crt === '3' ? 'NORMAL' : atual?.crt ? 'SN' : '');
  const termo = termometro(tm?.[0] || null);
  // limite do Simples: soma dos meses disponíveis (até 12)
  const receita12 = meses.reduce((a: number, m: any) => a + N(m.vendas), 0);
  const limite = regime === 'MEI' ? 81000 : 4800000;
  const vendasQtd = atual ? N(atual.nfceQtd) + N(atual.nfeQtd) : 0;
  return {
    cliente: u.cliente, subpasta: u.subpasta, contabilidade: u.contabilidade, mes, regime,
    serie: meses.map((m: any) => ({ mes: m.mes, vendas: N(m.vendas), compras: N(m.comprasRevenda) })),
    atual: atual && { vendas: N(atual.vendas), compras: N(atual.comprasRevenda), impostos: N(atual.impostos), qtd: vendasQtd, ticket: vendasQtd ? r2(N(atual.vendas) / vendasQtd) : 0, semana: atual.semana || {}, pagamentos: atual.pagamentos || {} },
    anterior: ant && { vendas: N(ant.vendas), compras: N(ant.comprasRevenda), impostos: N(ant.impostos), qtd: N(ant.nfceQtd) + N(ant.nfeQtd) },
    termometro: termo, saude: saude(ind, termo),
    simples: /^(SN|MEI)$/.test(regime) ? { receita: r2(receita12), limite, pct: Math.round((100 * receita12) / limite), meses: meses.length } : null,
    bpo: bp?.ativo ? { saldo: N(bp.saldo) } : null,
  };
}

async function carteira(req: any) {
  const s = await sessao(req.token);
  if (!s.contabs.includes('*')) throw new Error('A nova visão da carteira ainda está em teste.');
  const mes = String(req.mes || ''); if (!/^\d{4}-\d{2}$/.test(mes)) throw new Error('Mês inválido.');
  const { data: us } = await db.from('unidades').select('id, contabilidade, cliente, subpasta');
  const vis = (us || []).filter((u: any) => podeVer(s, u.contabilidade) && (!req.contabilidade || normal(u.contabilidade) === normal(req.contabilidade)));
  const ids = vis.map((u: any) => u.id);
  const [{ data: tm }, { data: inds }] = await Promise.all([
    db.rpc('termometro', { p_unidades: ids, p_mes: mes, p_janela: 12 }),
    db.from('indicadores').select('unidade_id, dados').eq('mes', mes).in('unidade_id', ids),
  ]);
  const tPor: Record<number, any> = {}; (tm || []).forEach((t: any) => (tPor[t.unidade_id] = t));
  const iPor: Record<number, any> = {}; (inds || []).forEach((i: any) => (iPor[i.unidade_id] = i.dados));
  const clientes = vis.filter((u: any) => iPor[u.id]).map((u: any) => {
    const termo = termometro(tPor[u.id] || null), ind = iPor[u.id];
    return { contabilidade: u.contabilidade, cliente: u.cliente, subpasta: u.subpasta, vendas: N(ind.vendas), regime: ind.regime || '', termometro: termo, saude: saude(ind, termo) };
  });
  return { mes, clientes };
}

Deno.serve(async (r) => {
  if (r.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const req = JSON.parse(await r.text());
    if (req.acao === 'reuniao') return json({ ok: true, r: await reuniao(req) });
    if (req.acao === 'carteira') return json({ ok: true, r: await carteira(req) });
    return json({ ok: false, erro: 'Ação desconhecida.' });
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) });
  }
});
