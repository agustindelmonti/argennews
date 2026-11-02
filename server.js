// Servidor sin dependencias: estáticos + API del televisor + servidor MCP + panel de administración.
//   /api/config, /api/script, /api/tts        el televisor (noticia propia con IA)
//   /api/programacion                         segmentos aprobados + tweets elegidos
//   /mcp                                      servidor MCP (Streamable HTTP, sin estado) para ChatGPT, Claude, etc.
//   /admin/api/*                              moderación, tweets, tendencias y colaboraciones (Bearer ADMIN_TOKEN)
import http from 'node:http';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');

if (existsSync(join(ROOT, '.env'))) {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]] && m[2]) process.env[m[1]] = m[2];
  }
}
const env = (k, d) => process.env[k] ?? d;
const PORT = Number(env('PORT', 4173));
const MODEL = env('ANTHROPIC_MODEL', 'claude-sonnet-5-5');
const MODEL_CHEAP = env('ANTHROPIC_MODEL_CHEAP', 'claude-haiku-5-5');
const KEY = () => process.env.ANTHROPIC_API_KEY;
const ADMIN_TOKEN = env('ADMIN_TOKEN', '');
const AUTO_APPROVE = env('AUTO_APPROVE', '') === '1';
const DATA_DIR = env('DATA_DIR', join(ROOT, 'data'));
const DB_FILE = join(DATA_DIR, 'db.json');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

/* ---------------- Límites diarios en memoria (producción: Redis/Supabase) ---------------- */
function limiter(perIp, global) {
  let day = new Date().toDateString(), total = 0; const ips = new Map();
  return (ip) => {
    const today = new Date().toDateString();
    if (today !== day) { day = today; total = 0; ips.clear(); }
    const n = ips.get(ip) || 0;
    if (n >= perIp || total >= global) return false;
    ips.set(ip, n + 1); total++; return true;
  };
}
const scriptLimit = limiter(Number(env('DAILY_LIMIT_PER_IP', 5)), Number(env('DAILY_LIMIT_GLOBAL', 500)));
const mcpLimit = limiter(Number(env('MCP_LIMIT_PER_IP', 10)), Number(env('MCP_LIMIT_GLOBAL', 300)));

/* ---------------- Base de datos en archivo JSON (para el MVP; después Supabase) ---------------- */
let db = { segments: [], embeds: [] };
if (existsSync(DB_FILE)) { try { db = { segments: [], embeds: [], ...JSON.parse(readFileSync(DB_FILE, 'utf8')) }; } catch { console.error('db.json ilegible, arranco vacío'); } }
let saving = Promise.resolve();
function save() {
  saving = saving.then(async () => { await mkdir(DATA_DIR, { recursive: true }); const tmp = DB_FILE + '.tmp'; await writeFile(tmp, JSON.stringify(db, null, 1)); await rename(tmp, DB_FILE); }).catch((e) => console.error('save', e));
  return saving;
}

/* ---------------- Validación de segmentos (todo lo que llega de afuera es dato no confiable) ---------------- */
const PALETTES = [['#0b3d91', '#e0202b'], ['#1b6ef3', '#7ad3ff'], ['#7a3b00', '#f0a020'], ['#2a0a5e', '#8a2be2'], ['#0a6b2b', '#7bd34a'], ['#3b2a6b', '#e08a1a'], ['#0a3d2e', '#2fbf71'], ['#6b0a5e', '#ff6fb5'], ['#16314d', '#6ec1d8']];
const plain = (s, n) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// Primer filtro grosero (no reemplaza la moderación): sexo, violencia, odio, política y personas públicas frecuentes.
const BAD = ['porno', 'pornograf', 'sexual', 'sexo', 'violacion', 'violar', 'suicid', 'nazi', 'hitler', 'pedofil', 'terroris', 'asesinat', 'asesino', 'matanza', 'genocid', 'racis', 'sudaca', 'retrasad', 'mongol', 'puto', 'trolo', 'cancer', 'covid', 'desaparecid', 'femicid', 'milei', 'cristina', 'macri', 'kirchner', 'bullrich', 'massa', 'trump', 'biden', 'messi', 'maradona'];

