// Farol Contábil — API do portal no Supabase (Edge Function "farol"), versão 3 (25/11/2026).
// O index.ts publicado no Supabase só importa este arquivo de um commit fixo do GitHub.
//
//   POST { acao: 'portal', fn, args }  ->  { ok: true, r } | { ok: false, erro }
//   POST { acao: 'sync', senha, itens } (receptor / Apps Script)
//
// Segurança (v3):
//  - senhas em PBKDF2-SHA256 (150 mil iterações), migradas sozinhas no primeiro login de cada usuário;
//  - bloqueio por login (8 erros / 15 min) e por IP (30 erros / 15 min);
//  - sessão: expira com 4 h sem uso e, de qualquer jeito, 12 h depois do login; cai na hora ao trocar senha/perfil;
//  - perfis (admin, cpusis, gestor, contador, cliente) e módulos; tudo conferido aqui, não só na tela;
//  - logins ficam no banco (a aba Usuários da planilha deixa de mandar);
//  - registro de auditoria (acessos) com IP.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { criarFin } from './fin.ts';
import { AsyncLocalStorage } from 'node:async_hooks';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const SENHA = Deno.env.get('RECEPTOR_SENHA') || '';
const RECEPTOR = Deno.env.get('RECEPTOR_URL') || 'https://script.google.com/macros/s/AKfycbwySsHymDOemTCxV-Oe-j4B0xHK1OIOtBDF-KjIdhHA0cf9YmLoUcP3AnRVpgW1AZLU/exec';
const VERSAO = '3.0-db';
const OCIOSA_H = 4, ABSOLUTA_H = 12;
const ITER = 150000;

// origens que podem chamar a API pelo navegador (GitHub Pages e o Apps Script antigo)
function corsDe(origem: string | null) {
  const ok = !!origem && (/^https:\/\/cpusiscode\.github\.io$/i.test(origem) || /^https:\/\/[a-z0-9-]+\.googleusercontent\.com$/i.test(origem) || /^https:\/\/script\.google\.com$/i.test(origem));
  return {
    'Access-Control-Allow-Origin': ok ? origem! : 'https://cpusiscode.github.io',
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, authorization, apikey, x-client-info',
    'Access-Control-Max-Age': '86400',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };
}

