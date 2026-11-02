// Pampa 7 Noticias — un televisor. Cada canal es una función de la app:
//   1 Cámara · 2 Redacción · 3 Pampa 7 (tu noticia al aire) · 4 Estudio (ajustes)
// El noticiero se dibuja en un <canvas>; la vista previa y la descarga usan el mismo pipeline.
import { SEGMENTS } from './seed.js';
const W = 640, H = 480;
const MAX_CLIP = 12;
const CH_NAMES = { 1: 'CÁMARA', 2: 'REDACCIÓN', 3: 'PAMPA 7', 4: 'ESTUDIO' };
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cv = $('screen'), g = cv.getContext('2d');
const vid = $('vid'), live = $('preview');

const S = {
  on: true, ch: 3, guide: false, filter: true, userNext: false, sinceMine: 0, order: [],
  vol: 0.6, muted: false,
  mode: 'idle',                // idle | live | air
  config: { demo: true, tts: false },
  story: null, clipDur: 0,
  air: null, airPromise: null, loopId: 0, busy: false,
  ac: null, mix: null, mon: null, dest: null,
  ttsBuf: null, ttsText: '',
  stream: null, recorder: null, recChunks: [], recStart: 0,
  staticUntil: 0, pwr: null,   // animación de encendido/apagado del tubo
};
const ready = () => !!S.story && S.clipDur > 0;

fetch('/api/config').then((r) => r.json()).then((c) => { S.config = c; }).catch(() => {});

/* ---------------- OSD: mensajes, badge de canal, volumen ---------------- */
const timers = {};
function flash(id, ms) { const el = $(id); el.hidden = false; clearTimeout(timers[id]); timers[id] = setTimeout(() => (el.hidden = true), ms); }
function say(t, ms = 3200) { if (!S.on) return; $('msg').dataset.pos = S.ch === 3 && !S.guide ? 'top' : 'bottom'; $('msg').textContent = t; flash('msg', ms); }
function badge() { if (!S.on) return; $('chbadge').innerHTML = `CH ${String(S.ch).padStart(2, '0')}<small>${CH_NAMES[S.ch]}</small>`; flash('chbadge', 2200); }
function volOsd() {
  const n = S.muted ? 0 : Math.round(S.vol * 10);
  $('volbar').textContent = (S.muted ? 'MUTE ' : 'VOL ') + '█'.repeat(n) + '░'.repeat(10 - n);
  flash('volbar', 1600); $('rbMute').classList.toggle('on', S.muted);
}

/* ---------------- Audio ---------------- */
// `mix` alimenta la grabación y no depende del volumen del usuario; `mon` es lo que suena en los parlantes.
function ensureAudio() {
  if (S.ac) { S.ac.resume(); return; }
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  S.ac = ac; S.mix = ac.createGain(); S.mon = ac.createGain(); S.dest = ac.createMediaStreamDestination();
  S.mix.connect(S.dest); S.mix.connect(S.mon); S.mon.connect(ac.destination);
  ac.createMediaElementSource(vid).connect(S.mix);
  applyVolume();
}
function applyVolume() { if (S.mon) S.mon.gain.value = !S.on || S.muted ? 0 : S.vol * S.vol; }
function setVol(d) { S.vol = Math.min(1, Math.max(0, Math.round((S.vol + d) * 10) / 10)); if (S.muted && d > 0) S.muted = false; applyVolume(); volOsd(); }
function toggleMute() { S.muted = !S.muted; applyVolume(); volOsd(); }

