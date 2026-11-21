// Farol Contábil — API do portal no Supabase (Edge Function "farol").
// O portal (GitHub Pages) chama esta função com o mesmo formato que usava no Apps Script:
//   POST { acao: 'portal', fn, args }  ->  { ok: true, r } | { ok: false, erro }
// O que é dado (login, painel, resumos, indicadores) é respondido aqui, direto do banco.
// O que mexe em arquivos do Drive (ZIP, comprovantes, criar pastas...) é repassado ao receptor (Apps Script),
// junto com a sessão já conferida.
// O receptor alimenta o banco com POST { acao: 'sync', senha, itens: [...] }.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { criarFin } from './fin.ts';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const SENHA = Deno.env.get('RECEPTOR_SENHA') || '';
const RECEPTOR = Deno.env.get('RECEPTOR_URL') || 'https://script.google.com/macros/s/AKfycbwySsHymDOemTCxV-Oe-j4B0xHK1OIOtBDF-KjIdhHA0cf9YmLoUcP3AnRVpgW1AZLU/exec';
const VERSAO = '2.0-db';
const SESSAO_HORAS = 6;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey, x-client-info',
  'Access-Control-Max-Age': '86400',
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });

// ---------------------------------------------------------------- utilidades (iguais às do receptor)
export function normal(s: unknown): string {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
}
async function sha256hex(t: string): Promise<string> {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');
}
export async function hashSenha(sal: string, senha: string): Promise<string> {
  let h = sal + ':' + senha;
  for (let i = 0; i < 300; i++) h = await sha256hex(h + ':' + sal);
  return h;
}
function iguais(a: string, b: string): boolean {   // comparação em tempo constante
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function novoToken(): string {
  const b = new Uint8Array(32); crypto.getRandomValues(b);
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}
const mesOk = (m: unknown) => /^\d{4}-\d{2}$/.test(String(m));

type Sessao = { login: string; nome: string; contabs: string[]; empresa?: { contabilidade: string; cliente: string } | null };
function podeVer(s: Sessao, contab: string): boolean {
  if (s.contabs.includes('*')) return true;
  const n = normal(contab);
  return s.contabs.some((c) => normal(c) === n);
}
function erroDb(e: { message: string } | null) { if (e) throw new Error('Banco: ' + e.message); }

// ---------------------------------------------------------------- sessão
async function sessao(token: unknown): Promise<Sessao> {
  const t = String(token || '');
  if (!/^[0-9a-f]{64}$/.test(t)) throw new Error('SESSAO_EXPIRADA');
  const { data, error } = await db.from('sessoes').select('dados, expira_em').eq('token', t).maybeSingle();
  erroDb(error);
  if (!data || new Date(data.expira_em).getTime() < Date.now()) throw new Error('SESSAO_EXPIRADA');
  // renova (janela deslizante), sem esperar
  if (new Date(data.expira_em).getTime() - Date.now() < (SESSAO_HORAS - 1) * 3600e3) {
    db.from('sessoes').update({ expira_em: new Date(Date.now() + SESSAO_HORAS * 3600e3).toISOString() }).eq('token', t).then(() => {});
  }
  return data.dados as Sessao;
}
async function logAcesso(login: string, acao: string, detalhe: string) {
  await db.from('acessos').insert({ login, acao, detalhe: detalhe.slice(0, 300) });
}

async function portalLogin(login: unknown, senha: unknown) {
  const l = String(login || '').trim().toLowerCase();
  if (!l || !senha) return { ok: false, erro: 'Informe login e senha.' };
  const { data: tent } = await db.from('tentativas_login').select('falhas, ate').eq('login', l).maybeSingle();
  if (tent && tent.falhas >= 8 && Date.now() - new Date(tent.ate).getTime() < 15 * 60e3) return { ok: false, erro: 'Muitas tentativas. Aguarde 15 minutos.' };
  const { data: u, error } = await db.from('usuarios').select('*').eq('login', l).maybeSingle();
  erroDb(error);
  let certo = false;
  if (u && u.ativo !== false) {
    const p = String(u.senha_hash || '').split('$');
    if (p.length === 2) certo = iguais(await hashSenha(p[0], String(senha)), p[1]);
  } else if (u && u.ativo === false) return { ok: false, erro: 'Acesso desativado. Fale com a CPUSIS.' };
  if (!certo) {
    const falhas = tent && Date.now() - new Date(tent.ate).getTime() < 15 * 60e3 ? tent.falhas + 1 : 1;
    await db.from('tentativas_login').upsert({ login: l, falhas, ate: new Date().toISOString() });
    return { ok: false, erro: 'Login ou senha incorretos.' };
  }
  await db.from('tentativas_login').delete().eq('login', l);
  const s: Sessao = { login: l, nome: u.nome || l, contabs: u.contabs || [] };
  if (u.empresa_contab && u.empresa_cliente) { s.empresa = { contabilidade: u.empresa_contab, cliente: u.empresa_cliente }; s.contabs = []; }
  const token = novoToken();
  const { error: e2 } = await db.from('sessoes').insert({ token, login: l, dados: s, expira_em: new Date(Date.now() + SESSAO_HORAS * 3600e3).toISOString() });
  erroDb(e2);
  await db.from('usuarios').update({ ultimo_acesso: new Date().toISOString() }).eq('login', l);
  await logAcesso(l, 'login', 'portal (banco)');
  if (Math.random() < 0.05) await db.rpc('limpar_sessoes');
  return { ok: true, token, nome: s.nome, admin: s.contabs.includes('*'), empresa: s.empresa || null };
}

// ---------------------------------------------------------------- leituras do portal (direto do banco)
async function portalAparencia() {
  const { data } = await db.from('aparencia').select('valor').eq('chave', 'portal').maybeSingle();
  if (data?.valor) { try { return JSON.parse(data.valor); } catch { /* segue */ } }
  return { nome: 'Portal Contábil', cor: '#0f6b55', corEscura: '#4cc29c', fundo: '#f3f5f4' };
}

async function todas<T>(q: () => any, passo = 1000): Promise<T[]> {   // pagina além do limite de 1000 linhas
  const out: T[] = [];
  for (let de = 0; ; de += passo) {
    const { data, error } = await q().range(de, de + passo - 1);
    erroDb(error);
    out.push(...(data || []));
    if (!data || data.length < passo) return out;
  }
}

async function unidadesVisiveis(s: Sessao) {
  const us = await todas<any>(() => db.from('unidades').select('id, contabilidade, cliente, subpasta, drive_pid').order('contab_n').order('cliente_n').order('subpasta_n'));
  return us.filter((u) => podeVer(s, u.contabilidade));
}

async function portalDados(token: unknown) {
  const s = await sessao(token);
  if (s.empresa) return { nome: s.nome, empresa: s.empresa, unidades: [], painel: {}, regimes: {}, versao: VERSAO, admin: false };
  const us = await unidadesVisiveis(s);
  const ids = us.map((u) => u.id);
  const meses: Record<number, string[]> = {};
  for (let i = 0; i < ids.length; i += 300) {
    const rs = await todas<any>(() => db.from('resumos').select('unidade_id, mes').in('unidade_id', ids.slice(i, i + 300)).order('mes', { ascending: false }));
    rs.forEach((r) => (meses[r.unidade_id] = meses[r.unidade_id] || []).push(r.mes));
  }
  const unidades = us.map((u) => ({ contabilidade: u.contabilidade, cliente: u.cliente, subpasta: u.subpasta, meses: meses[u.id] || [], pid: u.drive_pid || '' }));
  const painel: Record<string, unknown> = {};
  const env = await todas<any>(() => db.from('envios').select('contabilidade, cliente, mes, ultimo_contato, situacao, mensagem, maquina, versao'));
  env.forEach((e) => {
    if (!podeVer(s, e.contabilidade)) return;
    painel[normal(e.contabilidade) + '|' + normal(e.cliente) + '|' + e.mes] = {
      ultimoContato: e.ultimo_contato ? new Date(e.ultimo_contato).toISOString() : '', situacao: e.situacao || '', mensagem: e.mensagem || '',
      contabilidade: e.contabilidade, cliente: e.cliente, mes: e.mes, maquina: e.maquina || '', versao: e.versao || '',
    };
  });
  const regimes: Record<string, string> = {};
  const rg = await todas<any>(() => db.from('regimes').select('contabilidade, contab_n, cliente_n, regime'));
  rg.forEach((r) => { if (podeVer(s, r.contabilidade)) regimes[r.contab_n + '|' + r.cliente_n] = r.regime; });
  return { nome: s.nome, unidades, painel, regimes, versao: VERSAO, admin: s.contabs.includes('*') };
}

async function acharUnidade(contab: unknown, cliente: unknown, subpasta: unknown) {
  const { data, error } = await db.from('unidades').select('id, contabilidade').eq('contab_n', normal(contab)).eq('cliente_n', normal(cliente)).eq('subpasta_n', normal(subpasta)).maybeSingle();
  erroDb(error);
  return data;
}

async function portalResumo(token: unknown, contab: unknown, cliente: unknown, subpasta: unknown, mes: unknown) {
  const s = await sessao(token);
  if (!podeVer(s, String(contab))) throw new Error('Sem permissão para esta contabilidade.');
  const u = await acharUnidade(contab, cliente, subpasta);
  if (!u) throw new Error('Cliente não encontrado.');
  const { data, error } = await db.from('resumos').select('dados').eq('unidade_id', u.id).eq('mes', String(mes)).maybeSingle();
  erroDb(error);
  if (!data) throw new Error('Resumo do mês não encontrado.');
  return JSON.stringify(data.dados);   // o portal espera o texto do JSON
}

async function portalIndicadoresLote(token: unknown, meses: unknown) {
  const s = await sessao(token);
  const ms = (Array.isArray(meses) ? meses : []).map(String).filter(mesOk).slice(0, 24);
  const us = await unidadesVisiveis(s);
  const porId: Record<number, any> = {}; us.forEach((u) => (porId[u.id] = u));
  const res: Record<string, unknown> = {};
  if (!ms.length) return res;
  const ids = us.map((u) => u.id);
  const linhas: any[] = [];
  for (let i = 0; i < ids.length; i += 300) {
    linhas.push(...await todas<any>(() => db.from('indicadores').select('unidade_id, mes, dados').in('mes', ms).in('unidade_id', ids.slice(i, i + 300))));
  }
  ms.forEach((m) => (res[m] = { mes: m, itens: [], faltam: 0, total: 0 }));
  linhas.forEach((l) => {
    const u = porId[l.unidade_id]; if (!u) return;
    const r = res[l.mes] as any;
    r.itens.push({ ...l.dados, contabilidade: u.contabilidade, cliente: u.cliente, subpasta: u.subpasta });
    r.total++;
  });
  return res;
}
async function portalIndicadores(token: unknown, mes: unknown) {
  return ((await portalIndicadoresLote(token, [mes])) as any)[String(mes)];
}

async function portalSair(token: unknown) {
  const t = String(token || '');
  if (t) await db.from('sessoes').delete().eq('token', t);
  return true;
}

// ---------------------------------------------------------------- repasse ao receptor (Drive)
async function repassar(fn: string, args: unknown[]) {
  if (!RECEPTOR || !SENHA) throw new Error('Receptor não configurado no banco (RECEPTOR_URL / RECEPTOR_SENHA).');
  const s = fn === 'portalAparencia' ? null : await sessao(args[0]);
  const r = await fetch(RECEPTOR, {
    method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ acao: 'portalInterno', senha: SENHA, sessao: s, fn, args }),
  });
  if (!r.ok) throw new Error('Receptor respondeu ' + r.status + '. Tente de novo.');
  return await r.json();   // já vem no formato { ok, r | erro }
}

