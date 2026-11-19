// FAROL CONTÁBIL — ponte do WhatsApp (API oficial da Meta) para o receptor (Apps Script)
// A Meta exige um endereço que responda na hora e confirme a assinatura; o Apps Script não faz isso,
// então esta função pequena recebe, confere e repassa cada mensagem ao receptor.
// Variáveis (Supabase > Edge Functions > Secrets):
//   WA_VERIFY_TOKEN  palavra combinada na configuração do webhook na Meta
//   WA_APP_SECRET    "Chave secreta do app" (Meta) — confere a assinatura de cada chamada
//   RECEPTOR_URL     endereço /exec do receptor
//   WA_SEGREDO       o mesmo valor da propriedade WA_SEGREDO do receptor
const env = (k: string) => Deno.env.get(k) ?? "";

async function assinaturaOk(corpo: string, cab: string | null): Promise<boolean> {
  const segredo = env("WA_APP_SECRET");
  if (!segredo || !cab?.startsWith("sha256=")) return false;
  const chave = await crypto.subtle.importKey("raw", new TextEncoder().encode(segredo), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", chave, new TextEncoder().encode(corpo)));
  const hex = Array.from(sig).map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === cab.slice(7);
}

async function repassar(msg: Record<string, unknown>) {
  await fetch(env("RECEPTOR_URL"), {
    method: "POST", redirect: "follow", headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ acao: "whatsapp", segredo: env("WA_SEGREDO"), ...msg }),
  }).catch((e) => console.error("receptor:", e));
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET") {   // verificação do webhook pela Meta
    if (url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === env("WA_VERIFY_TOKEN")) {
      return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
    }
    return new Response("forbidden", { status: 403 });
  }
  if (req.method !== "POST") return new Response("ok");
  const corpo = await req.text();
  if (!(await assinaturaOk(corpo, req.headers.get("x-hub-signature-256")))) return new Response("assinatura inválida", { status: 401 });
  let dados: any = {};
  try { dados = JSON.parse(corpo); } catch { return new Response("ok"); }
  const tarefas: Promise<void>[] = [];
  for (const e of dados.entry ?? []) for (const ch of e.changes ?? []) {
    const v = ch.value ?? {}, nomes: Record<string, string> = {};
    for (const c of v.contacts ?? []) nomes[c.wa_id] = c.profile?.name ?? "";
    for (const m of v.messages ?? []) {
      const midia = m.image ?? m.document ?? null;
      tarefas.push(repassar({
        de: m.from, nome: nomes[m.from] ?? "", tipo: m.type, id: m.id,
        texto: m.text?.body ?? midia?.caption ?? "",
        mediaId: midia?.id ?? "", mime: midia?.mime_type ?? "", arquivo: m.document?.filename ?? "",
      }));
    }
  }
  // responde 200 na hora para a Meta; o receptor processa (IA + planilha) em seguida
  // @ts-ignore EdgeRuntime existe no Supabase
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(Promise.all(tarefas)); else await Promise.all(tarefas);
  return new Response("ok");
});
