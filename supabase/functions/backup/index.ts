// Farol Contábil — cópia de segurança do banco (Edge Function "backup").
// Só leitura. Chamada pelo receptor (Apps Script) uma vez por noite, com a senha do receptor.
// Devolve as tabelas que NÃO podem ser refeitas a partir do Drive (financeiro do BPO e configurações),
// mais o histórico e os acessos. Resumos, indicadores e envios voltam sozinhos pela sincronização do Drive.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const SENHA = Deno.env.get('RECEPTOR_SENHA') || '';
const TABELAS = ['bpo', 'fin_contas', 'fin_lancamentos', 'fin_regras', 'fin_comprovantes', 'regimes', 'unificados', 'aparencia', 'unidades', 'historico', 'acessos'];

function iguais(a: string, b: string): boolean {   // comparação em tempo constante
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const json = (o: unknown, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

async function todas(tabela: string) {
  const linhas: unknown[] = [];
  for (let de = 0; ; de += 1000) {
    const { data, error } = await db.from(tabela).select('*').range(de, de + 999);
    if (error) throw new Error(tabela + ': ' + error.message);
    linhas.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return linhas;
}

Deno.serve(async (r) => {
  if (r.method !== 'POST') return json({ ok: false, erro: 'Use POST.' }, 405);
  let req: any; try { req = JSON.parse(await r.text()); } catch { return json({ ok: false, erro: 'Pedido inválido.' }, 400); }
  if (!SENHA || !iguais(String(req.senha || ''), SENHA)) return json({ ok: false, erro: 'Senha inválida.' }, 401);
  try {
    const tabelas: Record<string, unknown[]> = {}, contagem: Record<string, number> = {};
    for (const t of TABELAS) { tabelas[t] = await todas(t); contagem[t] = tabelas[t].length; }
    return json({ ok: true, versao: 1, geradoEm: new Date().toISOString(), contagem, tabelas });
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message || e) }, 500);
  }
});
