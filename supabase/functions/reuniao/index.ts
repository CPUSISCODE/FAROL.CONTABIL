// Farol Contábil — Modo Reunião e visão da carteira (Edge Function "reuniao").
// Só leitura. Usa as sessões do portal (tabela sessoes) e as funções do banco reuniao() e termometro().
// Cada login só vê as contabilidades liberadas para ele (contabs); login de empresa (BPO) não tem acesso.
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
  if (!s.contabs.length || !podeVer(s, req.contabilidade)) throw new Error('Sem permissão para esta contabilidade.');
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

// ---------------- Apuração fiscal estimada (Simples Nacional e Lucro Presumido, comércio) ----------------
// Simples Nacional, Anexo I (comércio): [limite da faixa, alíquota nominal, parcela a deduzir] e repartição dos tributos por faixa.
const ANEXO_I = [[180000, 0.04, 0], [360000, 0.073, 5940], [720000, 0.095, 13860], [1800000, 0.107, 22500], [3600000, 0.143, 87300], [4800000, 0.19, 378000]];
const REPART = [
  { irpj: 5.5, csll: 3.5, cofins: 12.74, pis: 2.76, cpp: 41.5, icms: 34 }, { irpj: 5.5, csll: 3.5, cofins: 12.74, pis: 2.76, cpp: 41.5, icms: 34 },
  { irpj: 5.5, csll: 3.5, cofins: 12.74, pis: 2.76, cpp: 42, icms: 33.5 }, { irpj: 5.5, csll: 3.5, cofins: 12.74, pis: 2.76, cpp: 42, icms: 33.5 },
  { irpj: 5.5, csll: 3.5, cofins: 12.74, pis: 2.76, cpp: 42, icms: 33.5 }, { irpj: 13.5, csll: 10, cofins: 28.27, pis: 6.13, cpp: 42.1, icms: 0 },
];
const mesMais = (m: string, k: number) => { const d = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1 + k, 1)); return d.toISOString().slice(0, 7); };

function simples(meses: any[], mes: string, atual: any, rbtInformada: number | null) {
  const ini = mesMais(mes, -12), ant = meses.filter((m) => m.mes >= ini && m.mes < mes);
  const soma = ant.reduce((a, m) => a + N(m.n.vendas), 0);
  let rbt12 = soma, fonte = 'portal';
  if (rbtInformada && rbtInformada > 0) { rbt12 = rbtInformada; fonte = 'informada'; }
  else if (ant.length && ant.length < 12) { rbt12 = (soma / ant.length) * 12; fonte = 'estimada'; }
  else if (!ant.length) { rbt12 = N(atual.n.vendas) * 12; fonte = 'inicio'; }
  const fx = Math.max(0, ANEXO_I.findIndex((f) => rbt12 <= f[0]));
  const faixa = rbt12 > 4800000 ? 5 : fx;
  const [, nom, pd] = ANEXO_I[faixa];
  const efetiva = rbt12 <= 180000 ? nom : (rbt12 * nom - pd) / rbt12;
  const rep = REPART[faixa];
  const receita = N(atual.n.vendas), mono = Math.min(receita, N(atual.ap.pcMono)), st = Math.min(receita, N(atual.ap.stSubst));
  const bruto = receita * efetiva;
  const descMono = mono * efetiva * (rep.pis + rep.cofins) / 100, descSt = st * efetiva * rep.icms / 100;
  const das = Math.max(0, bruto - descMono - descSt);
  const partes = Object.fromEntries(Object.entries(rep).map(([k, v]) => [k, r2(bruto * v / 100 - (k === 'pis' || k === 'cofins' ? mono * efetiva * v / 100 : 0) - (k === 'icms' ? descSt : 0))]));
  return {
    rbt12: r2(rbt12), rbtFonte: fonte, mesesPortal: ant.length, somaPortal: r2(soma), faixa: faixa + 1, faixaDe: faixa ? ANEXO_I[faixa - 1][0] : 0, faixaAte: ANEXO_I[faixa][0],
    nominal: nom, deduzir: pd, efetiva, receita: r2(receita), mono: r2(mono), st: r2(st), descMono: r2(descMono), descSt: r2(descSt), das: r2(das), partes,
    sublimite: rbt12 > 3600000, excedeu: rbt12 > 4800000,
  };
}