// pedido autenticado ao receptor (arquivos do financeiro no Drive)
async function receptor(acao: string, dados: Record<string, unknown>) {
  const r = await fetch(RECEPTOR, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ ...dados, acao, senha: SENHA }) });
  if (!r.ok) throw new Error('Receptor respondeu ' + r.status + '.');
  return await r.json();
}
const FIN = criarFin({ db, sessao, normal, podeVer, receptor, repassar });

const NATIVAS: Record<string, (...a: any[]) => Promise<unknown>> = {
  portalAparencia, portalDados, portalResumo, portalIndicadores, portalIndicadoresLote, portalSair, ...FIN.funcoes,
};
// funções que o portal pode chamar (as demais são recusadas)
const REPASSE = new Set(['portalArquivo', 'portalParte', 'portalAdmin', 'portalSalvarUsuario', 'portalExcluirUsuario', 'portalCriarContabilidade',
  'portalCriarCliente', 'portalSalvarRegime', 'portalServidores', 'portalSalvarServidor', 'portalUnificar', 'portalFinCarteira', 'portalFinSalvarBpo',
  'portalFinLoginEmpresa', 'portalFinCliente', 'portalFinImportar', 'portalFinCategorizar', 'portalFinSolicitar', 'portalFinJustificar', 'portalFinAnexo',
  'portalFinRemoverRegra', 'portalFinPlano', 'portalComando', 'portalFinComprovante', 'portalFinComprovantes', 'portalFinCorrigirComprovante']);