function sting(at) {
  const ac = S.ac;
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
    const o = ac.createOscillator(), gn = ac.createGain();
    o.type = i === 3 ? 'sawtooth' : 'square'; o.frequency.value = f;
    const t0 = at + i * 0.17, len = i === 3 ? 0.6 : 0.16;
    gn.gain.setValueAtTime(0.0001, t0);
    gn.gain.exponentialRampToValueAtTime(0.12, t0 + 0.02);
    gn.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
    o.connect(gn); gn.connect(S.mix); o.start(t0); o.stop(t0 + len + 0.05);
  });
}
function blip(freq = 880, len = 0.08) {   // beep del control remoto (solo parlantes, no entra en la grabación)
  if (!S.ac || !S.on) return;
  const o = S.ac.createOscillator(), gn = S.ac.createGain(), t = S.ac.currentTime;
  o.type = 'square'; o.frequency.value = freq; gn.gain.setValueAtTime(0.05, t); gn.gain.exponentialRampToValueAtTime(0.0001, t + len);
  o.connect(gn); gn.connect(S.mon); o.start(t); o.stop(t + len + 0.02);
}
async function prepareVoice(text) {
  if (!S.config.tts || !text) { S.ttsBuf = null; return; }
  if (S.ttsText === text && S.ttsBuf) return;
  try {
    const r = await fetch('/api/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!r.ok) throw new Error('tts');
    S.ttsBuf = await S.ac.decodeAudioData(await r.arrayBuffer()); S.ttsText = text;
  } catch { S.ttsBuf = null; }
}
function speakFallback(text) {
  if (!('speechSynthesis' in window) || S.muted) return;
  const u = new SpeechSynthesisUtterance(text), vs = speechSynthesis.getVoices();
  const v = vs.find((x) => /es-AR/i.test(x.lang)) || vs.find((x) => /^es/i.test(x.lang));
  if (v) u.voice = v;
  u.lang = v ? v.lang : 'es-AR'; u.rate = 1.12; u.pitch = 0.85; u.volume = S.vol;
  speechSynthesis.cancel(); speechSynthesis.speak(u);
}

/* ---------------- Encendido, canales, navegación ---------------- */
const PAGES = { 1: 'pCam', 2: 'pDesk', 4: 'pStudio' };
function renderPages() {
  const show = (id, v) => { $(id).hidden = !v; };
  ['pCam', 'pDesk', 'pStudio', 'pGuide', 'pAir'].forEach((id) => show(id, false));
  if (!S.on) return;
  if (S.guide) { show('pGuide', true); focusFirst('pGuide'); return; }
  if (PAGES[S.ch]) { show(PAGES[S.ch], true); focusFirst(PAGES[S.ch]); }
  if (S.ch === 3) show('pAir', ready());
  if (S.ch === 2) refreshDesk();
}
function focusFirst(id) {
  const el = $(id).querySelector('button:not([disabled]),input:not([hidden]):not([disabled]),label.osd-btn');
  if (el && el.focus) setTimeout(() => el.focus({ preventScroll: true }), 30);
}
function guardBusy() { if (S.busy) { say('Grabando la emisión… esperá un momento.'); return true; } return false; }

function setChannel(n, silent) {
  if (!S.on || guardBusy()) return;
  if (S.mode === 'live') { say('Detené la grabación antes de cambiar de canal.'); return; }
  n = ((n - 1 + 4) % 4) + 1;
  S.ch = n; S.guide = false; S.loopId++;
  if (S.air) S.air.cancel = true;
  if (!silent) { S.staticUntil = performance.now() + 380; blip(660, 0.12); }
  badge(); renderPages();
  if (n === 3) startLoop();
}
function toggleGuide() { if (!S.on || guardBusy()) return; S.guide = !S.guide; blip(990, 0.06); renderPages(); }

function power() {
  if (S.busy) { say('Grabando la emisión… esperá un momento.'); return; }
  if (S.mode === 'live') { say('Detené la grabación antes de apagar.'); return; }
  S.on = !S.on; S.loopId++;
  if (S.air) S.air.cancel = true;
  S.pwr = { type: S.on ? 'on' : 'off', at: performance.now() };
  if (S.on) { S.guide = false; S.ch = 3; S.staticUntil = performance.now() + 500; ensureAudio(); setTimeout(() => { badge(); blip(1200, 0.15); }, 450); startLoop(); }
  else { vid.pause(); window.speechSynthesis && speechSynthesis.cancel(); ['chbadge', 'volbar', 'msg'].forEach((i) => ($(i).hidden = true)); }
  applyVolume(); renderPages();
}

function fullscreen() {
  const fail = () => say('Tu navegador no permite pantalla completa acá.');
  try { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(fail); } catch { fail(); }
}

const ACT = { power, guide: toggleGuide, chup: () => setChannel(S.ch + 1), chdn: () => setChannel(S.ch - 1), volup: () => { if (S.on) setVol(0.1); }, voldn: () => { if (S.on) setVol(-0.1); }, mute: () => { if (S.on) toggleMute(); }, full: fullscreen };
function ensureAudioSoft() { try { ensureAudio(); } catch { /* sin audio */ } }
document.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => { ensureAudioSoft(); ACT[b.dataset.act](); }));
document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => setChannel(Number(b.dataset.goto))));

addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (/^(INPUT|TEXTAREA)$/.test(t.tagName) && t.type !== 'checkbox') return;
  const k = e.key.toLowerCase();
  const map = { p: 'power', g: 'guide', m: 'mute', f: 'full', '+': 'volup', '=': 'volup', '-': 'voldn', arrowright: 'volup', arrowleft: 'voldn', arrowup: 'chup', arrowdown: 'chdn' };
  if (k === 'escape' && S.guide) { toggleGuide(); return; }
  if (/^[1-4]$/.test(k)) { ensureAudioSoft(); setChannel(Number(k)); e.preventDefault(); return; }
  if (map[k]) { ensureAudioSoft(); ACT[map[k]](); e.preventDefault(); }
});

/* ---------------- Canal 1: Cámara ---------------- */
function pickMime() {
  // MP4 solo si es H.264 de verdad (el 'video/mp4' genérico a veces guarda VP9, que X/LinkedIn rechazan).
  const c = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return c.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}
$('btnRec').onclick = async () => {
  ensureAudio();
  if (S.recorder && S.recorder.state === 'recording') { S.recorder.stop(); return; }
  try { S.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 } }, audio: true }); }
  catch { say('No pude acceder a la cámara. Podés subir un video en su lugar.', 4500); return; }
  live.srcObject = S.stream; await live.play();
  const mime = pickMime(); S.recChunks = [];
  S.recorder = new MediaRecorder(S.stream, mime ? { mimeType: mime } : undefined);
  S.recorder.ondataavailable = (e) => e.data.size && S.recChunks.push(e.data);
  S.recorder.onstop = () => {
    S.stream.getTracks().forEach((t) => t.stop());
    S.mode = 'idle'; $('btnRec').textContent = '● Grabar de nuevo'; $('pCam').classList.remove('clear');
    loadClip(new Blob(S.recChunks, { type: S.recorder.mimeType || 'video/webm' }));
  };
  S.recorder.start(250); S.recStart = performance.now(); S.mode = 'live';
  $('btnRec').textContent = '■ Detener'; $('pCam').classList.add('clear');
  setTimeout(() => S.recorder && S.recorder.state === 'recording' && S.recorder.stop(), 10000);
};
$('file').onchange = (e) => { const f = e.target.files[0]; if (f) { ensureAudio(); loadClip(f); } e.target.value = ''; };

const seek = (t) => new Promise((res) => { vid.onseeked = () => { vid.onseeked = null; res(); }; vid.currentTime = t; });
async function loadClip(blob) {
  say('Cargando tu video…');
  S.clipDur = 0; S.story = null;
  vid.src = URL.createObjectURL(blob);
  const ok = await new Promise((res) => { vid.onloadedmetadata = () => res(true); vid.onerror = () => res(false); });
  if (!ok) { say('No pude leer ese video. Probá con otro.', 4500); return; }
  if (!isFinite(vid.duration)) {   // bug conocido de Chrome con blobs de MediaRecorder
    vid.currentTime = 1e6;
    await new Promise((r) => { vid.ontimeupdate = () => { vid.ontimeupdate = null; r(); }; });
    vid.currentTime = 0;
  }
  S.clipDur = Math.min(vid.duration || 0, MAX_CLIP);
  if (!S.clipDur) { say('El video parece vacío.'); return; }
  await seek(0);
  $('camInfo').textContent = `Video listo: ${S.clipDur.toFixed(1)} s.`;
  say('¡Video cargado! Pasamos a la redacción.', 2500);
  setTimeout(() => S.ch === 1 && !S.guide && setChannel(2), 900);
}

/* ---------------- Canal 2: Redacción ---------------- */
function refreshDesk() {
  const has = S.clipDur > 0, form = !!S.story;
  $('deskEmpty').hidden = has; $('deskGen').hidden = !has || form; $('deskForm').hidden = !form;
  $('btnGen').disabled = !$('consent').checked;
}
$('consent').onchange = () => { $('btnGen').disabled = !$('consent').checked; };

async function grabFrames(n = 5) {
  const out = [], c = document.createElement('canvas'), cx = c.getContext('2d');
  const w = 512, h = Math.round(w * (vid.videoHeight / vid.videoWidth)) || 384;
  c.width = w; c.height = h;
  for (let i = 0; i < n; i++) {
    await seek(Math.min(S.clipDur * (0.08 + (0.84 * i) / (n - 1)), vid.duration - 0.05));
    cx.drawImage(vid, 0, 0, w, h); out.push(c.toDataURL('image/jpeg', 0.7));
  }
  await seek(0); return out;
}

