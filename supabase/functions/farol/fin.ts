// Farol Contábil — BPO financeiro direto no banco (antes: arquivos JSON no Drive, via Apps Script).
// Mesmas funções e respostas que o portal já usa. Arquivos (comprovantes, anexos, OFX original)
// continuam no Drive: são guardados e lidos pelo receptor (acao 'finArquivo').
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';

type Sessao = { login: string; nome: string; contabs: string[]; empresa?: { contabilidade: string; cliente: string } | null };
type Ctx = {
  db: SupabaseClient;
  sessao: (t: unknown) => Promise<Sessao>;
  normal: (s: unknown) => string;
  podeVer: (s: Sessao, c: string) => boolean;
  receptor: (acao: string, dados: Record<string, unknown>) => Promise<any>;   // pedido autenticado ao Apps Script
  repassar: (fn: string, args: unknown[]) => Promise<any>;
};

export const PLANO_FIN = [
  { id: 'rec_vendas', nome: 'Vendas / recebimentos de clientes', g: 'Receitas' },
  { id: 'rec_cartao', nome: 'Recebimentos de cartão', g: 'Receitas' },
  { id: 'rec_pix', nome: 'PIX recebidos', g: 'Receitas' },
  { id: 'rec_boleto', nome: 'Boletos recebidos', g: 'Receitas' },
  { id: 'rec_deposito', nome: 'Depósitos em dinheiro', g: 'Receitas' },
  { id: 'rec_outras', nome: 'Outras receitas', g: 'Receitas' },
  { id: 'imp_impostos', nome: 'Impostos (DAS, ICMS, federais)', g: 'Impostos' },
  { id: 'cus_mercadorias', nome: 'Compras de mercadorias (revenda)', g: 'Custo das mercadorias' },
  { id: 'cus_frete', nome: 'Fretes sobre compras', g: 'Custo das mercadorias' },
  { id: 'des_folha', nome: 'Salários e encargos (FGTS, INSS)', g: 'Despesas com pessoal' },
  { id: 'des_prolabore', nome: 'Pró-labore', g: 'Despesas com pessoal' },
  { id: 'des_aluguel', nome: 'Aluguel e condomínio', g: 'Despesas operacionais' },
  { id: 'des_energia', nome: 'Energia elétrica', g: 'Despesas operacionais' },
  { id: 'des_agua', nome: 'Água e esgoto', g: 'Despesas operacionais' },
  { id: 'des_telefone', nome: 'Telefone e internet', g: 'Despesas operacionais' },
  { id: 'des_combustivel', nome: 'Combustível', g: 'Despesas operacionais' },
  { id: 'des_manutencao', nome: 'Manutenção e reparos', g: 'Despesas operacionais' },
  { id: 'des_material', nome: 'Material de uso e consumo', g: 'Despesas operacionais' },
  { id: 'des_sistemas', nome: 'Sistemas e software', g: 'Despesas operacionais' },
  { id: 'des_contabilidade', nome: 'Contabilidade e honorários', g: 'Despesas operacionais' },
  { id: 'des_marketing', nome: 'Marketing e propaganda', g: 'Despesas operacionais' },
  { id: 'des_outras', nome: 'Outras despesas', g: 'Despesas operacionais' },
  { id: 'fin_tarifas', nome: 'Tarifas bancárias', g: 'Despesas financeiras' },
  { id: 'fin_taxas_cartao', nome: 'Taxas de cartão', g: 'Despesas financeiras' },
  { id: 'fin_juros', nome: 'Juros e multas', g: 'Despesas financeiras' },
  { id: 'fin_iof', nome: 'IOF', g: 'Despesas financeiras' },
  { id: 'fin_rendimentos', nome: 'Rendimentos de aplicações', g: 'Receitas financeiras' },
  { id: 'nop_transf', nome: 'Transferência entre contas da empresa', g: 'Fora da DRE', fora: true },
  { id: 'nop_aplicacao', nome: 'Aplicação financeira', g: 'Fora da DRE', fora: true },
  { id: 'nop_resgate', nome: 'Resgate de aplicação', g: 'Fora da DRE', fora: true },
  { id: 'nop_emprestimo_in', nome: 'Empréstimo recebido', g: 'Fora da DRE', fora: true },
  { id: 'nop_emprestimo_out', nome: 'Pagamento de empréstimo', g: 'Fora da DRE', fora: true },
  { id: 'nop_retirada', nome: 'Retirada de sócios', g: 'Fora da DRE', fora: true },
  { id: 'nop_aporte', nome: 'Aporte de sócios', g: 'Fora da DRE', fora: true },
  { id: 'nop_ativo', nome: 'Compra de ativo imobilizado', g: 'Fora da DRE', fora: true },
];
const PLANO: Record<string, any> = Object.fromEntries(PLANO_FIN.map((c) => [c.id, c]));
const REGRAS_FIN: [RegExp, string, string][] = [
  [/\bIOF\b/, 'fin_iof', 'D'],
  [/TARIFA|\bTAR\b|CESTA DE SERV|PACOTE DE SERV|PACOTE SERV|MANUT(ENCAO)? (DE )?CONTA|ANUIDADE|TX\.? ?MANUT|\bTAXA DE SERV/, 'fin_tarifas', 'D'],
  [/JUROS|MULTA|ENCARGO|\bMORA\b|ADIANT(AMENTO)? A DEPOSITANTE|\bCHEQUE ESPECIAL/, 'fin_juros', 'D'],
  [/RENDIMENTO|REND\.? APLIC|REMUNERACAO (DE )?APLIC|JUROS S\/ ?CAPITAL/, 'fin_rendimentos', 'C'],
  [/CIELO|REDE ?CARD|\bREDE\b|STONE|GETNET|PAGSEGURO|PAGBANK|SUMUP|SAFRAPAY|MERCADO ?PAGO|MERCADOPAGO|SIPAG|\bVERO\b|\bTON\b|BIN ?SERV|GLOBAL ?PAYMENTS|FISERV|CABAL|VISA ELECTRON|MASTERCARD|ELO SERV|ANTECIPACAO (DE )?RECEB/, 'rec_cartao', 'C'],
  [/SIMPLES NAC|\bDAS\b|RECEITA FED|\bDARF\b|SEFAZ|\bICMS\b|\bGNRE\b|\bIPVA\b|\bIPTU\b|PREFEITURA|\bDAE\b|TRIBUT/, 'imp_impostos', 'D'],
  [/\bFGTS\b|\bINSS\b|\bGPS\b|SALARIO|FOLHA (DE )?PAG|\bFERIAS\b|RESCISAO|13O SAL/, 'des_folha', 'D'],
  [/PRO ?LABORE/, 'des_prolabore', 'D'],
  [/ENERGISA|ELETROACRE|ELETROBRAS|ENERGIA|\bCEMIG\b|\bCOPEL\b|EQUATORIAL|NEOENERGIA|\bENEL\b|\bLIGHT\b|CELPA|COELBA/, 'des_energia', 'D'],
  [/SANEAMENTO|DEPASA|\bSAAE\b|SANEAGO|SABESP|AGUAS? (DE|DO)|CAERD|COSANPA/, 'des_agua', 'D'],
  [/\bVIVO\b|\bCLARO\b|\bTIM\b|TELEFONICA|\bOI\b|EMBRATEL|STARLINK|INTERNET|TELECOM|PROVEDOR/, 'des_telefone', 'D'],
  [/ALUGUEL|CONDOMINIO|LOCACAO DE IMOVEL/, 'des_aluguel', 'D'],
  [/\bPOSTO\b|COMBUST|SHELL|IPIRANGA|PETROBRAS|\bBR DISTRIB|AUTO POSTO/, 'des_combustivel', 'D'],
  [/HONORARIO|CONTABIL/, 'des_contabilidade', 'D'],
  [/APLICACAO|APLIC\.? ?(AUT|FINANC|CDB|RDB)|\bCDB\b|\bRDB\b|POUPANCA|INVEST(IMENTO)? AUT/, 'nop_aplicacao', 'D'],
  [/RESGATE|RESG\.? ?(AUT|APLIC|CDB|RDB)/, 'nop_resgate', 'C'],
  [/EMPRESTIMO|EMPREST|FINANCIAMENTO|CAPITAL DE GIRO|\bCCB\b/, 'nop_emprestimo_in', 'C'],
  [/EMPRESTIMO|EMPREST|FINANCIAMENTO|PARC(ELA)? (DE )?EMPR|CAPITAL DE GIRO|\bCCB\b|CONSORCIO/, 'nop_emprestimo_out', 'D'],
  [/MESMA TITULARIDADE|ENTRE CONTAS|TRANSF(ERENCIA)? (ENTRE|P\/ ?MESMA)|\bTEF\b/, 'nop_transf', ''],
  [/DEP(OSITO)?\.? ?(EM )?(DINHEIRO|ESPECIE)|DEP\.? ?CX|DEPOSITO ?(ONLINE|CAIXA|BALCAO|TERMINAL)|DEP ATM|DEPOSITO$/, 'rec_deposito', 'C'],
  [/COBRANCA|LIQ(UIDACAO)?\.? ?(DE )?(BOLETO|TITULO|COBR)|CRED(ITO)? ?COBR|BOLETO RECEB|TITULO RECEB/, 'rec_boleto', 'C'],
  [/PIX ?(RECEBIDO|REC|CRED|-? ?CREDITO|ENTRADA)|RECEBIMENTO PIX|CRED(ITO)? PIX|TRANSF(ERENCIA)? RECEBIDA|TED RECEBIDA|DOC RECEBIDO/, 'rec_pix', 'C'],
];
export const BANCOS_BR: Record<string, string> = { '001': 'Banco do Brasil', '003': 'Banco da Amazônia', '004': 'Banco do Nordeste', '033': 'Santander', '041': 'Banrisul', '070': 'BRB', '077': 'Inter', '104': 'Caixa',
  '136': 'Unicred', '197': 'Stone', '208': 'BTG Pactual', '212': 'Original', '237': 'Bradesco', '260': 'Nubank', '290': 'PagBank', '323': 'Mercado Pago', '336': 'C6 Bank',
  '341': 'Itaú', '380': 'PicPay', '403': 'Cora', '422': 'Safra', '748': 'Sicredi', '756': 'Sicoob', '085': 'Ailos', '133': 'Cresol', '274': 'Grafeno', '332': 'Acesso', '637': 'Sofisa' };