async function portal(req: any) {
  const fn = String(req.fn || ''), args = Array.isArray(req.args) ? req.args : [];
  try {
    if (fn === 'portalLogin') return { ok: true, r: await portalLogin(args[0], args[1]) };   // o portal confere r.ok
    if (NATIVAS[fn]) return { ok: true, r: await NATIVAS[fn](...args) };
    if (REPASSE.has(fn)) return await repassar(fn, args);
    return { ok: false, erro: 'Função não permitida: ' + fn };
  } catch (e) {
    return { ok: false, erro: String((e as Error)?.message || e) };
  }
}

// ---------------------------------------------------------------- sincronização vinda do receptor
async function idUnidade(contab: string, cliente: string, subpasta: string, pid?: string): Promise<number> {
  const u = await acharUnidade(contab, cliente, subpasta);
  if (u) { if (pid) await db.from('unidades').update({ drive_pid: pid }).eq('id', u.id); return u.id; }
  const { data, error } = await db.from('unidades').insert({ contabilidade: contab, cliente, subpasta: subpasta || '', drive_pid: pid || null }).select('id').single();
  if (error && /duplicate/.test(error.message)) return (await acharUnidade(contab, cliente, subpasta))!.id;
  erroDb(error);
  return data!.id;
}

async function espelhar(tabela: string, chaves: string[], linhas: any[]) {
  // substitui o conteúdo da tabela pelo da planilha (tabelas pequenas: usuários, regimes, envios, servidores, BPO)
  if (linhas.length) {
    for (let i = 0; i < linhas.length; i += 500) {
      const { error } = await db.from(tabela).upsert(linhas.slice(i, i + 500), { onConflict: chaves.join(',') });
      erroDb(error);
    }
  }
  return linhas.length;
}