// Sin backend (p. ej. una versión estática) se usan guiones de ejemplo.
const LOCAL_DEMOS = [
  { etiqueta: 'ÚLTIMO MOMENTO', titular: 'ALARMA EN EL BARRIO: NADIE ENTIENDE QUÉ PASÓ', bajada: 'Vecinos conmocionados. Las imágenes ya dieron la vuelta a la manzana.', movil: 'Desde Villa Crespo, en vivo', conductor: 'Atención, atención. Las cámaras de Pampa 7 captaron imágenes impactantes que nos dejan sin palabras. Los vecinos dicen que jamás vieron algo así. Mirá vos.', ticker: ['Dólar blue sube dos pesos y nadie se sorprende', 'Gran expectativa por el fin de semana largo', 'Perro adopta rutina y la sostiene con firmeza'] },
  { etiqueta: 'NOTICIA EXCLUSIVA', titular: 'HALLAZGO HISTÓRICO CAPTADO POR NUESTRO MÓVIL', bajada: 'Especialistas analizan el material. Nadie se pone de acuerdo.', movil: 'Desde un living de Caballito', conductor: 'Y ahora, una exclusiva de este canal. Nuestro móvil llegó antes que nadie al lugar de los hechos. Los especialistas piden calma, pero la gente no la tiene.', ticker: ['Colectivo 60 llega a horario: investigan', 'Se agotó el dulce de leche en tres barrios', 'Termómetro se mantiene indeciso'] },
  { etiqueta: 'ÚLTIMA HORA', titular: 'CONMOCIÓN: SE REPITE LA ESCENA QUE PARALIZÓ A TODOS', bajada: 'Testigos aseguran que fue "algo nunca visto, o casi".', movil: 'Desde el patio de una casa', conductor: 'Buenas noches, Argentina. Tenemos imágenes que ya son historia. Nuestro equipo no se despegó ni un minuto del lugar. Seguimos informando, porque la gente quiere saber.', ticker: ['Se acaba el verano, confirman fuentes cercanas al calendario', 'Vecino jura que lo vio primero', 'Mate se enfría: evalúan medidas'] },
];
async function getScript(frames) {
  try {
    const r = await fetch('/api/script', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ frames, consent: true }) });
    return { ok: r.ok, d: await r.json() };
  } catch {
    $('hint').textContent = 'Modo demo: sin servidor de IA, el guion es de ejemplo.';
    return { ok: true, d: LOCAL_DEMOS[Math.floor(Math.random() * LOCAL_DEMOS.length)] };
  }
}
async function generate() {
  $('btnGen').disabled = true; $('btnRegen').disabled = true; ensureAudio();
  say('Nuestros móviles están analizando las imágenes…', 8000);
  try {
    const { ok, d } = await getScript(await grabFrames());
    if (!ok) { say(d.error + (d.motivo ? ` (${d.motivo})` : ''), 5000); refreshDesk(); $('btnRegen').disabled = false; return; }
    $('fEtiqueta').value = d.etiqueta; $('fMovil').value = d.movil; $('fTitular').value = d.titular;
    $('fBajada').value = d.bajada; $('fConductor').value = d.conductor;
    S.story = { ticker: d.ticker };
    if (S.config.demo === false && S.config.tts === false) $('hint').textContent = 'Sin voz TTS en el servidor: la voz se oye pero no queda en el archivo.';
    say('¡Noticia lista! Ajustá lo que quieras y salí al aire.', 3500);
  } catch (e) { say('Se cortó la transmisión. Probá de nuevo.'); console.error(e); }
  $('btnRegen').disabled = false; refreshDesk(); if (S.ch === 2 && !S.guide) focusFirst('deskForm');
}
$('btnGen').onclick = generate; $('btnRegen').onclick = generate;
$('btnToAir').onclick = () => { S.userNext = true; setChannel(3); };

const story = () => ({
  etiqueta: $('fEtiqueta').value.toUpperCase(), movil: $('fMovil').value, titular: $('fTitular').value.toUpperCase(),
  bajada: $('fBajada').value, conductor: $('fConductor').value,
  ticker: (S.story?.ticker?.length ? S.story.ticker : ['Pampa 7 Noticias, informando desde siempre']).join('   ◆   '),
});