function checkSegment(raw, { needAutor = false } = {}) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const seg = {
    etiqueta: plain(raw.etiqueta || 'ÚLTIMO MOMENTO', 24).toUpperCase(),
    titular: plain(raw.titular, 60).toUpperCase(),
    bajada: plain(raw.bajada, 100),
    movil: plain(raw.movil || 'Desde un lugar del barrio', 44),
    conductor: plain(raw.conductor, 300),
    ticker: (Array.isArray(raw.ticker) ? raw.ticker : []).slice(0, 3).map((t) => plain(t, 70)).filter(Boolean),
    emoji: (Array.isArray(raw.emoji) ? raw.emoji : []).map((e) => plain(e, 16)).filter((e) => /\p{Extended_Pictographic}/u.test(e)).slice(0, 3),
  };
  if (!seg.emoji.length) seg.emoji = ['📺'];
  if (seg.titular.length < 8 || seg.bajada.length < 5 || seg.conductor.length < 40) return { error: 'Faltan datos: titular (8+ caracteres), bajada (5+) y conductor (40+).' };
  const all = [seg.etiqueta, seg.titular, seg.bajada, seg.movil, seg.conductor, ...seg.ticker].join(' ');
  if (/https?:|www\.|\.com\b|\.ar\b|@/i.test(all)) return { error: 'No se permiten links ni menciones dentro de la noticia.' };
  const n = norm(all);
  const hit = BAD.find((b) => n.includes(b));
  if (hit) return { error: 'La noticia toca un tema que no emitimos (violencia, sexo, odio, política o personas reales). Probá con una situación cotidiana y ficticia.' };
  seg.bg = Array.isArray(raw.bg) && raw.bg.length === 2 && raw.bg.every((c) => /^#[0-9a-f]{6}$/i.test(c)) ? raw.bg : PALETTES[Math.floor(Math.random() * PALETTES.length)];
  const autor = raw.autor ? plain(raw.autor, 40).replace(/^@/, '') : '';
  if (needAutor && !autor) return { error: 'Falta el crédito del autor.' };
  return { seg, autor };
}
const credito = (s) => (s.autor ? (s.source === 'colab' ? `Gentileza de ${s.autor}` : `Enviada por @${s.autor}`) : undefined);
const pub = (s) => ({ id: s.id, source: s.source, etiqueta: s.etiqueta, titular: s.titular, bajada: s.bajada, movil: s.movil, conductor: s.conductor, ticker: s.ticker, emoji: s.emoji, bg: s.bg, credito: credito(s), video: s.video });

/* ---------------- IA (solo para moderar y para tendencias; el guion de usuarios lo escribe SU asistente vía MCP) ---------------- */
async function claude({ model, system, content, max_tokens = 800 }) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY(), 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens, system, messages: [{ role: 'user', content }] }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json(); return (d.content || []).map((c) => c.text || '').join('');
}
const jsonOf = (t, open = '{', close = '}') => JSON.parse(t.slice(t.indexOf(open), t.lastIndexOf(close) + 1));

async function moderate(seg) {
  if (!KEY()) return false;
  try {
    const t = await claude({ model: MODEL_CHEAP, max_tokens: 30,
      system: 'Moderás textos de humor para un noticiero ficticio. Respondé SOLO {"ok":true} o {"ok":false}. ok=false si el texto nombra o insinúa personas reales o figuras públicas, política real, tragedias o crímenes reales, sexo, violencia, odio, burlas a personas por su cuerpo, género, religión, salud o etnia, datos personales, o publicidad de algo real.',
      content: JSON.stringify(seg) });
    return jsonOf(t).ok === true;
  } catch { return false; }
}

