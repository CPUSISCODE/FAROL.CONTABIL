// Farol Contábil — Cofre CPUSIS (todo usuário de perfil admin ou cpusis; contador, gestor e cliente nunca).
// Guarda, por unidade (matriz/filial): CSC (id + código) e certificado digital A1 (arquivo .pfx + senha).
//  - segredos criptografados com AES-256-GCM antes de ir ao banco; a chave sai do segredo COFRE_CHAVE da função
//    (nunca fica no banco nem no GitHub). Sem a chave, o banco sozinho não abre nada;
//  - a lista nunca traz segredo: só "tem / não tem", validade e titular do certificado;
//  - revelar CSC/senha ou baixar o .pfx fica no registro de acessos (quem, quando, qual cliente);
//  - limite de 40 revelações/downloads por hora por usuário;
//  - ao salvar, o .pfx é aberto com a senha: senha errada não entra, e a validade/titular são lidos do próprio certificado;
//  - último número de NF-e (55) e NFC-e (65) por série vem dos resumos que o agente manda (agente 2.4+).
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import forge from 'npm:node-forge@1.3.1';

type Sessao = { login: string; nome: string; contabs: string[]; empresa?: unknown; perfil?: string; modulos?: string[] };
type Ctx = {
  db: SupabaseClient;
  sessao: (t: unknown) => Promise<Sessao>;
  perfilDe: (s: Sessao) => string;
  logAcesso: (login: string, acao: string, detalhe: string) => Promise<void>;
  todas: <T>(q: () => any, passo?: number) => Promise<T[]>;
};

const MAX_PFX = 64 * 1024;          // certificado A1 tem poucos KB
const LIMITE_HORA = 40;

let chaveCache: CryptoKey | null = null;
async function chave(): Promise<CryptoKey> {
  if (chaveCache) return chaveCache;
  const seg = Deno.env.get('COFRE_CHAVE') || '';
  if (seg.length < 24) throw new Error('O Cofre ainda não foi ativado: falta cadastrar o segredo COFRE_CHAVE no Supabase.');
  const bruto = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('farol-cofre-v1|' + seg));
  chaveCache = await crypto.subtle.importKey('raw', bruto, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return chaveCache;
}
const b64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const deB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function cifrar(dados: Uint8Array, contexto: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(contexto) }, await chave(), dados));
  return 'v1:' + b64(iv) + ':' + b64(ct);
}
async function decifrar(guardado: string, contexto: string): Promise<Uint8Array> {
  const [v, iv, ct] = String(guardado || '').split(':');
  if (v !== 'v1' || !iv || !ct) throw new Error('Dado do cofre ilegível.');
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: deB64(iv), additionalData: new TextEncoder().encode(contexto) }, await chave(), deB64(ct)));
  } catch { throw new Error('Não foi possível abrir este dado do cofre (chave diferente da usada para guardar).'); }
}
const txt = (u: Uint8Array) => new TextDecoder().decode(u);
const bytes = (s: string) => new TextEncoder().encode(s);

function lerPfx(pfx: Uint8Array, senha: string) {
  let p12;
  try {
    let bin = ''; for (let i = 0; i < pfx.length; i++) bin += String.fromCharCode(pfx[i]);
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(bin), senha);
  } catch (e) {
    const m = String((e as Error)?.message || e);
    if (/MAC|password|decrypt/i.test(m)) throw new Error('A senha não abre este certificado. Confira a senha.');
    throw new Error('Arquivo não parece um certificado A1 (.pfx / .p12) válido.');
  }
  const bags = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || []).map((b: any) => b.cert).filter(Boolean);
  if (!bags.length) throw new Error('Certificado sem dados legíveis.');
  // o certificado do titular é o que não é autoridade (AC); se não der para saber, o de validade mais curta
  const titular = bags.find((c: any) => !(c.getExtension('basicConstraints') || {}).cA) || bags.sort((a: any, b: any) => a.validity.notAfter - b.validity.notAfter)[0];
  const cn = String((titular.subject.getField('CN') || {}).value || '');
  const nome = cn.includes(':') ? cn.split(':')[0] : cn;
  const doc = (cn.match(/:(\d{11,14})$/) || [])[1] || '';
  return { inicio: titular.validity.notBefore.toISOString(), validade: titular.validity.notAfter.toISOString(), titular: nome.slice(0, 200), doc };
}