/* ---------------- Canal 3: al aire / grabación ---------------- */
// seg: {mine:true} = la noticia del usuario (usa su video); si no, un segmento de la programación (b-roll con emojis).
function onAir(rec, seg = { mine: true }) {
  if (S.airPromise) return S.airPromise;
  S.airPromise = runAir(rec, seg).finally(() => { S.airPromise = null; });
  return S.airPromise;
}
async function runAir(rec, seg) {
  ensureAudio();
  const mine = !!seg.mine;
  const st = mine ? story() : { ...seg, ticker: seg.ticker.join('   ◆   ') };
  const a = { cancel: false, start: Infinity, intro: 0, total: 0, st, mine, seg, clipDur: mine ? S.clipDur : 4, clipStarted: false, done: null };
  S.air = a; S.mode = 'air'; if (rec) S.busy = true;
  let buf = null;
  if (mine) { await prepareVoice(st.conductor); buf = S.ttsBuf; }
  if (!a.cancel) {
    const words = st.conductor.split(/\s+/).length;
    a.intro = buf ? Math.max(4.5, buf.duration + 1) : Math.min(9, Math.max(4.5, words * 0.33 + 1.5));
    a.total = a.intro + a.clipDur + (mine ? 1.6 : 0.6);
    let recorder = null; const chunks = []; let mime = '';
    if (rec) {
      mime = pickMime();
      const stream = cv.captureStream(30);
      S.dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
      recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 4e6 });
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.start(250);
    }
    const t0 = S.ac.currentTime + 0.1; sting(t0);
    let src = null;
    if (buf) { src = S.ac.createBufferSource(); src.buffer = buf; src.connect(S.mix); src.start(t0 + 0.8); }
    else if (!rec) speakFallback(st.conductor);
    a.start = performance.now() + 100;
    if (rec) say('Grabando la emisión…', 2000);
    await new Promise((res) => { a.done = res; if (a.cancel) res(); });
    vid.pause(); src && src.stop(); window.speechSynthesis && speechSynthesis.cancel();
    if (recorder) {
      await new Promise((res) => { recorder.onstop = res; recorder.stop(); });
      if (!a.cancel) {
        const type = recorder.mimeType || mime || 'video/webm', ext = type.includes('mp4') ? 'mp4' : 'webm';
        const el = document.createElement('a');
        el.href = URL.createObjectURL(new Blob(chunks, { type })); el.download = `pampa7-noticia.${ext}`;
        document.body.appendChild(el); el.click(); el.remove();
        say(`Descargado como .${ext}. ¡Subilo a tus redes!`, 4500);
      }
    }
  }
  S.air = null; S.busy = false; S.mode = 'idle';
  if (mine && vid.src && S.clipDur) await seek(0);
}
async function stopAir() { if (S.air) S.air.cancel = true; if (S.airPromise) await S.airPromise; }

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function nextSeg() {
  if (ready() && (S.userNext || S.sinceMine >= 4)) { S.userNext = false; S.sinceMine = 0; return { mine: true }; }   // tu noticia sale primero y vuelve cada tanto
  S.sinceMine++;
  if (!S.order.length) S.order = shuffle(SEGMENTS.map((_, i) => i));
  return SEGMENTS[S.order.pop()];
}
// Programación continua: segmento tras segmento con zapping (estática) en el medio.
async function startLoop() {
  const id = ++S.loopId;
  await stopAir();
  while (id === S.loopId && S.on && S.ch === 3) {
    const seg = nextSeg();
    S.staticUntil = performance.now() + 350;
    await onAir(false, seg);
    if (id !== S.loopId) break;
  }
}
$('btnAgain').onclick = () => { S.userNext = true; if (S.air) S.air.cancel = true; };   // salta al siguiente y pone la tuya primero
$('btnDl').onclick = async () => {
  if (!ready() || S.busy) return;
  ++S.loopId; await stopAir(); S.staticUntil = 0;
  await onAir(true, { mine: true });
  if (S.ch === 3 && S.on) startLoop();
};

/* ---------------- Canal 4: Estudio ---------------- */
$('optFilter').onchange = (e) => { S.filter = e.target.checked; };
$('btnFull').onclick = fullscreen;

/* ---------------- Dibujo ---------------- */
const scan = document.createElement('canvas'); scan.width = 4; scan.height = 3;
{ const c = scan.getContext('2d'); c.fillStyle = 'rgba(0,0,0,.22)'; c.fillRect(0, 0, 4, 1); }
const scanPat = g.createPattern(scan, 'repeat');
const snow = document.createElement('canvas'); snow.width = 160; snow.height = 120;
const sx = snow.getContext('2d'), sd = sx.createImageData(160, 120);