const STYLE = `Sos guionista de PAMPA 7 NOTICIAS, un noticiero argentino ficticio de los años 90/2000.
Estilo: castellano rioplatense, sensacionalismo exagerado y tierno de la tele de aquella época ("ÚLTIMO MOMENTO", "alarma en el barrio", "mirá vos", "los vecinos no lo pueden creer"). Convertí una situación cotidiana en una gran catástrofe, escándalo o hito, con ironía cariñosa.
REGLAS: nada de personas reales ni figuras públicas, políticos, marcas reales, tragedias o crímenes reales, sexo, violencia, odio, ni burlas a personas por su aspecto, género, religión, salud o etnia. El humor es contra la situación, nunca contra las personas. Sin links ni menciones. Lugares genéricos ("desde un living de Caballito").
FORMATO: etiqueta (ÚLTIMO MOMENTO, EL CLIMA, DEPORTES, FARÁNDULA, EXCLUSIVA...), titular (máx 60, se pasa a mayúsculas), bajada (máx 100), movil ("Desde ..." máx 44), conductor (2-3 oraciones, 40-300 caracteres, para leer en voz alta), ticker (hasta 3 frases de relleno absurdas, máx 70 c/u), emoji (1 a 3 emojis que ilustren la escena).
EJEMPLO: {"etiqueta":"ÚLTIMO MOMENTO","titular":"CONMOCIÓN: EL COLECTIVO PASÓ A HORARIO","bajada":"Vecinos no saben cómo reaccionar. Hay quienes lloran.","movil":"Desde una parada cualquiera","conductor":"Atención, atención. Hecho inédito esta mañana: el colectivo llegó exactamente a la hora anunciada. Los pasajeros, desconcertados, miraron el reloj varias veces. Especialistas piden calma.","ticker":["Se investiga si fue un error del reloj","Chofer evalúa no volver a hacerlo"],"emoji":["🚌","⏰"]}`;

/* ---------------- MCP (Streamable HTTP, sin estado) ---------------- */
const NEWS_PROPS = {
  titular: { type: 'string', description: 'Titular en mayúsculas o normal, máx 60 caracteres.' },
  bajada: { type: 'string', description: 'Frase corta bajo el titular, máx 100 caracteres.' },
  conductor: { type: 'string', description: 'Lo que dice el conductor en voz alta: 2-3 oraciones, entre 40 y 300 caracteres.' },
  etiqueta: { type: 'string', description: 'Ej: ÚLTIMO MOMENTO, EL CLIMA, DEPORTES, FARÁNDULA, EXCLUSIVA. Máx 24 caracteres.' },
  movil: { type: 'string', description: 'Ej: "Desde un living de Caballito". Máx 44 caracteres.' },
  ticker: { type: 'array', items: { type: 'string' }, maxItems: 3, description: 'Hasta 3 frases absurdas de relleno, máx 70 caracteres c/u.' },
  emoji: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3, description: '1 a 3 emojis que ilustren la escena.' },
  autor: { type: 'string', description: 'Opcional: alias para el crédito en pantalla (letras, números, _ . -).' },
};
const TOOLS = [
  { name: 'guia_de_estilo', description: 'Devuelve la guía de estilo, las reglas y un ejemplo para escribir noticias de Pampa 7. Llamala antes de crear una noticia si no la conocés.',
    inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'crear_noticia', description: 'Publica una noticia de humor en Pampa 7 Noticias, un noticiero argentino ficticio de los 90. VOS escribís la noticia (a partir de lo que pidió la persona) siguiendo la guía de estilo y la enviás ya redactada en los campos. Debe ser una situación ficticia y cotidiana, sin personas reales, política, marcas ni temas sensibles. Queda pendiente de aprobación y, si pasa la moderación, sale al aire en el canal 5 (Comunidad) y en el 3.',
    inputSchema: { type: 'object', properties: NEWS_PROPS, required: ['titular', 'bajada', 'conductor'] }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: 'ver_noticias_recientes', description: 'Lista los titulares de las últimas noticias de la comunidad ya aprobadas, para no repetir ideas.',
    inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, openWorldHint: false } },
];
const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

