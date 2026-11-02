// Servidor mínimo sin dependencias: sirve /public y expone /api/script y /api/tts.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');

// .env muy simple (sin dependencia)
if (existsSync(join(ROOT, '.env'))) {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]] && m[2]) process.env[m[1]] = m[2];
  }
}

const PORT = Number(process.env.PORT || 4173);
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const LIMIT_IP = Number(process.env.DAILY_LIMIT_PER_IP || 5);
const LIMIT_GLOBAL = Number(process.env.DAILY_LIMIT_GLOBAL || 500);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---- Límite diario en memoria (para producción: Redis/Supabase) ----
let day = new Date().toDateString();
let globalCount = 0;
const perIp = new Map();
function allow(ip) {
  const today = new Date().toDateString();
  if (today !== day) { day = today; globalCount = 0; perIp.clear(); }
  const n = perIp.get(ip) || 0;
  if (n >= LIMIT_IP || globalCount >= LIMIT_GLOBAL) return false;
  perIp.set(ip, n + 1); globalCount++;
  return true;
}

const SYSTEM = `Sos el guionista de PAMPA 7 NOTICIAS, un noticiero argentino ficticio de los años 90/2000.
Recibís fotogramas de un video casero de un usuario y escribís una noticia de humor sobre lo que SE VE.

Estilo: castellano rioplatense, sensacionalismo exagerado y tierno de la tele de aquella época
("ÚLTIMO MOMENTO", "alarma en el barrio", "los vecinos no lo pueden creer", "mirá vos", "atención, atención").
Convertí lo cotidiano en una gran catástrofe/escándalo/hito, con ironía cariñosa. Podés inventar un
lugar genérico ("barrio de Villa Crespo" está bien; usá lugares genéricos) y datos absurdos.

REGLAS DURAS:
- Hablá solo de lo que se ve. No inventes ni nombres de personas reales ni de figuras públicas, políticos ni marcas reales.
- Nada de política real, tragedias reales, ni burlas a aspecto físico, género, orientación, religión, salud o etnia de nadie.
- El humor es contra la situación, nunca contra las personas.
- Si ves desnudez, violencia, menores en situación vulnerable, o algo inapropiado, respondé ok=false.

Devolvé SOLO un JSON válido, sin texto extra ni markdown, con esta forma:
{
 "ok": true,
 "motivo": "" ,
 "etiqueta": "ÚLTIMO MOMENTO",
 "titular": "máx 55 caracteres, MAYÚSCULAS",
 "bajada": "máx 90 caracteres",
 "movil": "Desde ... (máx 40 caracteres)",
 "conductor": "2 o 3 oraciones, máx 280 caracteres, como lo diría el conductor del noticiero, listo para leer en voz alta",
 "ticker": ["3 titulares absurdos de relleno, máx 60 caracteres cada uno"]
}`;

const DEMOS = [
  { etiqueta: 'ÚLTIMO MOMENTO', titular: 'ALARMA EN EL BARRIO: NADIE ENTIENDE QUÉ PASÓ', bajada: 'Vecinos conmocionados. Las imágenes ya dieron la vuelta a la manzana.', movil: 'Desde Villa Crespo, en vivo', conductor: 'Atención, atención. Las cámaras de Pampa 7 captaron imágenes impactantes que nos dejan sin palabras. Los vecinos dicen que jamás vieron algo así. Mirá vos.', ticker: ['Dólar blue sube dos pesos y nadie se sorprende', 'Gran expectativa por el fin de semana largo', 'Perro adopta rutina y la sostiene con firmeza'] },
  { etiqueta: 'NOTICIA EXCLUSIVA', titular: 'HALLAZGO HISTÓRICO CAPTADO POR NUESTRO MÓVIL', bajada: 'Especialistas analizan el material. Nadie se pone de acuerdo.', movil: 'Desde un living de Caballito', conductor: 'Y ahora, una exclusiva de este canal. Nuestro móvil llegó antes que nadie al lugar de los hechos. Los especialistas piden calma, pero la gente no la tiene.', ticker: ['Colectivo 60 llega a horario: investigan', 'Se agotó el dulce de leche en tres barrios', 'Termómetro se mantiene indeciso'] },
];

async function callClaude(frames) {
  const content = frames.map((f) => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: f.replace(/^data:image\/jpeg;base64,/, '') },
  }));
  content.push({ type: 'text', text: 'Estos son fotogramas en orden cronológico del video. Escribí la noticia.' });
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 700, system: SYSTEM, messages: [{ role: 'user', content }] }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  const text = (data.content || []).map((c) => c.text || '').join('');
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(json);
}

function clean(s, n) { return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n); }

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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

    if (req.method === 'GET' && url.pathname === '/api/config') {
      return send(res, 200, { demo: !process.env.ANTHROPIC_API_KEY, tts: !!process.env.OPENAI_API_KEY });
    }

    if (req.method === 'POST' && url.pathname === '/api/script') {
      const body = JSON.parse(await readBody(req) || '{}');
      const frames = Array.isArray(body.frames) ? body.frames.slice(0, 8) : [];
      if (!frames.length || !body.consent) return send(res, 400, { error: 'Faltan fotogramas o consentimiento.' });
      if (!allow(ip)) return send(res, 429, { error: 'Llegaste al límite de noticias por hoy. Volvé mañana.' });

      let s;
      if (!process.env.ANTHROPIC_API_KEY) {
        s = { ok: true, ...DEMOS[Math.floor(Math.random() * DEMOS.length)] };
      } else {
        s = await callClaude(frames);
      }
      if (s.ok === false) return send(res, 422, { error: 'Esta imagen no se puede emitir.', motivo: clean(s.motivo, 140) });
      return send(res, 200, {
        etiqueta: clean(s.etiqueta || 'ÚLTIMO MOMENTO', 24).toUpperCase(),
        titular: clean(s.titular, 60).toUpperCase(),
        bajada: clean(s.bajada, 100),
        movil: clean(s.movil, 44),
        conductor: clean(s.conductor, 300),
        ticker: (Array.isArray(s.ticker) ? s.ticker : []).slice(0, 3).map((t) => clean(t, 70)),
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/tts') {
      if (!process.env.OPENAI_API_KEY) return send(res, 501, { error: 'TTS no configurado' });
      const { text } = JSON.parse(await readBody(req, 1e5) || '{}');
      const r = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({
          model: 'gpt-4o-mini-tts', voice: process.env.OPENAI_TTS_VOICE || 'onyx', response_format: 'mp3',
          input: clean(text, 320),
          instructions: 'Locutor de noticiero argentino de los años 90. Acento rioplatense, tono grave, ritmo apurado y dramático.',
        }),
      });
      if (!r.ok) return send(res, 502, { error: 'TTS falló' });
      return send(res, 200, Buffer.from(await r.arrayBuffer()), 'audio/mpeg');
    }

    // Estáticos
    let p = normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
    if (p === '/' || p === '\\') p = '/index.html';
    const file = join(PUBLIC, p);
    if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden', 'text/plain');
    const data = await readFile(file);
    send(res, 200, data, MIME[extname(file)] || 'application/octet-stream');
  } catch (e) {
    if (e.code === 'ENOENT') return send(res, 404, 'not found', 'text/plain');
    console.error(e);
    send(res, 500, { error: 'Error interno. Probá de nuevo.' });
  }
});

server.listen(PORT, () => console.log(`Pampa 7 Noticias en http://localhost:${PORT}  (${process.env.ANTHROPIC_API_KEY ? 'IA real' : 'modo demo'})`));
