// Análisis de una noticia al recibirla (sin gastar IA): detecta duplicadas y la puntúa por señales de oficio.
// Con ANTHROPIC_API_KEY, app.js suma además una nota de humor y la moderación de un modelo chico.
import { SEGMENTS, CLIMA } from '../public/seed.js';

const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const bag = (s) => new Set(norm(s).replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 3));
export const jaccard = (a, b) => { if (!a.size || !b.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); };

// Las originales (relleno + clima): contra ellas también se compara.
export const originales = () => [...SEGMENTS, ...CLIMA].map((s) => ({ titular: s.titular, bajada: s.bajada }));

// Devuelve el titular parecido si la noticia es casi igual a otra que ya existe.
export function findDuplicate(seg, others, threshold = 0.6) {
  const full = bag(`${seg.titular} ${seg.bajada}`), head = bag(seg.titular);
  for (const o of others) {
    // un titular casi igual alcanza para considerarla repetida, aunque cambie la bajada; si no, se compara el conjunto
    if (jaccard(head, bag(o.titular)) >= 0.75 || jaccard(full, bag(`${o.titular} ${o.bajada || ''}`)) >= threshold) return o.titular;
  }
  return null;
}

// Puntaje 0-100 por señales de oficio (el humor lo decide la gente con sus votos).
export function analyzeLocal(seg) {
  let p = 40; const señales = [];
  const add = (pts, txt) => { p += pts; señales.push(`${pts >= 0 ? '+' : ''}${pts} ${txt}`); };
  if (seg.ticker.length >= 2) add(10, 'ticker completo'); else if (!seg.ticker.length) add(-5, 'sin ticker');
  if (seg.conductor.length >= 120 && seg.conductor.length <= 280) add(10, 'texto del conductor con cuerpo'); else add(-5, 'texto del conductor muy corto');
  if (seg.titular.length >= 25 && seg.titular.length <= 58) add(10, 'titular de buen largo');
  if (seg.bajada.length >= 40) add(5, 'bajada con gracia (largo)');
  if (seg.emoji.length >= 2) add(5, 'escena con 2+ emojis');
  if (/^desde\b/i.test(seg.movil)) add(5, 'móvil en formato «Desde…»');
  const letras = seg.conductor.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ]/g, '');
  if (letras.length && letras.replace(/[^A-ZÁÉÍÓÚÑ]/g, '').length / letras.length > 0.5) add(-15, 'conductor todo en mayúsculas');
  return { puntaje: Math.max(0, Math.min(100, p)), señales };
}