async function callTool(name, args, ip) {
  if (name === 'guia_de_estilo') return text(STYLE);
  if (name === 'ver_noticias_recientes') {
    const l = db.segments.filter((s) => s.source === 'mcp' && s.status === 'approved').slice(-10).map((s) => `- ${s.titular}`);
    return text(l.length ? l.join('\n') : 'Todavía no hay noticias de la comunidad aprobadas. Podés ser la primera.');
  }
  if (name === 'crear_noticia') {
    const { seg, autor, error } = checkSegment(args);
    if (error) return text(error + ' Ajustá la noticia y volvé a llamar a crear_noticia.', true);
    if (!mcpLimit(ip)) return text('Llegaste al límite de noticias por hoy. Volvé mañana.', true);   // solo cuentan las válidas
    const ok = AUTO_APPROVE && (await moderate(seg));
    const row = { id: randomUUID(), source: 'mcp', status: ok ? 'approved' : 'pending', createdAt: new Date().toISOString(), autor, ...seg };
    db.segments.push(row); await save();
    return text(ok ? `¡Al aire! "${seg.titular}" ya se emite en el canal 5 (Comunidad) y en el 3.` : `Recibida: "${seg.titular}". Queda pendiente de aprobación; cuando se apruebe sale en el canal 5 (Comunidad) y en el 3.`);
  }
  return text(`Herramienta desconocida: ${name}`, true);
}

async function rpc(msg, ip) {
  const { id, method, params } = msg || {};
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (id === undefined) return null;                       // notificación: sin respuesta
  switch (method) {
    case 'initialize': return ok({ protocolVersion: params?.protocolVersion || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'pampa7-noticias', version: '0.1.0' },
      instructions: 'Conector para mandar noticias de humor al noticiero ficticio Pampa 7. Pedile a la persona un tema cotidiano, escribí la noticia con guia_de_estilo y publicala con crear_noticia.' });
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS });
    case 'tools/call': return ok(await callTool(params?.name, params?.arguments || {}, ip));
    default: return err(-32601, `Método no soportado: ${method}`);
  }
}

/* ---------------- Tendencias y colaboraciones ---------------- */
async function fetchTrends() {
  const r = await fetch('https://trends.google.com/trending/rss?geo=AR', { headers: { 'user-agent': 'Mozilla/5.0 (Pampa7)' } });
  if (!r.ok) throw new Error(`Trends ${r.status}`);
  const x = await r.text();
  const dec = (s) => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
  return [...x.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>/g)].map((m) => dec(m[1])).filter(Boolean).slice(0, 25);
}
async function generateFromTrends(topics) {
  const t = await claude({ model: MODEL, max_tokens: 2500,
    system: STYLE + `\n\nTe paso TEMAS del momento en Argentina (solo palabras). Escribí un segmento por tema, pero SOLO si podés convertirlo en una situación cotidiana ficticia y simpática. Saltá cualquier tema que sea una persona real, un equipo o figura pública, política, un crimen, una tragedia, salud o algo sensible. No menciones el tema literal si es una persona o marca: inspirate en la idea general (ej. "lluvia" -> un pronóstico absurdo). Devolvé SOLO un array JSON de objetos con el formato indicado, más el campo "tema" con el tema de origen.`,
    content: 'Temas:\n' + topics.map((x) => `- ${plain(x, 80)}`).join('\n') });
  return jsonOf(t, '[', ']');
}

/* ---------------- HTTP ---------------- */
function readBody(req, limit = 12e6) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const isAdmin = (req) => {
  if (!ADMIN_TOKEN) return false;
  const got = Buffer.from((req.headers.authorization || '').replace(/^Bearer /, '')), want = Buffer.from(ADMIN_TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
};
const tweetId = (u) => { try { const x = new URL(u); return /^(x|twitter)\.com$|^(www|mobile)\.(x|twitter)\.com$/.test(x.hostname) ? (x.pathname.match(/\/status\/(\d{5,25})/) || [])[1] : null; } catch { return null; } };
const videoUrl = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && /\.(mp4|webm|mov)$/i.test(x.pathname) ? x.href : null; } catch { return null; } };

