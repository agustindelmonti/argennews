// Edge Function «store»: puente autenticado entre el servidor de Vercel y las tablas de Pampa 7.
// La clave service_role vive acá adentro (Supabase la inyecta como SUPABASE_SERVICE_ROLE_KEY) y nunca sale del proyecto.
// El servidor de Vercel se identifica con un token en el encabezado x-store-token; acá solo se guarda su hash SHA-256
// (tabla store_auth). Solo se permiten las tablas y funciones que usa la app; no es un proxy abierto.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const BASE = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ALLOWED: { re: RegExp; methods: string[] }[] = [
  { re: /^\/segments$/, methods: ["GET", "POST", "PATCH", "DELETE"] },
  { re: /^\/embeds$/, methods: ["GET", "POST", "DELETE"] },
  { re: /^\/rpc\/(bump_limit|presence_ping|vote_cast|vote_totals)$/, methods: ["POST"] },
];

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function sha256(s: string) { return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); }
function safeEqual(a: string, b: string) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

let cached: { hash: string | null; at: number } = { hash: null, at: 0 };
async function expectedHash() {
  if (cached.hash && Date.now() - cached.at < 60_000) return cached.hash;
  const r = await fetch(`${BASE}/rest/v1/store_auth?select=token_hash&limit=1`, { headers: { apikey: KEY, authorization: `Bearer ${KEY}` } });
  const rows = r.ok ? await r.json() : [];
  cached = { hash: rows[0]?.token_hash ?? null, at: Date.now() };
  return cached.hash;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

Deno.serve(async (req) => {
  const token = req.headers.get("x-store-token");
  const want = await expectedHash();
  if (!token || !want || !safeEqual(await sha256(token), want)) return json(401, { error: "unauthorized" });

  const url = new URL(req.url);
  const sub = url.pathname.replace(/^(\/functions\/v1)?\/store/, "") || "/";
  const rule = ALLOWED.find((a) => a.re.test(sub));
  if (!rule) return json(404, { error: "not found" });
  if (!rule.methods.includes(req.method)) return json(405, { error: "method not allowed" });

  const headers: Record<string, string> = { apikey: KEY, authorization: `Bearer ${KEY}`, "content-type": "application/json" };
  const prefer = req.headers.get("prefer"); if (prefer) headers.prefer = prefer;
  const upstream = await fetch(`${BASE}/rest/v1${sub}${url.search}`, { method: req.method, headers, body: req.method === "GET" ? undefined : await req.text() });
  return new Response(upstream.status === 204 ? null : upstream.body, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" } });
});