// ---------------------------------------------------------------- utilidades
export function normal(s: unknown): string {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
}
const hex = (b: ArrayBuffer | Uint8Array) => Array.from(b instanceof Uint8Array ? b : new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');
async function sha256hex(t: string): Promise<string> { return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t))); }
async function hashLegado(sal: string, senha: string): Promise<string> {   // formato antigo (planilha): sal$hash
  let h = sal + ':' + senha;
  for (let i = 0; i < 300; i++) h = await sha256hex(h + ':' + sal);
  return h;
}
async function pbkdf2(senha: string, sal: string, iter: number): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(senha), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(sal), iterations: iter }, k, 256));
}
function aleatorio(n: number): string { const b = new Uint8Array(n); crypto.getRandomValues(b); return hex(b); }
async function novoHash(senha: string): Promise<string> { const sal = aleatorio(16); return 'p2$' + ITER + '$' + sal + '$' + await pbkdf2(senha, sal, ITER); }
async function confereSenha(guardado: string, senha: string): Promise<{ ok: boolean; refazer: boolean }> {
  const p = String(guardado || '').split('$');
  if (p[0] === 'p2' && p.length === 4) { const it = Number(p[1]) || 0; return { ok: iguais(await pbkdf2(senha, p[2], it), p[3]), refazer: it < ITER }; }
  if (p.length === 2) return { ok: iguais(await hashLegado(p[0], senha), p[1]), refazer: true };
  return { ok: false, refazer: false };
}
function iguais(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const mesOk = (m: unknown) => /^\d{4}-\d{2}$/.test(String(m));
function erroDb(e: { message: string } | null) { if (e) throw new Error('Banco: ' + e.message); }
function senhaFraca(senha: string, login: string): string {
  if (senha.length < 8) return 'A senha precisa ter pelo menos 8 caracteres.';
  if (!/[A-Za-z]/.test(senha) || !/\d/.test(senha)) return 'Use letras e números na senha.';
  if (senha.toLowerCase().includes(login.toLowerCase())) return 'A senha não pode conter o login.';
  if (/^(12345678|senha123|password1|farol123|cpusis12)/i.test(senha)) return 'Senha fácil demais.';
  return '';
}

// ---------------------------------------------------------------- perfis e módulos
export const MODULOS: Record<string, string> = {
  painel: 'Painel geral (todas as empresas)', clientes: 'Lista de clientes', resumo: 'Resumo fiscal do cliente', xml: 'Baixar e consultar XML',
  conferencia: 'Conferência IBS/CBS', produtos: 'Análise fiscal de produtos', calculadora: 'Calculadoras tributárias', reuniao: 'Modo Reunião',
  bpo: 'BPO financeiro', servidores: 'Servidores e agentes', usuarios: 'Acessos e permissões', auditoria: 'Registro de acessos',
};
const TODOS = Object.keys(MODULOS);
export const PERFIS: Record<string, { nome: string; max: string[]; padrao: string[] }> = {
  admin: { nome: 'Administrador CPUSIS', max: TODOS, padrao: TODOS },
  cpusis: { nome: 'Equipe CPUSIS', max: TODOS.filter((m) => m !== 'usuarios'), padrao: TODOS.filter((m) => m !== 'usuarios' && m !== 'auditoria') },
  gestor: { nome: 'Gestor da contabilidade', max: ['painel', 'clientes', 'resumo', 'xml', 'conferencia', 'produtos', 'calculadora', 'reuniao', 'bpo', 'usuarios', 'auditoria'],
    padrao: ['painel', 'clientes', 'resumo', 'xml', 'conferencia', 'produtos', 'calculadora', 'reuniao', 'bpo', 'usuarios'] },
  contador: { nome: 'Contador', max: ['painel', 'clientes', 'resumo', 'xml', 'conferencia', 'produtos', 'calculadora', 'reuniao', 'bpo'],
    padrao: ['painel', 'clientes', 'resumo', 'xml', 'conferencia', 'produtos', 'calculadora', 'reuniao', 'bpo'] },
  cliente: { nome: 'Cliente (empresa)', max: ['resumo', 'xml', 'conferencia', 'produtos', 'calculadora', 'bpo'], padrao: ['resumo', 'xml', 'conferencia', 'produtos', 'calculadora', 'bpo'] },
};
function modulosDe(perfil: string, escolhidos: string[] | null): string[] {
  const p = PERFIS[perfil] || PERFIS.contador;
  return escolhidos && escolhidos.length ? p.max.filter((m) => escolhidos.includes(m)) : p.padrao.slice();
}

type Sessao = { login: string; nome: string; contabs: string[]; empresa?: { contabilidade: string; cliente: string } | null; perfil?: string; modulos?: string[] };
function perfilDe(s: Sessao): string { return s.perfil || (s.contabs.includes('*') ? 'admin' : s.empresa ? 'cliente' : 'contador'); }
function temModulo(s: Sessao, ...ms: string[]): boolean {
  const mods = s.modulos || modulosDe(perfilDe(s), null);
  return ms.some((m) => mods.includes(m));
}
function exigir(s: Sessao, ...ms: string[]) { if (!temModulo(s, ...ms)) throw new Error('Seu acesso não inclui esta função. Fale com o administrador.'); }
function podeVer(s: Sessao, contab: string): boolean {
  if (s.empresa) return normal(s.empresa.contabilidade) === normal(contab);
  if (s.contabs.includes('*')) return true;
  const n = normal(contab);
  return s.contabs.some((c) => normal(c) === n);
}
function podeVerUnidade(s: Sessao, contab: unknown, cliente: unknown): boolean {
  if (s.empresa) return normal(s.empresa.contabilidade) === normal(contab) && normal(s.empresa.cliente) === normal(cliente);
  return podeVer(s, String(contab));
}

// ---------------------------------------------------------------- pedido atual (IP / navegador) e auditoria
const CTX = new AsyncLocalStorage<{ ip: string; agente: string }>();
const ipAtual = () => CTX.getStore()?.ip || '';
const agenteAtual = () => CTX.getStore()?.agente || '';
async function logAcesso(login: string, acao: string, detalhe: string) {
  await db.from('acessos').insert({ login, acao, detalhe: String(detalhe || '').slice(0, 300), ip: ipAtual() || null });
}

// ---------------------------------------------------------------- sessão
async function sessao(token: unknown): Promise<Sessao> {
  const t = String(token || '');
  if (!/^[0-9a-f]{64}$/.test(t)) throw new Error('SESSAO_EXPIRADA');
  const { data, error } = await db.from('sessoes').select('dados, expira_em, absoluta_ate, visto_em').eq('token', t).maybeSingle();
  erroDb(error);
  const agora = Date.now();
  if (!data || new Date(data.expira_em).getTime() < agora || (data.absoluta_ate && new Date(data.absoluta_ate).getTime() < agora)) throw new Error('SESSAO_EXPIRADA');
  if (!data.visto_em || agora - new Date(data.visto_em).getTime() > 5 * 60e3) {   // renova a janela de uso, sem esperar
    db.from('sessoes').update({ expira_em: new Date(agora + OCIOSA_H * 3600e3).toISOString(), visto_em: new Date(agora).toISOString() }).eq('token', t).then(() => {});
  }
  return data.dados as Sessao;
}
async function derrubarSessoes(login: string, exceto?: string) {
  let q = db.from('sessoes').delete().eq('login', login);
  if (exceto) q = q.neq('token', exceto);
  await q;
}

async function portalLogin(login: unknown, senha: unknown) {
  const l = String(login || '').trim().toLowerCase();
  if (!l || !senha) return { ok: false, erro: 'Informe login e senha.' };
  const quinze = 15 * 60e3, agora = Date.now(), IP = ipAtual(), AGENTE = agenteAtual();
  if (IP) {
    const { data: ti } = await db.from('tentativas_ip').select('falhas, ate').eq('ip', IP).maybeSingle();
    if (ti && ti.falhas >= 30 && agora - new Date(ti.ate).getTime() < quinze) return { ok: false, erro: 'Muitas tentativas deste computador. Aguarde 15 minutos.' };
  }
  const { data: tent } = await db.from('tentativas_login').select('falhas, ate').eq('login', l).maybeSingle();
  if (tent && tent.falhas >= 8 && agora - new Date(tent.ate).getTime() < quinze) return { ok: false, erro: 'Muitas tentativas. Aguarde 15 minutos.' };
  const { data: u, error } = await db.from('usuarios').select('*').eq('login', l).maybeSingle();
  erroDb(error);
  let certo = false, refazer = false;
  if (u && u.ativo === false) return { ok: false, erro: 'Acesso desativado. Fale com a CPUSIS.' };
  if (u) { const c = await confereSenha(String(u.senha_hash || ''), String(senha)); certo = c.ok; refazer = c.refazer; }
  else await pbkdf2(String(senha), 'x', 2000);   // tempo parecido para login inexistente
  if (!certo) {
    const falhas = tent && agora - new Date(tent.ate).getTime() < quinze ? tent.falhas + 1 : 1;
    await db.from('tentativas_login').upsert({ login: l, falhas, ate: new Date().toISOString() });
    if (IP) {
      const { data: ti } = await db.from('tentativas_ip').select('falhas, ate').eq('ip', IP).maybeSingle();
      const fi = ti && agora - new Date(ti.ate).getTime() < quinze ? ti.falhas + 1 : 1;
      await db.from('tentativas_ip').upsert({ ip: IP, falhas: fi, ate: new Date().toISOString() });
    }
    await logAcesso(l, 'login_falhou', u ? 'senha incorreta' : 'login inexistente');
    return { ok: false, erro: 'Login ou senha incorretos.' };
  }
  await db.from('tentativas_login').delete().eq('login', l);
  const perfil = u.perfil || (Array.isArray(u.contabs) && u.contabs.includes('*') ? 'admin' : u.empresa_cliente ? 'cliente' : 'contador');
  const s: Sessao = { login: l, nome: u.nome || l, contabs: u.contabs || [], perfil, modulos: modulosDe(perfil, u.modulos) };
  if (perfil === 'admin' || perfil === 'cpusis') s.contabs = ['*'];
  if (perfil === 'cliente') {
    if (!u.empresa_contab || !u.empresa_cliente) return { ok: false, erro: 'Login de cliente sem empresa vinculada. Fale com a contabilidade.' };
    s.empresa = { contabilidade: u.empresa_contab, cliente: u.empresa_cliente }; s.contabs = [];
  } else s.contabs = s.contabs.filter((c) => c !== '*' || perfil === 'admin' || perfil === 'cpusis');
  const token = aleatorio(32);
  const { error: e2 } = await db.from('sessoes').insert({ token, login: l, dados: s, expira_em: new Date(agora + OCIOSA_H * 3600e3).toISOString(),
    absoluta_ate: new Date(agora + ABSOLUTA_H * 3600e3).toISOString(), visto_em: new Date(agora).toISOString(), ip: IP || null, agente: AGENTE.slice(0, 200) || null });
  erroDb(e2);
  const upd: Record<string, unknown> = { ultimo_acesso: new Date().toISOString() };
  if (refazer) { upd.senha_hash = await novoHash(String(senha)); }
  await db.from('usuarios').update(upd).eq('login', l);
  await logAcesso(l, 'login', 'portal · ' + (AGENTE.match(/(Edg|Chrome|Firefox|Safari)\/[\d.]+/)?.[0] || 'navegador'));
  if (Math.random() < 0.05) await db.rpc('limpar_sessoes');
  return { ok: true, token, nome: s.nome, admin: perfil === 'admin', perfil, modulos: s.modulos, empresa: s.empresa || null, trocarSenha: !!u.trocar_senha };
}

async function portalTrocarSenha(token: unknown, atual: unknown, nova: unknown) {
  const s = await sessao(token);
  const { data: u } = await db.from('usuarios').select('senha_hash').eq('login', s.login).maybeSingle();
  if (!u || !(await confereSenha(String(u.senha_hash || ''), String(atual || ''))).ok) throw new Error('A senha atual não confere.');
  const n = String(nova || ''), f = senhaFraca(n, s.login); if (f) throw new Error(f);
  if (String(atual) === n) throw new Error('A senha nova precisa ser diferente da atual.');
  erroDb((await db.from('usuarios').update({ senha_hash: await novoHash(n), trocar_senha: false, senha_em: new Date().toISOString() }).eq('login', s.login)).error);
  await derrubarSessoes(s.login, String(token));
  await logAcesso(s.login, 'senha', 'trocou a própria senha');
  return true;
}
async function portalEu(token: unknown) {
  const s = await sessao(token);
  return { login: s.login, nome: s.nome, perfil: perfilDe(s), modulos: s.modulos || modulosDe(perfilDe(s), null), empresa: s.empresa || null, contabs: s.contabs };
}

// ---------------------------------------------------------------- leituras do portal
async function portalAparencia() {
  const { data } = await db.from('aparencia').select('valor').eq('chave', 'portal').maybeSingle();
  if (data?.valor) { try { return JSON.parse(data.valor); } catch { /* segue */ } }
  return { nome: 'Portal Contábil', cor: '#0f6b55', corEscura: '#4cc29c', fundo: '#f3f5f4' };
}
async function todas<T>(q: () => any, passo = 1000): Promise<T[]> {
  const out: T[] = [];
  for (let de = 0; ; de += passo) {
    const { data, error } = await q().range(de, de + passo - 1);
    erroDb(error);
    out.push(...(data || []));
    if (!data || data.length < passo) return out;
  }
}
async function unidadesVisiveis(s: Sessao) {
  if (s.empresa) {
    const { data, error } = await db.from('unidades').select('id, contabilidade, cliente, subpasta, drive_pid').eq('contab_n', normal(s.empresa.contabilidade)).eq('cliente_n', normal(s.empresa.cliente)).order('subpasta_n');
    erroDb(error); return data || [];
  }
  const us = await todas<any>(() => db.from('unidades').select('id, contabilidade, cliente, subpasta, drive_pid').order('contab_n').order('cliente_n').order('subpasta_n'));
  return us.filter((u) => podeVer(s, u.contabilidade));
}
async function portalDados(token: unknown) {
  const s = await sessao(token);
  const perfil = perfilDe(s), modulos = s.modulos || modulosDe(perfil, null);
  const base = { nome: s.nome, login: s.login, perfil, modulos, empresa: s.empresa || null, versao: VERSAO, admin: perfil === 'admin' };
  if (s.empresa && !modulos.some((m) => ['resumo', 'xml', 'conferencia', 'produtos', 'calculadora'].includes(m))) return { ...base, unidades: [], painel: {}, regimes: {} };
  const us = await unidadesVisiveis(s);
  const ids = us.map((u) => u.id);
  const meses: Record<number, string[]> = {};
  for (let i = 0; i < ids.length; i += 300) {
    const rs = await todas<any>(() => db.from('resumos').select('unidade_id, mes').in('unidade_id', ids.slice(i, i + 300)).order('mes', { ascending: false }));
    rs.forEach((r) => (meses[r.unidade_id] = meses[r.unidade_id] || []).push(r.mes));
  }
  const unidades = us.map((u) => ({ contabilidade: u.contabilidade, cliente: u.cliente, subpasta: u.subpasta, meses: meses[u.id] || [], pid: s.empresa ? '' : (u.drive_pid || '') }));
  const painel: Record<string, unknown> = {};
  if (!s.empresa) {
    const env = await todas<any>(() => db.from('envios').select('contabilidade, cliente, mes, ultimo_contato, situacao, mensagem, maquina, versao'));
    env.forEach((e) => {
      if (!podeVer(s, e.contabilidade)) return;
      painel[normal(e.contabilidade) + '|' + normal(e.cliente) + '|' + e.mes] = {
        ultimoContato: e.ultimo_contato ? new Date(e.ultimo_contato).toISOString() : '', situacao: e.situacao || '', mensagem: e.mensagem || '',
        contabilidade: e.contabilidade, cliente: e.cliente, mes: e.mes, maquina: e.maquina || '', versao: e.versao || '',
      };
    });
  }
  const regimes: Record<string, string> = {};
  const rg = await todas<any>(() => db.from('regimes').select('contabilidade, cliente, contab_n, cliente_n, regime'));
  rg.forEach((r) => { if (podeVerUnidade(s, r.contabilidade, r.cliente)) regimes[r.contab_n + '|' + r.cliente_n] = r.regime; });
  return { ...base, unidades, painel, regimes };
}
async function acharUnidade(contab: unknown, cliente: unknown, subpasta: unknown) {
  const { data, error } = await db.from('unidades').select('id, contabilidade').eq('contab_n', normal(contab)).eq('cliente_n', normal(cliente)).eq('subpasta_n', normal(subpasta)).maybeSingle();
  erroDb(error);
  return data;
}
async function portalResumo(token: unknown, contab: unknown, cliente: unknown, subpasta: unknown, mes: unknown) {
  const s = await sessao(token);
  exigir(s, 'resumo', 'conferencia', 'produtos', 'xml', 'calculadora');
  if (!podeVerUnidade(s, contab, cliente)) throw new Error('Sem permissão para esta empresa.');
  const u = await acharUnidade(contab, cliente, subpasta);
  if (!u) throw new Error('Cliente não encontrado.');
  const { data, error } = await db.from('resumos').select('dados').eq('unidade_id', u.id).eq('mes', String(mes)).maybeSingle();
  erroDb(error);
  if (!data) throw new Error('Resumo do mês não encontrado.');
  return JSON.stringify(data.dados);
}
async function portalIndicadoresLote(token: unknown, meses: unknown) {
  const s = await sessao(token);
  exigir(s, 'painel', 'clientes');
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
async function portalIndicadores(token: unknown, mes: unknown) { return ((await portalIndicadoresLote(token, [mes])) as any)[String(mes)]; }
async function portalSair(token: unknown) {
  const t = String(token || '');
  if (/^[0-9a-f]{64}$/.test(t)) {
    const { data } = await db.from('sessoes').select('login').eq('token', t).maybeSingle();
    await db.from('sessoes').delete().eq('token', t);
    if (data) await logAcesso(data.login, 'sair', '');
  }
  return true;
}

// base fiscal das calculadoras (NCM, ST do Acre, MVA, monofásico)
async function portalNcmBase(token: unknown, versaoCache: unknown) {
  const s = await sessao(token);
  exigir(s, 'calculadora', 'produtos');
  const { data: v } = await db.from('ncm_base_versao').select('versao, fonte, total').maybeSingle();
  if (!v) throw new Error('Base fiscal ainda não carregada.');
  if (String(versaoCache || '') === v.versao) return { versao: v.versao, igual: true };
  const linhas = await todas<any>(() => db.from('ncm_base').select('ncm, descricao, segmento, mva, monofasico').order('ncm'));
  const segs: string[] = [], monos: string[] = [];
  const ix = (arr: string[], x: string | null) => { if (!x) return ''; let i = arr.indexOf(x); if (i < 0) { arr.push(x); i = arr.length - 1; } return String(i); };
  const rows = linhas.map((r) => r.ncm + '|' + r.descricao + '|' + ix(segs, r.segmento) + '|' + (r.mva == null ? '' : Number(r.mva)) + '|' + ix(monos, r.monofasico));
  return { versao: v.versao, fonte: v.fonte, total: v.total, segs, monos, rows };
}

// ---------------------------------------------------------------- acessos e permissões (logins no banco)
function podeAdministrar(s: Sessao): 'tudo' | 'contab' | null {
  const p = perfilDe(s);
  if (p === 'admin') return 'tudo';
  if (p === 'gestor' && temModulo(s, 'usuarios')) return 'contab';
  return null;
}
function alcanceDoGestor(s: Sessao, u: any): boolean {   // o gestor só mexe em contador/cliente das contabilidades dele
  if (!u) return true;
  if (u.perfil === 'admin' || u.perfil === 'cpusis' || u.perfil === 'gestor') return false;
  const cs: string[] = u.perfil === 'cliente' ? [u.empresa_contab] : (u.contabs || []);
  return cs.length > 0 && cs.every((c) => podeVer(s, c));
}
function usuarioPublico(u: any) {
  return { login: u.login, nome: u.nome || '', email: u.email || '', perfil: u.perfil || 'contador', contabs: u.contabs || [], empresa_contab: u.empresa_contab || '', empresa_cliente: u.empresa_cliente || '',
    modulos: u.modulos || null, modulosEfetivos: modulosDe(u.perfil || 'contador', u.modulos), ativo: u.ativo !== false, trocar_senha: !!u.trocar_senha, temSenha: !!u.senha_hash,
    ultimo_acesso: u.ultimo_acesso || '', criado_em: u.criado_em || '', criado_por: u.criado_por || '', senha_em: u.senha_em || '', obs: u.obs || '', senhaAntiga: !/^p2\$/.test(String(u.senha_hash || '')) };
}
async function portalUsuarios(token: unknown) {
  const s = await sessao(token);
  const nivel = podeAdministrar(s); if (!nivel) throw new Error('Seu acesso não inclui a administração de logins.');
  const { data, error } = await db.from('usuarios').select('*').order('login'); erroDb(error);
  const us = (data || []).filter((u: any) => nivel === 'tudo' || alcanceDoGestor(s, u));
  const desde = new Date(Date.now() - 30 * 86400e3).toISOString();
  const ac = await todas<any>(() => db.from('acessos').select('login, acao').gte('em', desde).in('acao', ['login', 'download', 'login_falhou']));
  const uso: Record<string, any> = {};
  ac.forEach((a) => { const x = uso[a.login] = uso[a.login] || { login: 0, download: 0, login_falhou: 0 }; x[a.acao]++; });
  const { data: ses } = await db.from('sessoes').select('login, criado_em, visto_em, ip, agente, expira_em, absoluta_ate').gt('expira_em', new Date().toISOString());
  const abertas: Record<string, number> = {}; (ses || []).forEach((x: any) => { if (!x.absoluta_ate || x.absoluta_ate > new Date().toISOString()) abertas[x.login] = (abertas[x.login] || 0) + 1; });
  const contabs = Array.from(new Set((await todas<any>(() => db.from('unidades').select('contabilidade'))).map((u) => u.contabilidade))).filter((c) => nivel === 'tudo' || podeVer(s, c)).sort();
  const clientes = (await todas<any>(() => db.from('unidades').select('contabilidade, cliente'))).filter((u) => nivel === 'tudo' || podeVer(s, u.contabilidade));
  const cli: Record<string, string[]> = {}; clientes.forEach((u) => { const l = cli[u.contabilidade] = cli[u.contabilidade] || []; if (!l.includes(u.cliente)) l.push(u.cliente); });
  Object.values(cli).forEach((l) => l.sort());
  const perfisPermitidos = nivel === 'tudo' ? Object.keys(PERFIS) : ['contador', 'cliente'];
  return {
    usuarios: us.map((u: any) => ({ ...usuarioPublico(u), acessos30: uso[u.login]?.login || 0, downloads30: uso[u.login]?.download || 0, falhas30: uso[u.login]?.login_falhou || 0, sessoes: abertas[u.login] || 0 })),
    perfis: Object.fromEntries(perfisPermitidos.map((p) => [p, PERFIS[p]])), modulos: MODULOS, contabilidades: contabs, clientes: cli, nivel, eu: s.login,
  };
}
async function portalSalvarUsuario(token: unknown, d: any) {
  const s = await sessao(token);
  const nivel = podeAdministrar(s); if (!nivel) throw new Error('Seu acesso não inclui a administração de logins.');
  d = d || {};
  const login = String(d.login || '').trim().toLowerCase(), original = String(d.original || '').trim().toLowerCase();
  if (!/^[a-z0-9._@-]{3,40}$/.test(login)) throw new Error('Login: use de 3 a 40 letras, números, ponto, hífen ou @ (sem espaço).');
  const perfil = String(d.perfil || 'contador');
  if (!PERFIS[perfil]) throw new Error('Perfil inválido.');
  if (nivel === 'contab' && !['contador', 'cliente'].includes(perfil)) throw new Error('Você só pode criar logins de contador ou de cliente.');
  const { data: antigo } = original ? await db.from('usuarios').select('*').eq('login', original).maybeSingle() : { data: null };
  if (original && !antigo) throw new Error('Login não encontrado.');
  if (nivel === 'contab' && antigo && !alcanceDoGestor(s, antigo)) throw new Error('Este login não é da sua contabilidade.');
  if (login !== original) { const { data: ja } = await db.from('usuarios').select('login').eq('login', login).maybeSingle(); if (ja) throw new Error('Já existe o login "' + login + '".'); }
  let contabs: string[] = (Array.isArray(d.contabs) ? d.contabs : []).map((c: unknown) => String(c).trim()).filter(Boolean);
  let empC: string | null = null, empK: string | null = null;
  if (perfil === 'admin' || perfil === 'cpusis') contabs = ['*'];
  else if (perfil === 'cliente') {
    empC = String(d.empresa_contab || '').trim(); empK = String(d.empresa_cliente || '').trim();
    if (!empC || !empK) throw new Error('Escolha a empresa do login de cliente.');
    const { data: un } = await db.from('unidades').select('id').eq('contab_n', normal(empC)).eq('cliente_n', normal(empK)).limit(1);
    if (!un || !un.length) throw new Error('Empresa não encontrada no Farol.');
    contabs = [];
  } else {
    contabs = contabs.filter((c) => c !== '*');
    if (!contabs.length) throw new Error('Escolha pelo menos uma contabilidade.');
  }
  if (nivel === 'contab') {
    const cs = perfil === 'cliente' ? [empC!] : contabs;
    if (!cs.every((c) => podeVer(s, c))) throw new Error('Você só pode dar acesso às suas contabilidades.');
  }
  if (original === s.login && (perfil !== perfilDe(s) || d.ativo === false)) throw new Error('Você não pode mudar o seu próprio perfil nem se desativar.');
  const modulos: string[] | null = Array.isArray(d.modulos) ? d.modulos.map(String).filter((m: string) => PERFIS[perfil].max.includes(m)) : null;
  if (nivel === 'contab' && modulos && modulos.includes('usuarios')) throw new Error('Só o administrador dá o acesso de administração de logins.');
  const row: Record<string, unknown> = { login, nome: String(d.nome || login).slice(0, 80), email: String(d.email || '').slice(0, 120) || null, perfil, contabs, empresa_contab: empC, empresa_cliente: empK,
    modulos: modulos && modulos.length ? modulos : null, ativo: d.ativo !== false, obs: String(d.obs || '').slice(0, 300) || null, trocar_senha: !!d.trocar_senha };
  const senha = String(d.senha || '');
  if (senha) { const f = senhaFraca(senha, login); if (f) throw new Error(f); row.senha_hash = await novoHash(senha); row.senha_em = new Date().toISOString(); row.trocar_senha = d.trocar_senha !== false; }
  else if (!antigo) throw new Error('Informe a senha do login novo.');
  if (antigo) {
    erroDb((await db.from('usuarios').update(row).eq('login', original)).error);
    await derrubarSessoes(original);   // permissões novas valem já no próximo clique
  } else {
    row.criado_por = s.login; row.criado_em = new Date().toISOString();
    erroDb((await db.from('usuarios').insert(row)).error);
  }
  await logAcesso(s.login, 'admin_login', (antigo ? 'alterou ' : 'criou ') + login + ' · ' + perfil + (senha ? ' · senha nova' : '') + (row.ativo ? '' : ' · DESATIVADO'));
  return await portalUsuarios(token);
}
async function portalExcluirUsuario(token: unknown, login: unknown) {
  const s = await sessao(token);
  const nivel = podeAdministrar(s); if (!nivel) throw new Error('Seu acesso não inclui a administração de logins.');
  const l = String(login || '').trim().toLowerCase();
  if (l === s.login) throw new Error('Você não pode excluir o seu próprio login.');
  const { data: u } = await db.from('usuarios').select('*').eq('login', l).maybeSingle();
  if (!u) throw new Error('Login não encontrado.');
  if (nivel === 'contab' && !alcanceDoGestor(s, u)) throw new Error('Este login não é da sua contabilidade.');
  if (u.perfil === 'admin') { const { count } = await db.from('usuarios').select('login', { count: 'exact', head: true }).eq('perfil', 'admin').neq('ativo', false); if ((count || 0) <= 1) throw new Error('Não dá para excluir o último administrador.'); }
  await derrubarSessoes(l);
  erroDb((await db.from('usuarios').delete().eq('login', l)).error);
  await logAcesso(s.login, 'admin_login', 'excluiu ' + l + ' (' + u.perfil + ')');
  return await portalUsuarios(token);
}
async function portalSessoes(token: unknown, login: unknown) {
  const s = await sessao(token);
  const nivel = podeAdministrar(s); if (!nivel) throw new Error('Sem permissão.');
  const l = String(login || '').trim().toLowerCase();
  const { data: u } = await db.from('usuarios').select('*').eq('login', l).maybeSingle();
  if (nivel === 'contab' && !alcanceDoGestor(s, u)) throw new Error('Este login não é da sua contabilidade.');
  const { data } = await db.from('sessoes').select('criado_em, visto_em, ip, agente, expira_em, absoluta_ate').eq('login', l).gt('expira_em', new Date().toISOString()).order('criado_em', { ascending: false });
  const { data: ac } = await db.from('acessos').select('em, acao, detalhe, ip').eq('login', l).order('em', { ascending: false }).limit(40);
  return { sessoes: data || [], acessos: ac || [] };
}
async function portalDerrubarSessoes(token: unknown, login: unknown) {
  const s = await sessao(token);
  const nivel = podeAdministrar(s); if (!nivel) throw new Error('Sem permissão.');
  const l = String(login || '').trim().toLowerCase();
  const { data: u } = await db.from('usuarios').select('*').eq('login', l).maybeSingle();
  if (nivel === 'contab' && !alcanceDoGestor(s, u)) throw new Error('Este login não é da sua contabilidade.');
  await derrubarSessoes(l, l === s.login ? String(token) : undefined);
  await logAcesso(s.login, 'admin_login', 'encerrou as sessões de ' + l);
  return true;
}
async function portalAuditoria(token: unknown, filtro: any) {
  const s = await sessao(token);
  exigir(s, 'auditoria');
  const nivel = podeAdministrar(s) || (perfilDe(s) === 'cpusis' ? 'tudo' : null);
  if (!nivel) throw new Error('Sem permissão.');
  let q = db.from('acessos').select('em, login, acao, detalhe, ip').order('em', { ascending: false }).limit(500);
  const f = filtro || {};
  if (f.login) q = q.eq('login', String(f.login).toLowerCase());
  if (f.acao) q = q.eq('acao', String(f.acao));
  let linhas = (await q).data || [];
  if (nivel === 'contab') {
    const { data: us } = await db.from('usuarios').select('*');
    const meus = new Set((us || []).filter((u: any) => u.login === s.login || alcanceDoGestor(s, u)).map((u: any) => u.login));
    linhas = linhas.filter((a: any) => meus.has(a.login));
  }
  return linhas;
}
// login de empresa do BPO (antes ia para a planilha)
async function portalFinLoginEmpresa(token: unknown, u: any) {
  const s = await sessao(token);
  if (!['admin', 'cpusis'].includes(perfilDe(s))) throw new Error('Só a CPUSIS cria o login da empresa no BPO.');
  const login = String(u?.login || '').trim().toLowerCase();
  if (!/^[a-z0-9._@-]{3,40}$/.test(login)) throw new Error('Login: use de 3 a 40 letras, números, ponto, hífen ou @ (sem espaço).');
  const { data: ja } = await db.from('usuarios').select('*').eq('login', login).maybeSingle();
  if (ja && (normal(ja.empresa_contab) !== normal(u.contabilidade) || normal(ja.empresa_cliente) !== normal(u.cliente))) throw new Error('Já existe o login "' + login + '" para outro uso.');
  const row: Record<string, unknown> = { login, nome: String(u.nome || login), perfil: 'cliente', contabs: [], empresa_contab: String(u.contabilidade || ''), empresa_cliente: String(u.cliente || ''), ativo: u.ativo !== false };
  if (u.senha) { const f = senhaFraca(String(u.senha), login); if (f) throw new Error(f); row.senha_hash = await novoHash(String(u.senha)); row.senha_em = new Date().toISOString(); row.trocar_senha = true; }
  else if (!ja) throw new Error('Informe a senha do login novo.');
  if (ja) { erroDb((await db.from('usuarios').update(row).eq('login', login)).error); await derrubarSessoes(login); }
  else { row.criado_por = s.login; erroDb((await db.from('usuarios').insert(row)).error); }
  await logAcesso(s.login, 'admin_login', (ja ? 'alterou ' : 'criou ') + login + ' · cliente BPO');
  return await FIN.funcoes.portalFinCarteira(token);
}

// ---------------------------------------------------------------- repasse ao receptor (Drive)
async function repassar(fn: string, args: unknown[]) {
  if (!RECEPTOR || !SENHA) throw new Error('Receptor não configurado no banco (RECEPTOR_URL / RECEPTOR_SENHA).');
  const s = fn === 'portalAparencia' ? null : await sessao(args[0]);
  if (s) {
    const regra = REGRAS[fn];
    if (regra) regra(s, args);
    if (fn === 'portalArquivo') await logAcesso(s.login, 'download', [args[1], args[2], args[3], args[4]].filter(Boolean).join(' / '));
  }
  const r = await fetch(RECEPTOR, {
    method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ acao: 'portalInterno', senha: SENHA, sessao: s, fn, args }),
  });
  if (!r.ok) throw new Error('Receptor respondeu ' + r.status + '. Tente de novo.');
  return await r.json();
}
async function receptor(acao: string, dados: Record<string, unknown>) {
  const r = await fetch(RECEPTOR, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ ...dados, acao, senha: SENHA }) });
  if (!r.ok) throw new Error('Receptor respondeu ' + r.status + '.');
  return await r.json();
}
// permissão de cada função repassada (o receptor ainda confere a contabilidade/empresa)
const soAdmin = (s: Sessao) => { if (perfilDe(s) !== 'admin') throw new Error('Só o administrador da CPUSIS pode fazer isso.'); };
const soCpusis = (s: Sessao) => { if (!['admin', 'cpusis'].includes(perfilDe(s))) throw new Error('Só a equipe da CPUSIS pode fazer isso.'); };
const REGRAS: Record<string, (s: Sessao, a: unknown[]) => void> = {
  portalArquivo: (s, a) => { exigir(s, 'xml', 'produtos', 'conferencia', 'resumo'); if (!podeVerUnidade(s, a[1], a[2])) throw new Error('Sem permissão para esta empresa.'); },
  portalParte: (s) => exigir(s, 'xml', 'produtos', 'conferencia', 'resumo'),
  portalAdmin: soCpusis, portalServidores: (s) => { soCpusis(s); exigir(s, 'servidores'); }, portalSalvarServidor: soAdmin, portalComando: soAdmin,
  portalCriarContabilidade: soAdmin, portalCriarCliente: soCpusis, portalSalvarRegime: soCpusis, portalUnificar: soAdmin,
  portalFinCarteira: (s) => exigir(s, 'bpo'), portalFinSalvarBpo: soCpusis,
};
const FIN = criarFin({ db, sessao, normal, podeVer, receptor, repassar } as any);
// as funções do BPO conferem a empresa; aqui confere o módulo
function comModulo(fn: (...a: any[]) => Promise<unknown>) {
  return async (...a: any[]) => { const s = await sessao(a[0]); exigir(s, 'bpo'); return await fn(...a); };
}
const FIN_FUNCOES: Record<string, (...a: any[]) => Promise<unknown>> = {};
Object.entries(FIN.funcoes).forEach(([k, f]) => (FIN_FUNCOES[k] = k === 'portalFinPlano' ? f : comModulo(f)));