async function sync(req: any) {
  if (!SENHA || !iguais(String(req.senha || ''), SENHA)) return { ok: false, erro: 'Senha inválida.' };
  const out: Record<string, number> = {};
  const conta = (k: string, n = 1) => (out[k] = (out[k] || 0) + n);
  for (const it of (Array.isArray(req.itens) ? req.itens : [])) {
    switch (it.t) {
      case 'resumo': {   // { contabilidade, cliente, subpasta, pid, mes, dados, ind }
        if (!mesOk(it.mes) || !it.dados) break;
        const id = await idUnidade(it.contabilidade, it.cliente, it.subpasta || '', it.pid);
        const agora = new Date().toISOString();
        erroDb((await db.from('resumos').upsert({ unidade_id: id, mes: it.mes, dados: it.dados, atualizado_em: agora })).error);
        if (it.ind) erroDb((await db.from('indicadores').upsert({ unidade_id: id, mes: it.mes, dados: it.ind, atualizado_em: agora })).error);
        conta('resumos'); break;
      }
      case 'usuarios': {   // lista completa da aba Usuários (só senhas já criptografadas)
        const linhas = (it.linhas || []).map((u: any) => ({
          login: String(u.login).trim().toLowerCase(), nome: u.nome || '', contabs: u.contabs || [], senha_hash: u.senha_hash || '',
          ativo: u.ativo !== false, empresa_contab: u.empresa_contab || null, empresa_cliente: u.empresa_cliente || null,
        })).filter((u: any) => u.login);
        await espelhar('usuarios', ['login'], linhas);
        const logins = linhas.map((u: any) => u.login);
        if (logins.length) await db.from('usuarios').delete().not('login', 'in', '(' + logins.map((l: string) => '"' + l.replace(/"/g, '') + '"').join(',') + ')');
        conta('usuarios', linhas.length); break;
      }
      case 'regimes': {
        await db.from('regimes').delete().neq('contab_n', '\u0000');
        conta('regimes', await espelhar('regimes', ['contab_n', 'cliente_n'], (it.linhas || []).map((r: any) => ({ contabilidade: r.contabilidade, cliente: r.cliente, regime: r.regime, obs: r.obs || '' }))));
        break;
      }
      case 'envios': {
        conta('envios', await espelhar('envios', ['contab_n', 'cliente_n', 'mes'], (it.linhas || []).filter((e: any) => mesOk(e.mes)).map((e: any) => ({
          contabilidade: e.contabilidade, cliente: e.cliente, mes: e.mes, cnpj: e.cnpj || null, ultimo_contato: e.ultimo_contato || null,
          situacao: e.situacao || '', mensagem: e.mensagem || '', maquina: e.maquina || '', versao: e.versao || '', dados: e.dados || {},
        }))));
        break;
      }
      case 'historico': {
        const linhas = (it.linhas || []).map((h: any) => ({ em: h.em, contabilidade: h.contabilidade, cliente: h.cliente, mes: h.mes, situacao: h.situacao, arquivo: h.arquivo, tamanho_kb: h.tamanho_kb || null, maquina: h.maquina, mensagem: h.mensagem }));
        for (let i = 0; i < linhas.length; i += 500) erroDb((await db.from('historico').insert(linhas.slice(i, i + 500))).error);
        conta('historico', linhas.length); break;
      }
      case 'bpo': {   // configurações do BPO (aba BPO da planilha)
        await FIN.espelharBpo(it.linhas || []);
        conta('bpo', (it.linhas || []).length); break;
      }
      case 'aparencia': {
        erroDb((await db.from('aparencia').upsert({ chave: 'portal', valor: JSON.stringify(it.dados || {}) })).error);
        conta('aparencia'); break;
      }
      case 'remover_unidade': {   // cliente unificado / excluído
        const u = await acharUnidade(it.contabilidade, it.cliente, it.subpasta || '');
        if (u) await db.from('unidades').delete().eq('id', u.id);
        conta('removidas'); break;
      }
      case 'estado': {   // o que o banco já tem (para o receptor mandar só o que falta)
        const rs = await todas<any>(() => db.from('resumos').select('mes, atualizado_em, unidades(contab_n, cliente_n, subpasta_n)'));
        return { ok: true, resumos: rs.map((r) => ({ k: r.unidades.contab_n + '|' + r.unidades.cliente_n + '|' + r.unidades.subpasta_n + '|' + r.mes, em: r.atualizado_em })) };
      }
    }
  }
  return { ok: true, gravados: out };
}

// ---------------------------------------------------------------- entrada
Deno.serve(async (r) => {
  if (r.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (r.method !== 'POST') return json({ ok: true, servico: 'Farol Contábil', versao: VERSAO });
  let req: any;
  try { req = JSON.parse(await r.text()); } catch { return json({ ok: false, erro: 'Pedido inválido.' }, 400); }
  try {
    if (req.acao === 'portal') return json(await portal(req));
    if (req.acao === 'sync') return json(await sync(req));
    if (req.acao === 'whatsapp') return json(await FIN.whatsapp(req));
    return json({ ok: false, erro: 'Ação desconhecida.' }, 400);
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) });
  }
});