async function admin(req, res, url) {
  if (!ADMIN_TOKEN) return send(res, 503, { error: 'Administración desactivada: definí ADMIN_TOKEN.' });
  if (!isAdmin(req)) return send(res, 401, { error: 'Token inválido.' });
  const p = url.pathname.replace('/admin/api', ''), body = req.method === 'POST' ? JSON.parse((await readBody(req, 2e5)) || '{}') : {};

  if (req.method === 'GET' && p === '/state') return send(res, 200, { segments: db.segments.slice(-200).reverse(), embeds: db.embeds, ai: !!KEY(), autoApprove: AUTO_APPROVE });
  let m;
  if (req.method === 'POST' && (m = p.match(/^\/segments\/([\w-]+)\/(approve|reject|delete)$/))) {
    const i = db.segments.findIndex((s) => s.id === m[1]); if (i < 0) return send(res, 404, { error: 'No existe.' });
    if (m[2] === 'delete') db.segments.splice(i, 1); else db.segments[i].status = m[2] === 'approve' ? 'approved' : 'rejected';
    await save(); return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && p === '/segments') {   // colaboración o noticia curada a mano
    const { seg, autor, error } = checkSegment(body, { needAutor: true }); if (error) return send(res, 400, { error });
    if (!body.permiso) return send(res, 400, { error: 'Confirmá que tenés permiso del autor.' });
    let video; if (body.video) { video = videoUrl(body.video); if (!video) return send(res, 400, { error: 'El video debe ser un link https a .mp4, .webm o .mov.' }); }
    db.segments.push({ id: randomUUID(), source: 'colab', status: 'approved', createdAt: new Date().toISOString(), autor, video, ...seg }); await save();
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && p === '/embeds') {
    const id = tweetId(String(body.url || '')); if (!id) return send(res, 400, { error: 'Pegá el link de un tweet (x.com/usuario/status/123…).' });
    if (db.embeds.some((e) => e.id === id)) return send(res, 409, { error: 'Ya está en la lista.' });
    db.embeds.push({ id, url: `https://x.com/i/status/${id}`, addedAt: new Date().toISOString() }); await save(); return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && (m = p.match(/^\/embeds\/(\d+)\/delete$/))) { db.embeds = db.embeds.filter((e) => e.id !== m[1]); await save(); return send(res, 200, { ok: true }); }
  if (req.method === 'GET' && p === '/trends') {
    try { return send(res, 200, { topics: await fetchTrends() }); } catch (e) { return send(res, 502, { error: 'No pude traer las tendencias (' + e.message + '). Podés pegar los temas a mano.' }); }
  }
  if (req.method === 'POST' && p === '/trends/generate') {
    if (!KEY()) return send(res, 400, { error: 'Falta ANTHROPIC_API_KEY.' });
    const topics = (Array.isArray(body.topics) ? body.topics : []).map((t) => plain(t, 80)).filter(Boolean).slice(0, 12);
    if (!topics.length) return send(res, 400, { error: 'Elegí al menos un tema.' });
    let out = []; try { out = await generateFromTrends(topics); } catch (e) { return send(res, 502, { error: 'La IA no respondió bien: ' + e.message }); }
    let added = 0;
    for (const raw of out) { const { seg, error } = checkSegment(raw); if (error) continue; db.segments.push({ id: randomUUID(), source: 'trend', status: 'pending', createdAt: new Date().toISOString(), tema: plain(raw.tema, 80), ...seg }); added++; }
    await save(); return send(res, 200, { added, skipped: out.length - added });
  }
  return send(res, 404, { error: 'No existe.' });
}