async function portalAdmin(token: unknown) {   // estrutura e regimes vêm do receptor; logins, do banco
  const r = await repassar('portalAdmin', [token]);
  if (!r?.ok) throw new Error(r?.erro || 'Erro ao carregar.');
  try { const u = await portalUsuarios(token); r.r.usuarios = u.usuarios; } catch { /* segue */ }
  return r.r;
}

const NATIVAS: Record<string, (...a: any[]) => Promise<unknown>> = {
  portalAparencia, portalDados, portalResumo, portalIndicadores, portalIndicadoresLote, portalSair, portalEu, portalTrocarSenha, portalNcmBase,
  portalUsuarios, portalSalvarUsuario, portalExcluirUsuario, portalSessoes, portalDerrubarSessoes, portalAuditoria, portalAdmin,
  ...FIN_FUNCOES, portalFinLoginEmpresa,
};
const REPASSE = new Set(['portalArquivo', 'portalParte', 'portalCriarContabilidade', 'portalCriarCliente', 'portalSalvarRegime', 'portalServidores', 'portalSalvarServidor', 'portalUnificar', 'portalComando']);

async function portal(req: any) {
  const fn = String(req.fn || ''), args = Array.isArray(req.args) ? req.args : [];
  try {
    if (fn === 'portalLogin') return { ok: true, r: await portalLogin(args[0], args[1]) };
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
      case 'resumo': {
        if (!mesOk(it.mes) || !it.dados) break;
        const id = await idUnidade(it.contabilidade, it.cliente, it.subpasta || '', it.pid);
        const agora = new Date().toISOString();
        erroDb((await db.from('resumos').upsert({ unidade_id: id, mes: it.mes, dados: it.dados, atualizado_em: agora })).error);
        if (it.ind) erroDb((await db.from('indicadores').upsert({ unidade_id: id, mes: it.mes, dados: it.ind, atualizado_em: agora })).error);
        conta('resumos'); break;
      }
      case 'usuarios': {
        // os logins agora são administrados no portal (banco)
        const { data: cfg } = await db.from('portal_config').select('valor').eq('chave', 'usuarios_no_banco').maybeSingle();
        const linhas = (it.linhas || []).map((u: any) => ({
          login: String(u.login).trim().toLowerCase(), nome: u.nome || '', contabs: u.contabs || [], senha_hash: u.senha_hash || '',
          ativo: u.ativo !== false, empresa_contab: u.empresa_contab || null, empresa_cliente: u.empresa_cliente || null,
          perfil: (u.contabs || []).includes('*') ? 'admin' : u.empresa_cliente ? 'cliente' : 'contador',
        })).filter((u: any) => u.login && u.senha_hash);
        if (cfg?.valor === true) {
          // logins só pelo portal (menu Acessos): a planilha é ignorada, senão um login excluído ou com senha trocada voltaria
          conta('usuarios_ignorados', linhas.length);
        } else {
          await espelhar('usuarios', ['login'], linhas);
          conta('usuarios', linhas.length);
        }
        break;
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
      case 'bpo': { await FIN.espelharBpo(it.linhas || []); conta('bpo', (it.linhas || []).length); break; }
      case 'aparencia': { erroDb((await db.from('aparencia').upsert({ chave: 'portal', valor: JSON.stringify(it.dados || {}) })).error); conta('aparencia'); break; }
      case 'remover_unidade': {
        const u = await acharUnidade(it.contabilidade, it.cliente, it.subpasta || '');
        if (u) await db.from('unidades').delete().eq('id', u.id);
        conta('removidas'); break;
      }
      case 'estado': {
        const rs = await todas<any>(() => db.from('resumos').select('mes, atualizado_em, unidades(contab_n, cliente_n, subpasta_n)'));
        return { ok: true, resumos: rs.map((r) => ({ k: r.unidades.contab_n + '|' + r.unidades.cliente_n + '|' + r.unidades.subpasta_n + '|' + r.mes, em: r.atualizado_em })) };
      }
    }
  }
  return { ok: true, gravados: out };
}

// ---------------------------------------------------------------- entrada
Deno.serve(async (r) => {
  const CORS = corsDe(r.headers.get('origin'));
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
  if (r.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (r.method !== 'POST') return json({ ok: true, servico: 'Farol Contábil', versao: VERSAO });
  const ctx = { ip: (r.headers.get('x-forwarded-for') || r.headers.get('cf-connecting-ip') || '').split(',')[0].trim().slice(0, 60), agente: r.headers.get('user-agent') || '' };
  let req: any;
  const corpo = await r.text();
  if (corpo.length > 2_000_000) return json({ ok: false, erro: 'Pedido grande demais.' }, 413);
  try { req = JSON.parse(corpo); } catch { return json({ ok: false, erro: 'Pedido inválido.' }, 400); }
  try {
    if (req.acao === 'portal') return json(await CTX.run(ctx, () => portal(req)));
    if (req.acao === 'sync') return json(await sync(req));
    if (req.acao === 'whatsapp') return json(await FIN.whatsapp(req));
    return json({ ok: false, erro: 'Ação desconhecida.' }, 400);
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) });
  }
});