function presumido(meses: any[], mes: string, atual: any) {
  const ap = atual.ap, receita = N(atual.n.vendas);
  // PIS e COFINS cumulativos: receita das vendas com CST de PIS 01/02/03, menos a parte das devoluções; ICMS destacado excluído (Tema 69 do STF)
  const totPc = N(ap.pcTrib) + N(ap.pcNaoTrib), parte = totPc ? N(ap.pcTrib) / totPc : 0;
  const devolucoes = N(atual.n.devolucoes) * parte, icmsExcl = N(ap.icmsVendas) * parte;
  const baseSemExcl = Math.max(0, N(ap.pcTrib) - devolucoes), base = Math.max(0, baseSemExcl - icmsExcl);
  const pc = { receitaTributada: r2(N(ap.pcTrib)), receitaSemTributo: r2(N(ap.pcNaoTrib)), monofasico: r2(N(ap.pcMono)), parteNaoTrib: totPc ? N(ap.pcNaoTrib) / totPc : 0,
    devolucoes: r2(devolucoes), icmsExcluido: r2(icmsExcl), base: r2(base), baseSemExcl: r2(baseSemExcl),
    pis: r2(base * 0.0065), cofins: r2(base * 0.03), pisSemExcl: r2(baseSemExcl * 0.0065), cofinsSemExcl: r2(baseSemExcl * 0.03), pisDest: r2(N(ap.pisDest)), cofinsDest: r2(N(ap.cofinsDest)) };
  // ICMS: débitos das saídas menos créditos das entradas, levando o saldo credor dos meses anteriores que estão no portal
  let credorAnt = 0; const primeiro = meses.length ? meses[0].mes : mes;
  for (const m of meses) { if (m.mes >= mes) break; credorAnt = Math.max(0, credorAnt + N(m.ap.icmsCred) - N(m.ap.icmsDeb)); }
  const saldo = N(ap.icmsDeb) - N(ap.icmsCred) - credorAnt;
  const icms = { debitos: r2(N(ap.icmsDeb)), creditos: r2(N(ap.icmsCred)), credorAnterior: r2(credorAnt), desde: primeiro, aPagar: r2(Math.max(0, saldo)), credorProximo: r2(Math.max(0, -saldo)) };
  // IRPJ e CSLL trimestrais (comércio: presunção de 8% e 12%); LC 224/2025: +10% na presunção sobre a receita do trimestre acima de R$ 1,25 milhão
  const ano = +mes.slice(0, 4), mm = +mes.slice(5, 7), q = Math.floor((mm - 1) / 3), mIni = ano + '-' + String(q * 3 + 1).padStart(2, '0');
  const mesesQ = meses.filter((m) => m.mes >= mIni && m.mes <= mes), receitaQ = mesesQ.reduce((a, m) => a + N(m.n.vendas), 0), nQ = mm - q * 3;
  const LIM = 1250000, exced = Math.max(0, receitaQ - LIM), cslLC224 = mes >= '2026-04';
  const baseIR = 0.08 * (receitaQ - exced) + 0.088 * exced, baseCS = 0.12 * (receitaQ - (cslLC224 ? exced : 0)) + (cslLC224 ? 0.132 * exced : 0);
  const adicional = 0.10 * Math.max(0, baseIR - 20000 * nQ);
  const irpjQ = 0.15 * baseIR + adicional, csllQ = 0.09 * baseCS, parteMes = receitaQ ? receita / receitaQ : 0;
  const venc = mesMais(ano + '-' + String(q * 3 + 3).padStart(2, '0'), 1);
  const ir = { trimestre: q + 1, mesesTrimestre: mesesQ.map((m) => m.mes), mesesFaltando: 3 - nQ, receitaTrimestre: r2(receitaQ), receitaMes: r2(receita), excedente: r2(exced),
    baseIrpj: r2(baseIR), baseCsll: r2(baseCS), irpjNormal: r2(0.15 * baseIR), adicional: r2(adicional), irpjTrimestre: r2(irpjQ), csllTrimestre: r2(csllQ),
    irpjMes: r2(irpjQ * parteMes), csllMes: r2(csllQ * parteMes), vencimento: venc };
  return { pc, icms, ir };
}

async function apuracao(req: any) {
  const s = await sessao(req.token);
  if (!s.contabs.length || !podeVer(s, req.contabilidade)) throw new Error('Sem permissão para esta contabilidade.');
  const mes = String(req.mes || ''); if (!/^\d{4}-\d{2}$/.test(mes)) throw new Error('Mês inválido.');
  const { data: u } = await db.from('unidades').select('id, contabilidade, cliente, subpasta').eq('contab_n', normal(req.contabilidade)).eq('cliente_n', normal(req.cliente)).eq('subpasta_n', normal(req.subpasta)).maybeSingle();
  if (!u) throw new Error('Cliente não encontrado.');
  const [{ data: ms, error }, { data: rg }] = await Promise.all([
    db.rpc('apuracao', { p_unidade: u.id, p_mes: mes }),
    db.from('regimes').select('regime').eq('contab_n', normal(u.contabilidade)).eq('cliente_n', normal(u.cliente)).maybeSingle(),
  ]);
  if (error) throw new Error('Banco: ' + error.message);
  const meses = ms || [], atual = meses.find((m: any) => m.mes === mes);
  if (!atual) throw new Error('Sem resumo deste mês no portal.');
  const regime = String(rg?.regime || atual.ind?.regime || (atual.n.crt === '3' ? 'NORMAL' : atual.n.crt === '4' ? 'MEI' : atual.n.crt ? 'SN' : ''));
  const out: any = { mes, regime, receita: r2(N(atual.n.vendas)), devolucoes: r2(N(atual.n.devolucoes)), transferencias: r2(N(atual.n.transferencias)) };
  if (regime === 'SN') out.simples = simples(meses, mes, atual, req.rbt12 != null ? Number(req.rbt12) : null);
  else if (regime === 'PRESUMIDO' || regime === 'NORMAL') out.presumido = presumido(meses, mes, atual);
  else if (regime === 'REAL') out.real = { icms: presumido(meses, mes, atual).icms };
  return out;
}

Deno.serve(async (r) => {
  if (r.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const req = JSON.parse(await r.text());
    if (req.acao === 'reuniao') return json({ ok: true, r: await reuniao(req) });
    if (req.acao === 'carteira') return json({ ok: true, r: await carteira(req) });
    if (req.acao === 'apuracao') return json({ ok: true, r: await apuracao(req) });
    return json({ ok: false, erro: 'Ação desconhecida.' });
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) });
  }
});