const CAMPOS_RENOV = 'contato_nome, contato_fone, contato_email, renov_status, renov_ref, renov_obs, renov_aviso_em, renov_aviso_por, renov_avisos, renov_historico';
export const STATUS: Record<string, string> = {
  nao_avisado: 'Não avisado', avisado: 'Avisado', negociando: 'Em negociação', agendado: 'Renovação agendada',
  renovado: 'Renovou com a CPUSIS', outro: 'Renovou com outra certificadora', nao_renova: 'Não vai renovar',
};
const FINAIS = ['renovado', 'outro', 'nao_renova'];
const MSG_PADRAO = 'Olá, {contato}! Aqui é da CPUSIS. O certificado digital da {empresa} vence em {vencimento} ({prazo}). ' +
  'Sem ele a empresa para de emitir nota fiscal. A CPUSIS faz a renovação com condição especial para nossos clientes: quer que a gente já deixe agendado?';
const DIA = 864e5;
// etapas de aviso: 60, 30, 15 e 7 dias antes; na última semana, de 2 em 2 dias; vencido, de 3 em 3 dias
export function renovacao(k: any, xml: any, foneBpo?: string) {
  const cad = k.cert_validade ? new Date(k.cert_validade).getTime() : 0;
  const lido = xml?.validade ? new Date(xml.validade).getTime() : 0;
  const val = Math.max(cad, lido);            // o mais novo vale (certificado renovado aparece primeiro nas notas)
  const fonte = !val ? '' : val === lido && lido !== cad ? 'nota' : 'cofre';
  const agora = Date.now();
  const dias = val ? Math.floor((val - agora) / DIA) : null;
  let status = k.renov_status || '';
  // veio certificado novo depois da situação marcada: mostra como renovado; quando ele mesmo chegar a 60 dias, começa ciclo novo
  if (status && k.renov_ref && val && val > new Date(k.renov_ref).getTime() + DIA) status = dias! > 60 ? (FINAIS.includes(status) ? status : 'renovado') : '';
  const ultimo = k.renov_aviso_em ? new Date(k.renov_aviso_em).getTime() : 0;
  let etapa: number | null = null, avisarHoje = false;
  if (dias != null && dias <= 60 && !FINAIS.includes(status)) {
    etapa = dias < 0 ? 0 : dias <= 7 ? 7 : dias <= 15 ? 15 : dias <= 30 ? 30 : 60;
    const entrouEm = etapa === 0 ? val : val - etapa * DIA;
    if (!ultimo || ultimo < entrouEm) avisarHoje = true;
    else if (etapa === 7 && agora - ultimo >= 2 * DIA) avisarHoje = true;
    else if (etapa === 0 && agora - ultimo >= 3 * DIA) avisarHoje = true;
  }
  return {
    validadeEfetiva: val ? new Date(val).toISOString() : '', fonte, dias, etapa, avisarHoje,
    tipo: xml?.tipo || (k.cert_pfx_cifrado ? 'A1' : ''), emissor: xml?.emissor || '',
    contatoNome: k.contato_nome || '', contatoFone: k.contato_fone || foneBpo || '', contatoEmail: k.contato_email || '', foneDoBpo: !k.contato_fone && !!foneBpo,
    renovStatus: status, renovObs: k.renov_obs || '', avisoEm: k.renov_aviso_em || '', avisoPor: k.renov_aviso_por || '', avisos: k.renov_avisos || 0,
    historico: Array.isArray(k.renov_historico) ? k.renov_historico.slice(-10).reverse() : [],
  };
}