export const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

    if (url.pathname.startsWith('/admin/api/')) return await admin(req, res, url);

    if (url.pathname === '/mcp') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Usá POST (MCP Streamable HTTP).' });
      let msg; try { msg = JSON.parse(await readBody(req, 5e4)); } catch { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido' } }); }
      if (Array.isArray(msg)) { const out = (await Promise.all(msg.map((m) => rpc(m, ip)))).filter(Boolean); return out.length ? send(res, 200, out) : send(res, 202, ''); }
      const out = await rpc(msg, ip); return out ? send(res, 200, out) : send(res, 202, '');
    }

    if (req.method === 'GET' && url.pathname === '/api/config') return send(res, 200, { demo: !KEY(), tts: !!process.env.OPENAI_API_KEY });
    if (req.method === 'GET' && url.pathname === '/api/programacion') return send(res, 200, { segments: db.segments.filter((s) => s.status === 'approved').map(pub), embeds: db.embeds.map((e) => ({ id: e.id, url: e.url })) });

    if (req.method === 'POST' && url.pathname === '/api/script') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const frames = Array.isArray(body.frames) ? body.frames.slice(0, 8) : [];
      if (!frames.length || !body.consent) return send(res, 400, { error: 'Faltan fotogramas o consentimiento.' });
      if (!scriptLimit(ip)) return send(res, 429, { error: 'Llegaste al límite de noticias por hoy. Volvé mañana.' });
      let s;
      if (!KEY()) s = { ok: true, ...DEMOS[Math.floor(Math.random() * DEMOS.length)] };
      else {
        const content = frames.map((f) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: f.replace(/^data:image\/jpeg;base64,/, '') } }));
        content.push({ type: 'text', text: 'Estos son fotogramas en orden cronológico del video. Escribí la noticia sobre lo que SE VE. Si ves desnudez, violencia, menores en situación vulnerable o algo inapropiado, respondé {"ok":false,"motivo":"..."}. Devolvé SOLO un JSON con ok, etiqueta, titular, bajada, movil, conductor y ticker.' });
        s = jsonOf(await claude({ model: MODEL, max_tokens: 700, system: STYLE, content }));
      }
      if (s.ok === false) return send(res, 422, { error: 'Esta imagen no se puede emitir.', motivo: plain(s.motivo, 140) });
      return send(res, 200, { etiqueta: plain(s.etiqueta || 'ÚLTIMO MOMENTO', 24).toUpperCase(), titular: plain(s.titular, 60).toUpperCase(), bajada: plain(s.bajada, 100), movil: plain(s.movil, 44), conductor: plain(s.conductor, 300), ticker: (Array.isArray(s.ticker) ? s.ticker : []).slice(0, 3).map((t) => plain(t, 70)) });
    }

    if (req.method === 'POST' && url.pathname === '/api/tts') {
      if (!process.env.OPENAI_API_KEY) return send(res, 501, { error: 'TTS no configurado' });
      const { text: t } = JSON.parse((await readBody(req, 1e5)) || '{}');
      const r = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: env('OPENAI_TTS_VOICE', 'onyx'), response_format: 'mp3', input: plain(t, 320), instructions: 'Locutor de noticiero argentino de los años 90. Acento rioplatense, tono grave, ritmo apurado y dramático.' }),
      });
      if (!r.ok) return send(res, 502, { error: 'TTS falló' });
      return send(res, 200, Buffer.from(await r.arrayBuffer()), 'audio/mpeg');
    }

    let p = normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
    if (p === '/' || p === '\\') p = '/index.html';
    const file = join(PUBLIC, p);
    if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden', 'text/plain');
    send(res, 200, await readFile(file), MIME[extname(file)] || 'application/octet-stream');
  } catch (e) {
    if (e.code === 'ENOENT') return send(res, 404, 'not found', 'text/plain');
    console.error(e); send(res, 500, { error: 'Error interno. Probá de nuevo.' });
  }
});

const DEMOS = [
  { etiqueta: 'ÚLTIMO MOMENTO', titular: 'ALARMA EN EL BARRIO: NADIE ENTIENDE QUÉ PASÓ', bajada: 'Vecinos conmocionados. Las imágenes ya dieron la vuelta a la manzana.', movil: 'Desde Villa Crespo, en vivo', conductor: 'Atención, atención. Las cámaras de Pampa 7 captaron imágenes impactantes que nos dejan sin palabras. Los vecinos dicen que jamás vieron algo así. Mirá vos.', ticker: ['Dólar blue sube dos pesos y nadie se sorprende', 'Gran expectativa por el fin de semana largo', 'Perro adopta rutina y la sostiene con firmeza'] },
  { etiqueta: 'NOTICIA EXCLUSIVA', titular: 'HALLAZGO HISTÓRICO CAPTADO POR NUESTRO MÓVIL', bajada: 'Especialistas analizan el material. Nadie se pone de acuerdo.', movil: 'Desde un living de Caballito', conductor: 'Y ahora, una exclusiva de este canal. Nuestro móvil llegó antes que nadie al lugar de los hechos. Los especialistas piden calma, pero la gente no la tiene.', ticker: ['Colectivo 60 llega a horario: investigan', 'Se agotó el dulce de leche en tres barrios', 'Termómetro se mantiene indeciso'] },
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => console.log(`Pampa 7 Noticias en http://localhost:${PORT}  (${KEY() ? 'IA real' : 'modo demo'}${ADMIN_TOKEN ? ', admin activo en /admin.html' : ', admin desactivado'})`));
}