function cover(src, sw, sh) { const s = Math.max(W / sw, H / sh), dw = sw * s, dh = sh * s; g.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh); }
function wrap(text, maxW, font) {
  g.font = font; const out = []; let line = '';
  for (const w of text.split(' ')) { const t = line ? line + ' ' + w : w; if (g.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t; }
  if (line) out.push(line); return out;
}
function fitText(text, x, y, maxW, size, weight = '800') {
  let s = size; g.font = `${weight} ${s}px Impact, "Arial Narrow", Arial, sans-serif`;
  while (g.measureText(text).width > maxW && s > 12) { s -= 1; g.font = `${weight} ${s}px Impact, "Arial Narrow", Arial, sans-serif`; }
  g.fillText(text, x, y);
}
function logo(x, y, scale = 1) {
  g.save(); g.translate(x, y); g.scale(scale, scale);
  g.fillStyle = '#1b4fd8'; g.fillRect(0, 0, 44, 30); g.fillStyle = '#e0202b'; g.fillRect(0, 26, 44, 4);
  g.fillStyle = '#fff'; g.font = '900 22px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('P7', 22, 14); g.restore();
}
function drawBars(t, msg) {
  const cols = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
  cols.forEach((c, i) => { g.fillStyle = c; g.fillRect((W / 7) * i, 0, W / 7 + 1, H * 0.7); });
  g.fillStyle = '#101010'; g.fillRect(0, H * 0.7, W, H * 0.3);
  logo(W / 2 - 22, H * 0.74);
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.font = '700 20px Arial'; g.fillText('PAMPA 7 NOTICIAS', W / 2, H * 0.9);
  if (msg && Math.floor(t * 1.5) % 2 === 0) { g.font = '700 14px Arial'; g.fillStyle = '#aaa'; g.fillText(msg, W / 2, H * 0.95); }
  g.textAlign = 'left';
}
function drawStudio(t, st, a) {
  const gr = g.createLinearGradient(0, 0, W, H); gr.addColorStop(0, '#071a55'); gr.addColorStop(1, '#1b4fd8');
  g.fillStyle = gr; g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(255,255,255,.08)'; g.lineWidth = 1;
  for (let i = 0; i < 6; i++) { g.beginPath(); g.arc(520, 120, 40 + i * 38, 0, 7); g.stroke(); }
  for (let y = 40; y < H; y += 34) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
  const talk = a && t < a.intro - 0.5 ? Math.sin(t * 14) * 2.5 : 0;
  g.fillStyle = '#12172b';
  g.beginPath(); g.ellipse(480, 400, 130, 120, 0, Math.PI, 0); g.fill();
  g.fillRect(468, 262, 24, 30);
  g.beginPath(); g.ellipse(480, 228 + talk * 0.3, 40, 48, 0, 0, 7); g.fill();
  g.fillStyle = '#fff'; g.beginPath(); g.moveTo(462, 300); g.lineTo(480, 345); g.lineTo(498, 300); g.fill();
  g.fillStyle = '#e0202b'; g.beginPath(); g.moveTo(476, 312); g.lineTo(484, 312); g.lineTo(486, 345); g.lineTo(480, 352); g.lineTo(474, 345); g.fill();
  g.fillStyle = '#05080f'; g.fillRect(466, 240 + talk, 28, Math.abs(talk) + 3);
  const dg = g.createLinearGradient(0, 360, 0, H); dg.addColorStop(0, '#5a3a20'); dg.addColorStop(1, '#2a180a');
  g.fillStyle = dg; g.fillRect(0, 372, W, H - 372); g.fillStyle = '#c9a36a'; g.fillRect(0, 372, W, 4);
  logo(24, 24, 1.2);
  g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.font = '800 22px Impact, Arial'; g.fillText('PAMPA 7 NOTICIAS', 86, 42); g.textBaseline = 'alphabetic';
  g.fillStyle = '#e0202b'; g.fillRect(24, 82, 150, 24); g.fillStyle = '#fff'; g.font = '800 14px Arial'; g.fillText('● EN VIVO', 34, 99);
  if (a) {
    const full = st.conductor, shown = full.slice(0, Math.max(0, Math.floor(((t - 0.8) / Math.max(1, a.intro - 1.8)) * full.length)));
    g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(24, 124, 330, 192); g.fillStyle = '#fff';
    wrap(shown, 300, '600 17px Arial').slice(0, 8).forEach((l, i) => g.fillText(l, 40, 152 + i * 22));
  }
}
function drawOverlay(t, st) {
  g.fillStyle = '#e0202b'; g.fillRect(20, 20, 84, 24); g.fillStyle = '#fff'; g.font = '800 14px Arial'; g.fillText('● EN VIVO', 28, 37);
  if (st.movil) { g.fillStyle = 'rgba(0,0,0,.65)'; g.font = '600 13px Arial'; const w = g.measureText(st.movil).width + 16; g.fillRect(20, 44, w, 22); g.fillStyle = '#fff'; g.fillText(st.movil, 28, 60); }
  logo(W - 64, 20);
  drawLower(t, st);
}
// Banner inferior de la noticia: etiqueta, titular, bajada y ticker con reloj. Entra deslizando.
function drawLower(t, st) {
  const k = Math.min(1, t / 0.5), dx = -(W * (1 - k * (2 - k)));   // ease-out
  g.save(); g.translate(dx, 0);
  g.font = '800 14px Arial'; const tw = g.measureText(st.etiqueta).width + 24;
  g.fillStyle = '#e0202b'; g.fillRect(24, H - 150, tw, 24); g.fillStyle = '#fff'; g.fillText(st.etiqueta, 36, H - 133);
  g.fillStyle = 'rgba(14,32,110,.96)'; g.fillRect(24, H - 126, W - 48, 46); g.fillStyle = '#e0202b'; g.fillRect(24, H - 126, 8, 46);
  g.fillStyle = '#fff'; fitText(st.titular, 44, H - 93, W - 80, 28);
  g.fillStyle = '#f2f2f2'; g.fillRect(24, H - 80, W - 48, 22); g.fillStyle = '#111'; fitText(st.bajada, 36, H - 64, W - 72, 14, '600');
  g.fillStyle = '#0a0a0a'; g.fillRect(24, H - 56, W - 48, 24);
  g.save(); g.beginPath(); g.rect(84, H - 56, W - 108, 24); g.clip();
  g.fillStyle = '#ffd400'; g.font = '700 14px Arial';
  const tx = g.measureText(st.ticker).width, off = (t * 70) % (tx + W); g.fillText(st.ticker, W - off, H - 39); g.restore();
  g.fillStyle = '#1b4fd8'; g.fillRect(24, H - 56, 60, 24);
  const d = new Date(); g.fillStyle = '#fff'; g.font = '800 14px Arial';
  g.fillText(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, 36, H - 39);
  g.restore();
}
function filter(t) {
  const v = g.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.85);
  v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.45)'); g.fillStyle = v; g.fillRect(0, 0, W, H);
  g.fillStyle = scanPat; g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(255,255,255,.07)'; for (let i = 0; i < 40; i++) g.fillRect(Math.random() * W, Math.random() * H, 2, 1);
  g.fillStyle = `rgba(255,255,255,${0.015 + Math.random() * 0.02})`; g.fillRect(0, 0, W, H);
  const y = (t * 90) % (H + 60) - 30; g.fillStyle = 'rgba(255,255,255,.04)'; g.fillRect(0, y, W, 24);
}
function drawBroll(t, seg) {   // fondo animado con emojis para segmentos sin video
  const [c1, c2] = seg.bg || ['#0b3d91', '#e0202b'];
  const gr = g.createLinearGradient(0, 0, W, H); gr.addColorStop(0, c1); gr.addColorStop(1, c2); g.fillStyle = gr; g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(255,255,255,.07)';
  for (let i = -2; i < 12; i++) { g.save(); g.translate(i * 70 + ((t * 30) % 70), 0); g.rotate(0.35); g.fillRect(0, -100, 28, H + 300); g.restore(); }
  const n = seg.emoji.length;
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#fff';
  seg.emoji.forEach((e, i) => {
    const x = W * (n === 1 ? 0.5 : 0.25 + (0.5 * i) / (n - 1)), y = H * 0.4 + Math.sin(t * 3 + i * 1.7) * 16, sc = 1 + Math.sin(t * 2 + i) * 0.06;
    g.save(); g.translate(x, y); g.rotate(Math.sin(t * 2 + i * 2) * 0.12); g.scale(sc, sc);
    g.font = '120px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif'; g.fillText(e, 0, 0); g.restore();
  });
  g.textAlign = 'left'; g.textBaseline = 'alphabetic';
}
function drawSnow() {
  for (let i = 0; i < sd.data.length; i += 4) { const v = Math.random() * 255; sd.data[i] = sd.data[i + 1] = sd.data[i + 2] = v; sd.data[i + 3] = 255; }
  sx.putImageData(sd, 0, 0); g.imageSmoothingEnabled = false; g.drawImage(snow, 0, 0, W, H); g.imageSmoothingEnabled = true;
}
function drawIdle(t) {
  if (S.ch === 1) {
    if (S.clipDur && vid.readyState >= 2 && vid.videoWidth) { cover(vid, vid.videoWidth, vid.videoHeight); g.fillStyle = 'rgba(0,0,40,.45)'; g.fillRect(0, 0, W, H); logo(W - 64, 20); }
    else drawBars(t, '');
  } else if (S.ch === 3) {
    if (ready()) { drawStudio(t, { conductor: '' }, null); g.fillStyle = 'rgba(0,0,0,.4)'; g.fillRect(0, 0, W, H); }
    else drawBars(t, 'SIN SEÑAL · CREÁ TU NOTICIA EN LOS CANALES 1 Y 2');
  } else drawStudio(t, { conductor: '' }, null);
}
function drawPower() {   // tubo: colapso a una línea y a un punto / expansión
  const p = S.pwr, el = (performance.now() - p.at) / 1000;
  if (p.type === 'off') {
    if (el > 0.9) return true;
    const k = Math.min(1, el / 0.25), k2 = Math.max(0, Math.min(1, (el - 0.25) / 0.2));
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    if (el < 0.45) { const hh = Math.max(2, H * (1 - k)), ww = W * (1 - k2 * 0.98); g.fillStyle = '#fff'; g.fillRect((W - ww) / 2, (H - hh) / 2, ww, hh); }
    else { g.fillStyle = `rgba(255,255,255,${Math.max(0, 1 - (el - 0.45) / 0.45)})`; g.beginPath(); g.arc(W / 2, H / 2, 3, 0, 7); g.fill(); }
    return true;
  }
  if (el < 0.45) { const k = el / 0.45, hh = Math.max(2, H * k * k), ww = W * Math.min(1, k * 1.6); g.fillStyle = '#000'; g.fillRect(0, 0, W, H); g.fillStyle = '#fff'; g.fillRect((W - ww) / 2, (H - hh) / 2, ww, hh); return true; }
  return false;
}