export function criarCofre(c: Ctx) {
  const { db } = c;
  async function soCofre(token: unknown) {
    const s = await c.sessao(token);
    if (!['admin', 'cpusis'].includes(c.perfilDe(s))) throw new Error('O Cofre é só da equipe da CPUSIS.');
    return s;
  }
  async function unidade(id: unknown) {
    const n = Number(id);
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Unidade inválida.');
    const { data, error } = await db.from('unidades').select('id, contabilidade, cliente, subpasta').eq('id', n).maybeSingle();
    if (error) throw new Error('Banco: ' + error.message);
    if (!data) throw new Error('Cliente não encontrado.');
    return data;
  }
  const normalU = (u: any) => (u.contab_n || '') + '|' + (u.cliente_n || '');
  async function contatosBpo() {   // WhatsApp já cadastrado no BPO serve de contato inicial
    const out: Record<string, string> = {};
    try {
      const { data } = await db.from('bpo').select('contab_n, cliente_n, whatsapp');
      (data || []).forEach((b: any) => { const w = Array.isArray(b.whatsapp) ? b.whatsapp[0] : b.whatsapp; if (w) out[b.contab_n + '|' + b.cliente_n] = String(w).replace(/\D/g, ''); });
    } catch { /* sem BPO, sem contato inicial */ }
    return out;
  }
  const nomeU = (u: any) => u.cliente + (u.subpasta ? ' / ' + u.subpasta : '') + ' (' + u.contabilidade + ')';
  async function limite(login: string) {
    const desde = new Date(Date.now() - 3600e3).toISOString();
    const { count } = await db.from('acessos').select('id', { count: 'exact', head: true }).eq('login', login).in('acao', ['cofre-revelar', 'cofre-baixar']).gte('em', desde);
    if ((count || 0) >= LIMITE_HORA) throw new Error('Limite de ' + LIMITE_HORA + ' consultas ao cofre por hora atingido. Tente mais tarde.');
  }

  async function portalCofreLista(token: unknown) {
    await soCofre(token);
    const us = await c.todas<any>(() => db.from('unidades').select('id, contabilidade, cliente, subpasta, contab_n, cliente_n').order('contab_n').order('cliente_n').order('subpasta_n'));
    const cf = await c.todas<any>(() => db.from('cofre').select('unidade_id, csc_id, csc_cifrado, cert_senha_cifrada, cert_pfx_cifrado, cert_arquivo, cert_inicio, cert_validade, cert_titular, cert_doc, obs, atualizado_por, atualizado_em, ' + CAMPOS_RENOV));
    const contatoBpo = await contatosBpo();
    const porU: Record<number, any> = {}; cf.forEach((r) => (porU[r.unidade_id] = r));
    // últimos números: junta os resumos dos últimos 4 meses, maior número por modelo/série
    const d = new Date(); d.setUTCMonth(d.getUTCMonth() - 3);
    const mesMin = d.toISOString().slice(0, 7);
    const rs = await c.todas<any>(() => db.from('resumos').select('unidade_id, mes, ult:dados->ultimosNumeros, cx:dados->certificadoXml, cnpj:dados->>cnpj').gte('mes', mesMin).order('mes', { ascending: false }));
    const nums: Record<number, Record<string, any>> = {}, cnpj: Record<number, string> = {}, comUlt: Record<number, boolean> = {};
    const certXml: Record<number, any> = {};
    rs.forEach((r) => {
      if (r.cnpj && !cnpj[r.unidade_id]) cnpj[r.unidade_id] = r.cnpj;
      if (r.cx && r.cx.validade && (!certXml[r.unidade_id] || String(r.cx.notaEm || '') > String(certXml[r.unidade_id].notaEm || ''))) certXml[r.unidade_id] = r.cx;
      if (!Array.isArray(r.ult)) return;
      comUlt[r.unidade_id] = true;
      const m = (nums[r.unidade_id] = nums[r.unidade_id] || {});
      r.ult.forEach((x: any) => {
        const k = String(x.modelo) + '|' + String(Number(x.serie));
        if (!m[k] || Number(x.numero) > Number(m[k].numero)) m[k] = { modelo: String(x.modelo), serie: String(Number(x.serie)), numero: Number(x.numero), data: x.data || '' };
      });
    });
    return {
      unidades: us.map((u) => {
        const k = porU[u.id] || {};
        return {
          id: u.id, contabilidade: u.contabilidade, cliente: u.cliente, subpasta: u.subpasta || '', cnpj: cnpj[u.id] || '',
          numeros: Object.values(nums[u.id] || {}).sort((a: any, b: any) => a.modelo.localeCompare(b.modelo) || Number(a.serie) - Number(b.serie)),
          numerosAgente: !!comUlt[u.id],
          cscId: k.csc_id || '', temCsc: !!k.csc_cifrado, temSenha: !!k.cert_senha_cifrada, temPfx: !!k.cert_pfx_cifrado, arquivo: k.cert_arquivo || '',
          inicio: k.cert_inicio || '', validade: k.cert_validade || '', titular: k.cert_titular || '', doc: k.cert_doc || '',
          obs: k.obs || '', por: k.atualizado_por || '', em: k.atualizado_em || '',
          xml: certXml[u.id] || null,
          ...renovacao(k, certXml[u.id], contatoBpo[normalU(u)]),
        };
      }),
      ativo: (Deno.env.get('COFRE_CHAVE') || '').length >= 24,
    };
  }

  // d: { cscId?, csc?, senha?, pfx? (base64), arquivo?, obs?, apagarCsc?, apagarCert? } — campo ausente = não mexe
  async function portalCofreSalvar(token: unknown, id: unknown, d: any) {
    const s = await soCofre(token);
    const u = await unidade(id);
    d = d && typeof d === 'object' ? d : {};
    const { data: atual, error } = await db.from('cofre').select('*').eq('unidade_id', u.id).maybeSingle();
    if (error) throw new Error('Banco: ' + error.message);
    const novo: Record<string, unknown> = { unidade_id: u.id, atualizado_por: s.login, atualizado_em: new Date().toISOString() };
    const mudou: string[] = [];
    const ctx = (campo: string) => 'u' + u.id + '|' + campo;
    if (d.apagarCsc) { novo.csc_id = null; novo.csc_cifrado = null; mudou.push('CSC apagado'); }
    else {
      if (typeof d.cscId === 'string') { const v = d.cscId.trim().slice(0, 20); if (v && !/^[0-9A-Za-z]{1,20}$/.test(v)) throw new Error('Id do CSC inválido.'); novo.csc_id = v || null; if ((atual?.csc_id || '') !== v) mudou.push('id do CSC'); }
      if (typeof d.csc === 'string' && d.csc.trim()) { const v = d.csc.trim(); if (v.length > 64 || !/^[0-9A-Za-z-]+$/.test(v)) throw new Error('Código CSC inválido (só letras, números e traço).'); novo.csc_cifrado = await cifrar(bytes(v), ctx('csc')); mudou.push('código CSC'); }
    }
    if (d.apagarCert) {
      Object.assign(novo, { cert_senha_cifrada: null, cert_pfx_cifrado: null, cert_arquivo: null, cert_inicio: null, cert_validade: null, cert_titular: null, cert_doc: null });
      mudou.push('certificado apagado');
    } else {
      const temSenhaNova = typeof d.senha === 'string' && d.senha.length > 0;
      const temPfxNovo = typeof d.pfx === 'string' && d.pfx.length > 0;
      if (temSenhaNova && d.senha.length > 200) throw new Error('Senha longa demais.');
      if (temSenhaNova || temPfxNovo) {
        let pfx: Uint8Array | null = null;
        if (temPfxNovo) {
          try { pfx = deB64(d.pfx); } catch { throw new Error('Arquivo do certificado corrompido no envio.'); }
          if (pfx.length > MAX_PFX) throw new Error('Arquivo grande demais para um certificado A1.');
        } else if (atual?.cert_pfx_cifrado) pfx = await decifrar(atual.cert_pfx_cifrado, ctx('pfx'));
        const senha = temSenhaNova ? d.senha : (atual?.cert_senha_cifrada ? txt(await decifrar(atual.cert_senha_cifrada, ctx('senha'))) : '');
        if (pfx) {
          if (!senha) throw new Error('Informe a senha do certificado.');
          const info = lerPfx(pfx, senha);
          Object.assign(novo, { cert_inicio: info.inicio, cert_validade: info.validade, cert_titular: info.titular, cert_doc: info.doc });
        }
        if (temPfxNovo) { novo.cert_pfx_cifrado = await cifrar(pfx!, ctx('pfx')); novo.cert_arquivo = String(d.arquivo || 'certificado.pfx').replace(/[^\w .()-]/g, '_').slice(0, 120); mudou.push('arquivo do certificado'); }
        if (temSenhaNova) { novo.cert_senha_cifrada = await cifrar(bytes(senha), ctx('senha')); mudou.push('senha do certificado'); }
      }
    }
    if (typeof d.obs === 'string') { novo.obs = d.obs.slice(0, 1000) || null; if ((atual?.obs || '') !== d.obs) mudou.push('observação'); }
    const { error: e2 } = await db.from('cofre').upsert(novo, { onConflict: 'unidade_id' });
    if (e2) throw new Error('Banco: ' + e2.message);
    await c.logAcesso(s.login, 'cofre-salvar', nomeU(u) + ': ' + (mudou.join(', ') || 'sem mudança'));
    return { ok: true, validade: novo.cert_validade ?? atual?.cert_validade ?? '', titular: novo.cert_titular ?? atual?.cert_titular ?? '' };
  }

  async function portalCofreRevelar(token: unknown, id: unknown, campo: unknown) {
    const s = await soCofre(token);
    const u = await unidade(id);
    const cpo = String(campo);
    if (cpo !== 'csc' && cpo !== 'senha') throw new Error('Campo inválido.');
    await limite(s.login);
    const { data } = await db.from('cofre').select('csc_cifrado, cert_senha_cifrada').eq('unidade_id', u.id).maybeSingle();
    const g = cpo === 'csc' ? data?.csc_cifrado : data?.cert_senha_cifrada;
    if (!g) throw new Error('Nada guardado.');
    const v = txt(await decifrar(g, 'u' + u.id + '|' + cpo));
    await c.logAcesso(s.login, 'cofre-revelar', nomeU(u) + ': ' + (cpo === 'csc' ? 'código CSC' : 'senha do certificado'));
    return { valor: v };
  }

  async function portalCofreBaixar(token: unknown, id: unknown) {
    const s = await soCofre(token);
    const u = await unidade(id);
    await limite(s.login);
    const { data } = await db.from('cofre').select('cert_pfx_cifrado, cert_arquivo').eq('unidade_id', u.id).maybeSingle();
    if (!data?.cert_pfx_cifrado) throw new Error('Nenhum certificado guardado.');
    const pfx = await decifrar(data.cert_pfx_cifrado, 'u' + u.id + '|pfx');
    await c.logAcesso(s.login, 'cofre-baixar', nomeU(u) + ': arquivo do certificado');
    return { arquivo: data.cert_arquivo || 'certificado.pfx', base64: b64(pfx) };
  }

  // resumo para o aviso da Central: vencidos, vencendo em 60 dias e quantos avisar hoje
  async function portalCofreAvisos(token: unknown) {
    const r: any = await portalCofreLista(token);
    let vencidos = 0, vencendo = 0, avisarHoje = 0;
    r.unidades.forEach((u: any) => {
      if (u.dias == null) return;
      if (u.dias < 0) vencidos++; else if (u.dias <= 60) vencendo++;
      if (u.avisarHoje) avisarHoje++;
    });
    return { vencidos, vencendo, avisarHoje };
  }

  // contato e situação da renovação. d: { contatoNome?, contatoFone?, contatoEmail?, status?, obs?, avisou?: 'whatsapp'|'email'|'telefone'|'outro' }
  async function portalCofreRenovacao(token: unknown, id: unknown, d: any) {
    const s = await soCofre(token);
    const u = await unidade(id);
    d = d && typeof d === 'object' ? d : {};
    const { data: atual, error } = await db.from('cofre').select('unidade_id, cert_validade, renov_status, renov_avisos, renov_historico').eq('unidade_id', u.id).maybeSingle();
    if (error) throw new Error('Banco: ' + error.message);
    const novo: Record<string, unknown> = { unidade_id: u.id };
    const lim = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n) || null;
    if ('contatoNome' in d) novo.contato_nome = lim(d.contatoNome, 120);
    if ('contatoFone' in d) { const f = String(d.contatoFone || '').replace(/\D/g, ''); if (f && (f.length < 10 || f.length > 13)) throw new Error('Telefone inválido (DDD + número).'); novo.contato_fone = f || null; }
    if ('contatoEmail' in d) { const e = lim(d.contatoEmail, 160); if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('E-mail inválido.'); novo.contato_email = e; }
    if ('obs' in d) novo.renov_obs = lim(d.obs, 1000);
    const validadeAtual = typeof d.validade === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d.validade) ? d.validade : (atual?.cert_validade || null);
    const hist = Array.isArray(atual?.renov_historico) ? atual!.renov_historico.slice(-29) : [];
    const agora = new Date().toISOString();
    if ('status' in d) {
      if (!STATUS[d.status]) throw new Error('Situação inválida.');
      novo.renov_status = d.status; novo.renov_ref = validadeAtual;
      if ((atual?.renov_status || '') !== d.status) hist.push({ em: agora, por: s.login, oque: 'situação: ' + STATUS[d.status] });
    }
    if (d.avisou) {
      const meio = ['whatsapp', 'email', 'telefone', 'outro'].includes(d.avisou) ? d.avisou : 'outro';
      novo.renov_aviso_em = agora; novo.renov_aviso_por = s.login; novo.renov_avisos = (atual?.renov_avisos || 0) + 1;
      hist.push({ em: agora, por: s.login, oque: 'avisou por ' + meio });
      if (!('status' in d) && (!atual?.renov_status || atual.renov_status === 'nao_avisado')) { novo.renov_status = 'avisado'; novo.renov_ref = validadeAtual; }
    }
    novo.renov_historico = hist;
    const { error: e2 } = await db.from('cofre').upsert(novo, { onConflict: 'unidade_id' });
    if (e2) throw new Error('Banco: ' + e2.message);
    await c.logAcesso(s.login, 'cofre-renovacao', nomeU(u) + ': ' + (hist.length ? hist[hist.length - 1].oque : 'contato atualizado'));
    return { ok: true };
  }

  // texto padrão da mensagem de renovação (o mesmo para toda a equipe)
  async function portalCofreMensagem(token: unknown, texto?: unknown) {
    const s = await soCofre(token);
    if (typeof texto === 'string') {
      const t = texto.trim().slice(0, 1500);
      const { error } = await db.from('portal_config').upsert({ chave: 'cofre_msg', valor: t, atualizado_em: new Date().toISOString() }, { onConflict: 'chave' });
      if (error) throw new Error('Banco: ' + error.message);
      await c.logAcesso(s.login, 'cofre-mensagem', 'texto da mensagem de renovação alterado');
      return { texto: t || MSG_PADRAO };
    }
    const { data } = await db.from('portal_config').select('valor').eq('chave', 'cofre_msg').maybeSingle();
    return { texto: (data?.valor as string) || MSG_PADRAO };
  }

  return { portalCofreLista, portalCofreSalvar, portalCofreRevelar, portalCofreBaixar, portalCofreAvisos, portalCofreRenovacao, portalCofreMensagem };
}