const N = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
export const finTexto = (t: unknown) => N(t).replace(/[^A-Z0-9\/\.\- ]/g, ' ').replace(/\s+/g, ' ').trim();
export const finChave = (t: unknown) => finTexto(t).replace(/\b\d+([\/\.\-]\d+)*\b/g, ' ').replace(/[\/\.\-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
type Regra = { chave: string; sinal: string; cat: string; criada?: string };
export function finCategorizar(tr: { desc: string; valor: number }, regras: Regra[]) {
  const txt = finTexto(tr.desc), ch = finChave(tr.desc), sinal = tr.valor < 0 ? 'D' : 'C';
  for (const r of regras) if ((!r.sinal || r.sinal === sinal) && r.chave && (ch === r.chave || (r.chave.length >= 8 && ch.includes(r.chave)))) return { cat: r.cat, origem: 'regra' };
  for (const p of REGRAS_FIN) if ((!p[2] || p[2] === sinal) && p[0].test(txt)) return { cat: p[1], origem: 'padrao' };
  return { cat: '', origem: '' };
}
export const finIdConta = (c: any) => [c.banco || 'banco', c.agencia || '0', c.conta || '0'].join('-').replace(/[^\w\-]/g, '');
export function foneNormal(f: unknown) {
  let d = String(f || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 10 || d.length === 11) d = '55' + d;
  if (d.length === 12 && /^55\d{2}[6-9]/.test(d)) d = d.slice(0, 4) + '9' + d.slice(4);
  return d;
}
const diasEntre = (a: string, b: string) => Math.abs((Date.parse(a + 'T12:00:00Z') - Date.parse(b + 'T12:00:00Z')) / 864e5);
const r2 = (v: number) => Math.round(v * 100) / 100;
function erro(e: { message: string } | null) { if (e) throw new Error('Banco: ' + e.message); }

// linha do banco -> lançamento no formato do portal
function trans(l: any) {
  const t: any = { id: l.id, data: String(l.data).slice(0, 10), valor: Number(l.valor), desc: l.descr, doc: l.doc, cat: l.cat, orig: l.orig, st: l.st };
  const x = l.extra || {}; if (x.just) t.just = x.just; if (x.pergunta) t.pergunta = x.pergunta; if (x.comprovante) t.comprovante = x.comprovante;
  return t;
}
function linha(bpoId: number, conta: string, t: any) {
  const extra: any = {}; if (t.just) extra.just = t.just; if (t.pergunta) extra.pergunta = t.pergunta; if (t.comprovante) extra.comprovante = t.comprovante;
  return { bpo_id: bpoId, conta_id: conta, id: t.id, mes: t.data.slice(0, 7), data: t.data, valor: t.valor, descr: t.desc || '', doc: t.doc || '', cat: t.cat || '', orig: t.orig || '', st: t.st || 'pend', extra, atualizado_em: new Date().toISOString() };
}

export function criarFin(C: Ctx) {
  const { db } = C;

  async function acesso(token: unknown, contab: string, cliente: string, nivel: 'ver' | 'responder' | 'operar') {
    const s = await C.sessao(token);
    if (s.contabs.includes('*')) return { s, operador: true, empresa: false };
    if (s.empresa) {
      if (C.normal(s.empresa.contabilidade) !== C.normal(contab) || C.normal(s.empresa.cliente) !== C.normal(cliente)) throw new Error('Sem acesso a esta empresa.');
      if (nivel === 'operar') throw new Error('Só o operador do BPO pode fazer isso.');
      return { s, operador: false, empresa: true };
    }
    if (nivel !== 'ver' || !C.podeVer(s, contab)) throw new Error('Sem acesso a esta empresa.');
    return { s, operador: false, empresa: false };
  }
  async function bpoDe(contab: string, cliente: string) {
    const { data, error } = await db.from('bpo').select('*').eq('contab_n', C.normal(contab)).eq('cliente_n', C.normal(cliente)).maybeSingle();
    erro(error); return data;
  }
  async function bpoId(contab: string, cliente: string): Promise<number> {   // cria a linha (inativa) se o operador mexer antes de ativar
    const b = await bpoDe(contab, cliente); if (b) return b.id;
    const { data, error } = await db.from('bpo').insert({ contabilidade: contab, cliente, ativo: false }).select('id').single();
    if (error && /duplicate/.test(error.message)) return (await bpoDe(contab, cliente))!.id;
    erro(error); return data!.id;
  }
  async function regrasDe(id: number): Promise<Regra[]> {
    const { data, error } = await db.from('fin_regras').select('chave, sinal, cat, criado_em').eq('bpo_id', id).order('criado_em', { ascending: false }).limit(500);
    erro(error); return (data || []).map((r: any) => ({ chave: r.chave, sinal: r.sinal, cat: r.cat, criada: r.criado_em }));
  }
  async function novaRegra(id: number, chave: string, sinal: string, cat: string) {
    erro((await db.from('fin_regras').upsert({ bpo_id: id, chave, sinal, cat, criado_em: new Date().toISOString() }, { onConflict: 'bpo_id,chave,sinal' })).error);
  }
  async function resumoBpo(id: number) {   // pendências abertas (6 meses) e saldo, para a carteira
    const desde = new Date(Date.now() - 190 * 864e5).toISOString().slice(0, 7);
    const [{ count: p1 }, { count: p2 }, { data: cs }] = await Promise.all([
      db.from('fin_lancamentos').select('id', { count: 'exact', head: true }).eq('bpo_id', id).neq('st', 'ok').gte('mes', desde),
      db.from('fin_comprovantes').select('id', { count: 'exact', head: true }).eq('bpo_id', id).neq('st', 'ok'),
      db.from('fin_contas').select('saldo, ultima_importacao').eq('bpo_id', id),
    ]);
    const saldo = r2((cs || []).reduce((a: number, c: any) => a + Number(c.saldo || 0), 0));
    const ult = (cs || []).map((c: any) => c.ultima_importacao).filter(Boolean).sort().pop() || null;
    return { pendencias: (p1 || 0) + (p2 || 0), saldo, ultimoOfx: ult };
  }
  async function atualizarCarteira(id: number) {
    const r = await resumoBpo(id);
    await db.from('bpo').update({ pendencias: r.pendencias, saldo: r.saldo, ultimo_ofx: r.ultimoOfx, atualizado_em: new Date().toISOString() }).eq('id', id);
  }
  async function guardarArquivo(contab: string, cliente: string, pasta: string, nome: string, tipo: string, base64: string): Promise<string> {
    const r = await C.receptor('finArquivo', { op: 'salvar', contabilidade: contab, cliente, pasta, nome, tipo, base64 });
    if (!r?.ok) throw new Error('Não consegui guardar o arquivo no Drive: ' + (r?.erro || ''));
    return r.id;
  }

  // ---------------------------------------------------------------- carteira
  async function portalFinPlano(token: unknown) { await C.sessao(token); return { plano: PLANO_FIN, bancos: BANCOS_BR }; }
  async function portalFinCarteira(token: unknown) {
    const s = await C.sessao(token), adm = s.contabs.includes('*');
    const { data, error } = await db.from('bpo').select('*').order('contab_n').order('cliente_n'); erro(error);
    const { data: us } = await db.from('usuarios').select('login, empresa_contab, empresa_cliente').not('empresa_cliente', 'is', null);
    const logins: Record<string, string> = {}; (us || []).forEach((u: any) => (logins[C.normal(u.empresa_contab) + '|' + C.normal(u.empresa_cliente)] = u.login));
    const carteira = (data || []).filter((b: any) => adm || C.podeVer(s, b.contabilidade)).map((b: any) => ({
      contabilidade: b.contabilidade, cliente: b.cliente, ativo: b.ativo, inicio: b.inicio || '', operador: b.operador, obs: b.obs,
      ultimoOfx: b.ultimo_ofx || '', pendencias: b.pendencias, saldo: Number(b.saldo || 0), telefones: b.whatsapp || [], login: logins[b.contab_n + '|' + b.cliente_n] || '',
    }));
    return { carteira, operador: adm, plano: PLANO_FIN };
  }
  // configurações do BPO continuam na planilha (o agente consulta de noite): grava lá e espelha aqui
  async function portalFinSalvarBpo(token: unknown, b: any) {
    const r = await C.repassar('portalFinSalvarBpo', [token, b]);
    if (!r?.ok) throw new Error(r?.erro || 'Erro ao salvar.');
    await espelharBpo((r.r?.carteira) || []);
    return await portalFinCarteira(token);
  }
  async function portalFinLoginEmpresa(token: unknown, u: any) {
    const r = await C.repassar('portalFinLoginEmpresa', [token, u]);
    if (!r?.ok) throw new Error(r?.erro || 'Erro ao salvar.');
    return await portalFinCarteira(token);
  }
  async function espelharBpo(linhas: any[]) {   // vindo da planilha (sincronização ou depois de salvar)
    for (const b of linhas) {
      if (!b.contabilidade || !b.cliente) continue;
      const row = { contabilidade: b.contabilidade, cliente: b.cliente, ativo: !!b.ativo, inicio: /^\d{4}-\d{2}-\d{2}$/.test(String(b.inicio || '')) ? b.inicio : null,
        operador: String(b.operador || ''), obs: String(b.obs || ''), whatsapp: (b.telefones || []).map(foneNormal).filter(Boolean) };
      const ex = await bpoDe(b.contabilidade, b.cliente);
      if (ex) erro((await db.from('bpo').update(row).eq('id', ex.id)).error);
      else erro((await db.from('bpo').insert(row)).error);
    }
  }

  // ---------------------------------------------------------------- tela do cliente
  async function portalFinCliente(token: unknown, contab: string, cliente: string, mes?: string) {
    const ac = await acesso(token, contab, cliente, 'ver');
    const b = await bpoDe(contab, cliente);
    if (!b && !ac.operador) throw new Error('Esta empresa não está no BPO.');
    const id = b ? b.id : -1;
    const { data: cs } = await db.from('fin_contas').select('*').eq('bpo_id', id);
    const { data: ms } = await db.rpc('fin_meses', { p_bpo: id });
    const meses: string[] = (ms || []).map((m: any) => m.mes).sort().reverse();
    const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Rio_Branco', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
    if (!mes || !/^\d{4}-\d{2}$/.test(mes)) mes = meses.includes(hoje) ? hoje : (meses.filter((m) => m <= hoje)[0] || meses[0] || hoje);
    const indice: any = { contas: {}, meses: meses.slice().sort(), ultimoOfx: '' };
    (cs || []).forEach((c: any) => {
      indice.contas[c.conta_id] = { banco: c.banco, nome: c.nome, agencia: c.agencia, conta: c.conta, saldo: c.saldo == null ? undefined : Number(c.saldo), dataSaldo: c.data_saldo || undefined, ultimaImportacao: c.ultima_importacao || undefined };
      if (c.ultima_importacao && c.ultima_importacao > indice.ultimoOfx) indice.ultimoOfx = c.ultima_importacao;
    });
    const { data: ls, error } = await db.from('fin_lancamentos').select('*').eq('bpo_id', id).eq('mes', mes).order('data').order('id').limit(20000); erro(error);
    const contas: Record<string, any> = {};
    Object.keys(indice.contas).forEach((cid) => (contas[cid] = null));
    (ls || []).forEach((l: any) => { (contas[l.conta_id] = contas[l.conta_id] || { conta: l.conta_id, mes, trans: [] }).trans.push(trans(l)); });
    const desde = meses.slice(0, 6).pop() || mes;
    const { data: ps } = await db.from('fin_lancamentos').select('*').eq('bpo_id', id).neq('st', 'ok').gte('mes', desde).order('data').limit(5000);
    const pendencias = (ps || []).map((l: any) => ({ conta: l.conta_id, mes: l.mes, t: trans(l) }));
    return { bpo: b ? { ativo: b.ativo, inicio: b.inicio || '', operador: b.operador } : null, indice, meses, mes, contas, pendencias,
      regras: ac.operador && b ? await regrasDe(id) : [], plano: PLANO_FIN, papel: ac.operador ? 'operador' : (ac.empresa ? 'empresa' : 'contabilidade') };
  }

  // ---------------------------------------------------------------- importação do OFX (lido no navegador)
  async function portalFinImportar(token: unknown, contab: string, cliente: string, ofx: any) {
    await acesso(token, contab, cliente, 'operar');
    if (!ofx || !Array.isArray(ofx.trans)) throw new Error('Arquivo OFX sem lançamentos.');
    const conta: any = { banco: String(ofx.banco || '').replace(/\D/g, '').slice(-3).padStart(3, '0'), agencia: String(ofx.agencia || '').trim(), conta: String(ofx.conta || '').trim() };
    conta.nome = BANCOS_BR[conta.banco] || String(ofx.bancoNome || ('Banco ' + conta.banco));
    const cid = finIdConta(conta), id = await bpoId(contab, cliente), regras = await regrasDe(id);
    const res: any = { conta: conta.nome + ' ag ' + conta.agencia + ' cc ' + conta.conta, novos: 0, repetidos: 0, pendentes: 0, meses: [] as string[] };
    if (ofx.texto) {   // original no Drive (não segura a importação se falhar)
      const nome = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '') + '_' + String(ofx.arquivo || 'extrato.ofx').replace(/[\\\/:*?"<>|]/g, '-');
      guardarArquivo(contab, cliente, 'ofx', nome, 'text/plain', btoa(unescape(encodeURIComponent(String(ofx.texto))))).catch(() => {});
    }
    // conta bancária (saldo só se o extrato for mais novo)
    const { data: ant } = await db.from('fin_contas').select('*').eq('bpo_id', id).eq('conta_id', cid).maybeSingle();
    const crow: any = { bpo_id: id, conta_id: cid, banco: conta.banco, nome: conta.nome, agencia: conta.agencia, conta: conta.conta, ultima_importacao: new Date().toISOString(),
      saldo: ant?.saldo ?? null, data_saldo: ant?.data_saldo ?? null };
    if (ofx.saldo != null && ofx.dataSaldo && (!ant?.data_saldo || String(ofx.dataSaldo) >= ant.data_saldo)) { crow.saldo = Number(ofx.saldo); crow.data_saldo = String(ofx.dataSaldo); }
    erro((await db.from('fin_contas').upsert(crow, { onConflict: 'bpo_id,conta_id' })).error);
    // lançamentos novos
    const novos: any[] = [];
    ofx.trans.forEach((t: any, i: number) => {
      const data = String(t.data || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return;
      const valor = r2(Number(t.valor)); if (!isFinite(valor) || !valor) return;
      const tid = String(t.fitid || '').trim() || (data + '_' + valor + '_' + finChave(t.desc).slice(0, 20) + '_' + i);
      novos.push({ id: tid, data, valor, desc: String(t.desc || '').slice(0, 200), doc: String(t.doc || '').slice(0, 40) });
    });
    const ja = new Set<string>();
    for (let i = 0; i < novos.length; i += 500) {
      const { data } = await db.from('fin_lancamentos').select('id').eq('bpo_id', id).eq('conta_id', cid).in('id', novos.slice(i, i + 500).map((t) => t.id));
      (data || []).forEach((r: any) => ja.add(r.id));
    }
    const comp = await comprovantesAbertos(id);
    const grava: any[] = [], compMudou: any[] = [], meses = new Set<string>();
    for (const t of novos) {
      if (ja.has(t.id)) { res.repetidos++; continue; }
      ja.add(t.id);
      const c = finCategorizar(t, regras);
      t.cat = c.cat; t.orig = c.origem; t.st = c.cat ? 'ok' : 'pend';
      if (t.valor < 0) { const cp = ligarComprovante(comp, t, cid); if (cp) compMudou.push(cp); }
      if (!t.cat) res.pendentes++;
      grava.push(linha(id, cid, t)); meses.add(t.data.slice(0, 7)); res.novos++;
    }
    for (let i = 0; i < grava.length; i += 500) erro((await db.from('fin_lancamentos').insert(grava.slice(i, i + 500))).error);
    for (const c of compMudou) await db.from('fin_comprovantes').update({ dados: c, st: c.st }).eq('bpo_id', id).eq('id', c.id);
    res.meses = [...meses].sort();
    await atualizarCarteira(id);
    return res;
  }
  async function comprovantesAbertos(id: number) {
    const { data } = await db.from('fin_comprovantes').select('dados').eq('bpo_id', id).is('dados->conciliado', null).limit(3000);
    return (data || []).map((r: any) => r.dados);
  }
  // lançamento novo do extrato: procura comprovante do mesmo valor (até 3 dias) e usa a categoria dele
  function ligarComprovante(lista: any[], t: any, conta: string) {
    const c = lista.find((x) => !x.conciliado && !x.entrada === (t.valor < 0) && x.valor && Math.abs(x.valor - Math.abs(t.valor)) < 0.005 && (!x.data || diasEntre(x.data, t.data) <= 3));
    if (!c) return null;
    c.conciliado = { conta, mes: t.data.slice(0, 7), id: t.id, data: t.data };
    t.comprovante = c.id;
    if (c.cat) { t.cat = c.cat; t.orig = 'comprovante'; t.st = 'ok'; }
    if (c.texto || c.descricao) t.just = { texto: c.texto || c.descricao, anexo: c.arquivoId, anexoNome: c.arquivoNome, quem: c.de || 'comprovante', quando: c.recebidoEm };
    return c;
  }

  // ---------------------------------------------------------------- operador e empresa
  async function lancamentos(id: number, conta: string, ids: string[]) {
    const { data, error } = await db.from('fin_lancamentos').select('*').eq('bpo_id', id).eq('conta_id', conta).in('id', ids); erro(error);
    return data || [];
  }
  async function portalFinCategorizar(token: unknown, contab: string, cliente: string, conta: string, mes: string, ids: unknown, cat: string, criarRegra: boolean) {
    await acesso(token, contab, cliente, 'operar');
    if (!PLANO[cat]) throw new Error('Categoria inválida.');
    const lista = ([] as string[]).concat(ids as any || []).map(String);
    const b = await bpoDe(contab, cliente); if (!b) throw new Error('Conta não encontrada.');
    const alvo = await lancamentos(b.id, conta, lista);
    if (!alvo.length) throw new Error('Lançamento não encontrado.');
    erro((await db.from('fin_lancamentos').update({ cat, orig: 'manual', st: 'ok', atualizado_em: new Date().toISOString() }).eq('bpo_id', b.id).eq('conta_id', conta).in('id', lista)).error);
    let extra = 0;
    if (criarRegra) {
      const ch = finChave(alvo[0].descr), sinal = Number(alvo[0].valor) < 0 ? 'D' : 'C';
      if (ch.length >= 4) {
        await novaRegra(b.id, ch, sinal, cat);
        const regras = await regrasDe(b.id);
        const { data: pend } = await db.from('fin_lancamentos').select('id, descr, valor').eq('bpo_id', b.id).eq('conta_id', conta).eq('mes', mes).eq('st', 'pend');
        const pegar = (pend || []).filter((t: any) => { const r = finCategorizar({ desc: t.descr, valor: Number(t.valor) }, regras); return r.cat === cat && r.origem === 'regra'; }).map((t: any) => t.id);
        if (pegar.length) { erro((await db.from('fin_lancamentos').update({ cat, orig: 'regra', st: 'ok' }).eq('bpo_id', b.id).eq('conta_id', conta).in('id', pegar)).error); extra = pegar.length; }
      }
    }
    await atualizarCarteira(b.id);
    return { ok: true, alterados: alvo.length + extra };
  }
  async function portalFinSolicitar(token: unknown, contab: string, cliente: string, conta: string, _mes: string, ids: unknown, pergunta: string) {
    await acesso(token, contab, cliente, 'operar');
    const b = await bpoDe(contab, cliente); if (!b) throw new Error('Conta não encontrada.');
    for (const l of await lancamentos(b.id, conta, ([] as string[]).concat(ids as any || []).map(String))) {
      if (l.st === 'ok') continue;
      erro((await db.from('fin_lancamentos').update({ st: 'cliente', extra: { ...(l.extra || {}), pergunta: String(pergunta || '').slice(0, 300) } }).eq('bpo_id', b.id).eq('conta_id', conta).eq('id', l.id)).error);
    }
    return { ok: true };
  }
  async function portalFinJustificar(token: unknown, contab: string, cliente: string, conta: string, mes: string, id: string, texto: string, anexo: any) {
    const ac = await acesso(token, contab, cliente, 'responder');
    if (!String(texto || '').trim() && !anexo) throw new Error('Escreva a justificativa ou anexe o comprovante.');
    const b = await bpoDe(contab, cliente); if (!b) throw new Error('Conta não encontrada.');
    const [l] = await lancamentos(b.id, conta, [String(id)]); if (!l) throw new Error('Lançamento não encontrado.');
    let anexoId = '';
    if (anexo && anexo.base64) {
      if (anexo.base64.length * 0.75 > 5 * 1024 * 1024) throw new Error('O comprovante pode ter no máximo 5 MB.');
      const nome = mes + '_' + String(id).replace(/[^\w\-]/g, '').slice(0, 30) + '_' + String(anexo.nome || 'comprovante').replace(/[\\\/:*?"<>|]/g, '-');
      anexoId = await guardarArquivo(contab, cliente, 'anexos', nome, anexo.tipo || 'application/octet-stream', anexo.base64);
    }
    const x = l.extra || {};
    x.just = { texto: String(texto || '').slice(0, 1000), anexo: anexoId || x.just?.anexo || '', anexoNome: anexo ? String(anexo.nome || '') : (x.just?.anexoNome || ''), quem: ac.s.nome, quando: new Date().toISOString() };
    erro((await db.from('fin_lancamentos').update({ extra: x, st: l.st === 'ok' ? 'ok' : 'just', atualizado_em: new Date().toISOString() }).eq('bpo_id', b.id).eq('conta_id', conta).eq('id', l.id)).error);
    await atualizarCarteira(b.id);
    return { ok: true };
  }
  async function portalFinAnexo(token: unknown, contab: string, cliente: string, anexoId: string) {
    await acesso(token, contab, cliente, 'ver');
    const r = await C.receptor('finArquivo', { op: 'ler', contabilidade: contab, cliente, id: anexoId });
    if (!r?.ok) throw new Error(r?.erro || 'Arquivo não encontrado.');
    return { nome: r.nome, tipo: r.tipo, base64: r.base64 };
  }
  async function portalFinRemoverRegra(token: unknown, contab: string, cliente: string, chave: string, sinal: string) {
    await acesso(token, contab, cliente, 'operar');
    const b = await bpoDe(contab, cliente); if (!b) return { ok: true };
    erro((await db.from('fin_regras').delete().eq('bpo_id', b.id).eq('chave', chave).eq('sinal', sinal || '')).error);
    return { ok: true };
  }

  // ---------------------------------------------------------------- comprovantes (portal e WhatsApp)
  async function lerComprovanteIA(b64: string, mime: string, texto: string) {
    const key = Deno.env.get('ANTHROPIC_KEY');
    if (!key) return { ok: false, motivo: 'leitura automática desligada (falta a chave da IA)' };
    mime = String(mime || '').toLowerCase();
    let bloco: any;
    if (/pdf/.test(mime)) bloco = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } };
    else if (/image\/(jpe?g|png|gif|webp)/.test(mime)) bloco = { type: 'image', source: { type: 'base64', media_type: mime.replace('jpg', 'jpeg'), data: b64 } };
    else return { ok: false, motivo: 'formato não suportado (' + mime + ')' };
    const cats = PLANO_FIN.map((c) => c.id + ' = ' + c.nome).join('\n');
    const pedido = 'Você lê comprovantes de pagamento de empresas brasileiras (PIX, boleto, TED, cartão, DAS, guias).\n' +
      (texto ? 'Mensagem que o cliente mandou junto: "' + String(texto).slice(0, 500) + '"\n' : '') +
      'Responda SOMENTE com um JSON, sem texto antes ou depois, com estes campos:\n' +
      '{"tipo_documento":"comprovante|boleto|nota|outro","entrada":false,"valor":0.00,"data":"AAAA-MM-DD","hora":"HH:MM","forma":"PIX|BOLETO|TED|DOC|TRANSFERENCIA|CARTAO|DINHEIRO|DEBITO_AUTOMATICO|OUTRO",' +
      '"pagador":"","recebedor":"","documento_recebedor":"","banco":"","observacao":"","codigo_barras":"","descricao":"","categoria":"","confianca":0.0}\n' +
      '- entrada = true só se o documento for de dinheiro RECEBIDO pela empresa.\n' +
      '- observacao = o texto de descrição/mensagem escrito no próprio comprovante, se houver.\n' +
      '- descricao = uma frase curta dizendo o que foi o pagamento.\n' +
      '- categoria = um dos códigos abaixo, só se tiver segurança pelo recebedor, observação, código de barras ou mensagem; senão "".\n' + cats + '\n' +
      '- confianca de 0 a 1. Campos que não aparecem: "" ou 0.';
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: Deno.env.get('ANTHROPIC_MODELO') || 'claude-haiku-5-5', max_tokens: 700, messages: [{ role: 'user', content: [bloco, { type: 'text', text: pedido }] }] }),
    });
    if (r.status !== 200) return { ok: false, motivo: 'IA respondeu ' + r.status + ': ' + (await r.text()).slice(0, 200) };
    try {
      const txt = ((await r.json()).content || []).map((c: any) => c.text || '').join('');
      const d = JSON.parse((txt.match(/\{[\s\S]*\}/) || ['{}'])[0]);
      d.valor = Math.abs(Number(String(d.valor).replace(',', '.')) || 0);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d.data || ''))) d.data = '';
      return { ok: true, dados: d };
    } catch { return { ok: false, motivo: 'não entendi a resposta da IA' }; }
  }
  function categoriaComprovante(c: any, regras: Regra[]) {
    const desc = [c.recebedor, c.obs, c.descricao, c.texto].filter(Boolean).join(' ');
    const r = finCategorizar({ desc, valor: c.entrada ? c.valor : -c.valor }, regras);
    if (r.origem === 'regra') return { cat: r.cat, origem: 'regra' };
    if (c.catIA && PLANO[c.catIA]) return { cat: c.catIA, origem: 'ia' };
    if (r.cat) return { cat: r.cat, origem: 'padrao' };
    const cb = String(c.codigoBarras || '').replace(/\D/g, '');
    if (/^8\d{2}[0-9]/.test(cb) && cb.charAt(1) === '1') return { cat: 'imp_impostos', origem: 'padrao' };
    return { cat: '', origem: '' };
  }
  // comprovante novo: procura lançamento do extrato já importado (mesmo valor, até 3 dias)
  async function conciliarComprovante(id: number, c: any) {
    if (!c.valor || !c.data) return null;
    const d0 = new Date(Date.parse(c.data + 'T12:00:00Z') - 3 * 864e5).toISOString().slice(0, 10), d1 = new Date(Date.parse(c.data + 'T12:00:00Z') + 3 * 864e5).toISOString().slice(0, 10);
    const { data } = await db.from('fin_lancamentos').select('*').eq('bpo_id', id).eq('valor', c.entrada ? c.valor : -c.valor).gte('data', d0).lte('data', d1).is('extra->comprovante', null).order('data').limit(1);
    const l = data?.[0]; if (!l) return null;
    const x = l.extra || {}; x.comprovante = c.id;
    const upd: any = { extra: x };
    if (c.cat && (l.st !== 'ok' || l.orig !== 'manual')) { upd.cat = c.cat; upd.orig = 'comprovante'; upd.st = 'ok'; }
    if (!x.just && (c.texto || c.descricao)) x.just = { texto: c.texto || c.descricao, anexo: c.arquivoId, anexoNome: c.arquivoNome, quem: c.de || 'comprovante', quando: c.recebidoEm };
    erro((await db.from('fin_lancamentos').update(upd).eq('bpo_id', id).eq('conta_id', l.conta_id).eq('id', l.id)).error);
    return { conta: l.conta_id, mes: l.mes, id: l.id, data: String(l.data).slice(0, 10) };
  }
  function msgComprovante(c: any, cliente: string) {
    const brl = (v: number) => 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    const dt = c.data ? c.data.slice(8, 10) + '/' + c.data.slice(5, 7) + '/' + c.data.slice(0, 4) : '';
    if (!c.lido) return '📎 Recebido! Nossa equipe vai conferir e lançar este comprovante. (' + cliente + ')';
    const l = brl(c.valor) + (c.recebedor ? ' · ' + c.recebedor : '') + (c.forma ? ' · ' + c.forma : '') + (dt ? ' · ' + dt : '');
    if (c.cat) return '✅ Recebido e lançado – ' + cliente + '\n' + l + '\nCategoria: ' + (PLANO[c.cat] || {}).nome;
    return '⚠️ Recebido – ' + cliente + '\n' + l + '\nNão consegui identificar o que foi este pagamento. Responda esta mensagem com uma frase explicando (ex.: compra de material de limpeza).';
  }
  async function novoComprovante(contab: string, cliente: string, arq: any, texto: string, origem: string, de: string) {
    if (!arq || !arq.base64) throw new Error('Envie o comprovante (foto ou PDF).');
    if (arq.base64.length * 0.75 > 8 * 1024 * 1024) throw new Error('Arquivo grande demais (máximo 8 MB).');
    const id = await bpoId(contab, cliente), agora = new Date();
    const cid = 'cp' + agora.getTime().toString(36) + Math.floor(Math.random() * 1e3);
    const nome = agora.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '_') + '_' + cid + '_' + String(arq.nome || 'comprovante').replace(/[\\\/:*?"<>|]/g, '-').slice(-60);
    const [arquivoId, leitura] = await Promise.all([
      guardarArquivo(contab, cliente, 'anexos/comprovantes', nome, arq.tipo || 'application/octet-stream', arq.base64),
      lerComprovanteIA(arq.base64, arq.tipo, texto),
    ]);
    const d: any = (leitura as any).ok ? (leitura as any).dados : {};
    const c: any = { id: cid, recebidoEm: agora.toISOString(), origem, de: de || '', arquivoId, arquivoNome: nome, tipoArquivo: arq.tipo || '',
      texto: String(texto || '').slice(0, 500), lido: !!(leitura as any).ok, motivo: (leitura as any).ok ? '' : (leitura as any).motivo,
      valor: Number(d.valor || 0), data: d.data || '', hora: d.hora || '', forma: d.forma || '', recebedor: d.recebedor || '', docRecebedor: d.documento_recebedor || '',
      banco: d.banco || '', obs: d.observacao || '', codigoBarras: d.codigo_barras || '', descricao: d.descricao || '', catIA: d.categoria || '', confianca: Number(d.confianca || 0),
      entrada: d.entrada === true, tipoDoc: d.tipo_documento || '' };
    const cat = categoriaComprovante(c, await regrasDe(id));
    c.cat = cat.cat; c.origemCat = cat.origem; c.st = !c.lido ? 'ler' : (c.cat ? 'ok' : 'pend');
    try { c.conciliado = await conciliarComprovante(id, c); } catch { c.conciliado = null; }
    erro((await db.from('fin_comprovantes').insert({ bpo_id: id, id: cid, st: c.st, dados: c })).error);
    await atualizarCarteira(id);
    return { comprovante: c, msg: msgComprovante(c, cliente) };
  }
  async function portalFinComprovante(token: unknown, contab: string, cliente: string, arq: any, texto: string) {
    const ac = await acesso(token, contab, cliente, 'responder');
    return await novoComprovante(contab, cliente, arq, texto, 'portal', ac.s.nome);
  }
  async function portalFinComprovantes(token: unknown, contab: string, cliente: string) {
    await acesso(token, contab, cliente, 'ver');
    const b = await bpoDe(contab, cliente);
    const { data } = b ? await db.from('fin_comprovantes').select('dados').eq('bpo_id', b.id).order('criado_em', { ascending: false }).limit(400) : { data: [] };
    return { comprovantes: (data || []).map((r: any) => r.dados), iaLigada: !!Deno.env.get('ANTHROPIC_KEY') };
  }
  async function portalFinCorrigirComprovante(token: unknown, contab: string, cliente: string, cid: string, campos: any, criarRegra: boolean) {
    await acesso(token, contab, cliente, 'operar');
    const b = await bpoDe(contab, cliente); if (!b) throw new Error('Comprovante não encontrado.');
    const { data: row } = await db.from('fin_comprovantes').select('dados').eq('bpo_id', b.id).eq('id', cid).maybeSingle();
    if (!row) throw new Error('Comprovante não encontrado.');
    const c = row.dados; campos = campos || {};
    if (campos.valor !== undefined) c.valor = Math.abs(Number(String(campos.valor).replace(',', '.')) || 0);
    if (campos.data !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(campos.data)) c.data = campos.data;
    ['recebedor', 'forma', 'descricao'].forEach((k) => { if (campos[k] !== undefined) c[k] = String(campos[k]).slice(0, 200); });
    if (campos.cat !== undefined) { if (campos.cat && !PLANO[campos.cat]) throw new Error('Categoria inválida.'); c.cat = campos.cat; c.origemCat = 'manual'; }
    c.lido = true; c.st = c.cat ? 'ok' : 'pend';
    if (criarRegra && c.cat && c.recebedor) { const ch = finChave(c.recebedor); if (ch.length >= 4) await novaRegra(b.id, ch, c.entrada ? 'C' : 'D', c.cat); }
    if (!c.conciliado) { try { c.conciliado = await conciliarComprovante(b.id, c); } catch { /* segue */ } }
    else if (c.cat) {
      await db.from('fin_lancamentos').update({ cat: c.cat, orig: 'comprovante', st: 'ok' }).eq('bpo_id', b.id).eq('conta_id', c.conciliado.conta).eq('id', c.conciliado.id).neq('orig', 'manual');
    }
    erro((await db.from('fin_comprovantes').update({ dados: c, st: c.st }).eq('bpo_id', b.id).eq('id', cid)).error);
    await atualizarCarteira(b.id);
    return { comprovante: c };
  }

  // ---------------------------------------------------------------- WhatsApp (ponte da Meta chama aqui)
  async function waBaixarMidia(mediaId: string, mime: string, nome: string) {
    const tk = Deno.env.get('WA_TOKEN'); if (!tk) throw new Error('WhatsApp não configurado (falta WA_TOKEN).');
    const v = Deno.env.get('WA_VERSAO') || 'v24.0';
    const info = await (await fetch('https://graph.facebook.com/' + v + '/' + encodeURIComponent(mediaId), { headers: { Authorization: 'Bearer ' + tk } })).json();
    const bin = new Uint8Array(await (await fetch(info.url, { headers: { Authorization: 'Bearer ' + tk } })).arrayBuffer());
    let s = ''; for (let i = 0; i < bin.length; i += 0x8000) s += String.fromCharCode(...bin.subarray(i, i + 0x8000));
    const tipo = mime || info.mime_type || 'application/octet-stream';
    return { nome: nome || ('whatsapp.' + (/pdf/.test(tipo) ? 'pdf' : 'jpg')), tipo, base64: btoa(s) };
  }
  async function waEnviar(para: string, texto: string) {
    const tk = Deno.env.get('WA_TOKEN'), fid = Deno.env.get('WA_PHONE_ID'); if (!tk || !fid) return;
    await fetch('https://graph.facebook.com/' + (Deno.env.get('WA_VERSAO') || 'v24.0') + '/' + fid + '/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + tk },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: String(para).replace(/\D/g, ''), type: 'text', text: { body: String(texto).slice(0, 4000) } }),
    });
  }
  async function whatsapp(req: any) {
    const seg = Deno.env.get('WA_SEGREDO');
    if (!seg || req.segredo !== seg) return { ok: false, erro: 'não autorizado' };
    const f = foneNormal(req.de);
    const { data: bs } = await db.from('bpo').select('*').eq('ativo', true).contains('whatsapp', [f]).limit(1);
    const b = bs?.[0]; if (!b) return { ok: true, ignorado: 'número não autorizado' };
    let resposta = '';
    if (req.mediaId) {
      const arq = await waBaixarMidia(req.mediaId, req.mime, req.arquivo);
      const r = await novoComprovante(b.contabilidade, b.cliente, arq, req.texto || '', 'whatsapp', f + (req.nome ? ' (' + req.nome + ')' : ''));
      resposta = r.msg;
    } else {
      const txt = String(req.texto || '').trim();
      const { data: ult } = await db.from('fin_comprovantes').select('id, dados, criado_em').eq('bpo_id', b.id).eq('dados->>origem', 'whatsapp').like('dados->>de', f + '%')
        .gte('criado_em', new Date(Date.now() - 30 * 60e3).toISOString()).order('criado_em', { ascending: false }).limit(1);
      const c = ult?.[0]?.dados;
      if (c && txt) {   // texto logo depois de um comprovante = explicação dele
        c.texto = (c.texto ? c.texto + ' | ' : '') + txt.slice(0, 300);
        if (!c.cat) { const cat = categoriaComprovante(c, await regrasDe(b.id)); if (cat.cat) { c.cat = cat.cat; c.origemCat = cat.origem; c.st = 'ok'; } else c.st = c.lido ? 'just' : 'ler'; }
        await db.from('fin_comprovantes').update({ dados: c, st: c.st }).eq('bpo_id', b.id).eq('id', c.id);
        resposta = c.cat ? '✅ Anotado e lançado como: ' + PLANO[c.cat].nome : '📝 Anotado! Nossa equipe vai lançar com essa explicação.';
      }
      if (!resposta) resposta = 'Olá! Este é o número do BPO financeiro da CPUSIS (' + b.cliente + '). Envie aqui a foto ou o PDF do comprovante de pagamento, de preferência dizendo o que foi.';
    }
    try { await waEnviar(req.de, resposta); } catch { /* segue */ }
    return { ok: true, resposta };
  }

  return {
    funcoes: { portalFinPlano, portalFinCarteira, portalFinSalvarBpo, portalFinLoginEmpresa, portalFinCliente, portalFinImportar, portalFinCategorizar, portalFinSolicitar,
      portalFinJustificar, portalFinAnexo, portalFinRemoverRegra, portalFinComprovante, portalFinComprovantes, portalFinCorrigirComprovante } as Record<string, (...a: any[]) => Promise<unknown>>,
    whatsapp, espelharBpo,
  };
}