function frame(now) {
  const t = now / 1000;
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H); g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  let handled = false;
  if (S.pwr && drawPower()) handled = true;
  else if (!S.on) handled = true;   // pantalla apagada: negro
  if (!handled) {
    if (performance.now() < S.staticUntil) drawSnow();
    else if (S.mode === 'live' && live.videoWidth) {
      g.save(); g.translate(W, 0); g.scale(-1, 1); cover(live, live.videoWidth, live.videoHeight); g.restore();
      const left = Math.max(0, 10 - (performance.now() - S.recStart) / 1000);
      g.fillStyle = '#e0202b'; g.beginPath(); g.arc(34, 34, 8, 0, 7); g.fill(); g.fillStyle = '#fff'; g.font = '800 18px Arial'; g.fillText(`REC  ${left.toFixed(0)}s`, 50, 40);
    } else if (S.mode === 'air' && S.air) {
      const a = S.air, el = (performance.now() - a.start) / 1000;
      if (a.cancel) { a.done && a.done(); a.done = null; }
      else if (el < 0) drawBars(t, '');
      else if (el < a.intro) { drawStudio(el, a.st, a); drawLower(el, a.st); }
      else if (el < a.intro + a.clipDur + 0.05 && !(a.mine && vid.ended)) {
        if (a.mine) {
          if (!a.clipStarted) { a.clipStarted = true; vid.currentTime = 0; vid.play().catch(() => {}); }
          if (vid.videoWidth) cover(vid, vid.videoWidth, vid.videoHeight);
        } else drawBroll(el - a.intro, a.seg);
        drawOverlay(el - a.intro, a.st);
      } else if (el < a.total) {
        drawStudio(el, a.st, null);
        g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, 190, W, 90); g.fillStyle = '#fff'; g.textAlign = 'center';
        g.font = '800 30px Impact, Arial'; g.fillText('VOLVEMOS ENSEGUIDA', W / 2, 245);
        g.font = '600 14px Arial'; g.fillText('Pampa 7 Noticias · Informando desde siempre', W / 2, 268); g.textAlign = 'left';
      } else { a.done && a.done(); a.done = null; }
    } else drawIdle(t);
    if (S.filter) filter(t);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Arranca encendido y ya en el aire (canal 3). El sonido empieza con el primer toque.
S.pwr = { type: 'on', at: performance.now() };
S.staticUntil = performance.now() + 500;
renderPages();
setTimeout(badge, 500);
setTimeout(() => say('Tocá cualquier botón para activar el sonido.', 4500), 1200);
startLoop();
for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, ensureAudioSoft, { once: true });
