// Genera la voz del conductor de las noticias originales (public/seed.js) como archivos de audio: public/audio/<id>.mp3 + manifest.json.
// Voz: SVOX Pico (es-ES) con la ortografía ajustada al seseo rioplatense (no existe una voz argentina). Corre sin internet ni claves.
// Necesita: pico2wave (Debian/Ubuntu: sudo apt install libttspico-utils) y ffmpeg.
// Uso: node scripts/generar-voces.mjs [--force]      (solo regenera lo que cambió, salvo --force)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SEGMENTS, CLIMA } from '../public/seed.js';

const OUT = new URL('../public/audio/', import.meta.url).pathname, FORCE = process.argv.includes('--force');
const SPEED = process.env.VOZ_VELOCIDAD || '130', PITCH = process.env.VOZ_TONO || '100';   // pico2wave: 20–500 / 50–200
mkdirSync(OUT, { recursive: true });

const U = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
const D = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const C = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];
function num(n) {
  if (n < 30) return U[n];
  if (n < 100) return D[Math.floor(n / 10)] + (n % 10 ? ' y ' + U[n % 10] : '');
  if (n === 100) return 'cien';
  if (n < 1000) return C[Math.floor(n / 100)] + (n % 100 ? ' ' + num(n % 100) : '');
  const m = Math.floor(n / 1000), r = n % 1000;
  return (m === 1 ? 'mil' : num(m) + ' mil') + (r ? ' ' + num(r) : '');
}
// Texto → lo que se le da a la voz. Seseo: z y c(e/i) suenan como s, como en Buenos Aires.
function hablado(t) {
  return t.replace(/\d+/g, (d) => num(Number(d)))
    .replace(/z/g, 's').replace(/Z/g, 'S').replace(/c([eiéí])/g, 's$1').replace(/C([eiéíEIÉÍ])/g, 'S$1')
    .replace(/\s+/g, ' ').trim();
}

const tmp = join(tmpdir(), 'p7-voz'); mkdirSync(tmp, { recursive: true });
const manifestPath = OUT + 'manifest.json';
const prev = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { ids: [], hash: {} };
const hash = {}, ids = [];
let hechos = 0;
for (const s of [...SEGMENTS, ...CLIMA]) {
  if (!s.id || !s.conductor) continue;
  const texto = hablado(s.conductor), h = createHash('sha1').update([texto, SPEED, PITCH].join('|')).digest('hex').slice(0, 12);
  hash[s.id] = h;
  const mp3 = OUT + s.id + '.mp3';
  if (!FORCE && prev.hash && prev.hash[s.id] === h && existsSync(mp3)) { ids.push(s.id); continue; }
  const wav = join(tmp, 'v.wav');
  execFileSync('pico2wave', ['-l', 'es-ES', '-w', wav, `<speed level='${SPEED}'><pitch level='${PITCH}'>${texto}</pitch></speed>`]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav, '-af', 'loudnorm=I=-16:TP=-1.5,aresample=24000', '-ac', '1', '-b:a', '56k', mp3]);
  ids.push(s.id); hechos++;
}
rmSync(tmp, { recursive: true, force: true });
writeFileSync(manifestPath, JSON.stringify({ ids, hash }, null, 0));
console.log(`${hechos} voces generadas, ${ids.length - hechos} sin cambios → ${OUT}`);
