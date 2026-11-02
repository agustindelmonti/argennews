// Pampa 7 Noticias — un televisor. Cada canal es una función de la app:
//   1 Cámara · 2 Redacción · 3 Pampa 7 (tu noticia al aire) · 4 Estudio (ajustes)
// El noticiero se dibuja en un <canvas>; la vista previa y la descarga usan el mismo pipeline.
import { SEGMENTS, CLIMA } from './seed.js';
import { startClip } from './clip.js';
const W = 640, H = 480;
const MAX_CLIP = 12;
const NCH = 7;
const CH_NAMES = { 1: 'CÁMARA', 2: 'REDACCIÓN', 3: 'PAMPA 7', 4: 'ESTUDIO', 5: 'COMUNIDAD', 6: 'TWEETS', 7: 'SIN SEÑAL' };
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cv = $('screen'), g = cv.getContext('2d');
const CLIP = { current: null };   // gancho que llama el grabador (clip.js) después de dibujar cada cuadro
const vid = $('vid'), vid2 = $('vid2'), live = $('preview');

const S = {
  on: true, ch: 3, prevCh: 0, share: false, clip: null, wantHow: false, seenHow: false, deskBack: false, guide: false, filter: true, userNext: false, sinceMine: 0, sinceComm: 0, interleave: 3, recent: [], order: [],
  vol: 0.6, muted: false,
  mode: 'idle',                // idle | live | air
  config: { demo: true, tts: false },
  story: null, clipDur: 0,
  air: null, airPromise: null, loopId: 0, busy: false,
  ac: null, mix: null, mon: null, dest: null,
  ttsBuf: null, ttsText: '',
  stream: null, recorder: null, recChunks: [], recStart: 0,
  staticUntil: 0, pwr: null,   // animación de encendido/apagado del tubo
  remote: [], how: false,      // segmentos aprobados del servidor y panel "Cómo participar"
};
const X = { list: [], idx: 0, timer: 0, widgets: null };   // canal de tweets (embeds oficiales)
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
  S.ac = ac; S.mix = ac.createGain(); S.mon = ac.createGain(); S.fx = ac.createGain(); S.dest = ac.createMediaStreamDestination();
  S.fx.connect(ac.destination);   // efectos del televisor: suenan aunque esté apagado, respetan volumen y mute, no entran en la grabación
  S.mix.connect(S.dest); S.mix.connect(S.mon); S.mon.connect(ac.destination);
  ac.createMediaElementSource(vid).connect(S.mix);
  applyVolume();
}
// Curva de volumen: potencia 1,5 (la cuadrática dejaba el sonido casi inaudible desde la mitad hacia abajo).
const level = (v) => (v <= 0 ? 0 : Math.pow(v, 1.5));
function applyVolume() {
  const silent = !S.on || S.muted;
  if (S.mon) S.mon.gain.value = silent ? 0 : level(S.vol);
  if (S.fx) S.fx.gain.value = S.muted ? 0 : S.vol > 0 ? Math.max(level(S.vol), 0.06) : 0;   // los ruidos de los botones se siguen oyendo con volumen bajo, salvo en 0
  vid2.muted = silent; vid2.volume = S.vol;                                  // video de colaboración (no pasa por WebAudio)
  if (silent) stopSpeech(); else resumeSpeechSoon();                         // la voz del navegador no se puede bajar a mitad de frase: se corta y se retoma
}
function setVol(d) {
  S.vol = Math.min(1, Math.max(0, Math.round((S.vol + d) * 10) / 10)); if (S.muted && d > 0) S.muted = false;
  applyVolume(); volOsd();
  if (S.vol > 0 && !S.muted) blip(480 + S.vol * 900, 0.07);                  // pitido más agudo cuanto más volumen: se escucha el nivel
}
function toggleMute() { S.muted = !S.muted; applyVolume(); volOsd(); if (!S.muted) blip(880, 0.09); }
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.ac) S.ac.resume(); });

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
function noiseBuf(sec) { const b = S.ac.createBuffer(1, Math.floor(S.ac.sampleRate * sec), S.ac.sampleRate), d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; return b; }
// Sonido de televisor de tubo. Encendido: golpe grave de desmagnetización, chillido agudo que sube y estática.
// Apagado: barrido descendente, soplido, "pop" y un silbido que se apaga.
function crtSound(on) {
  const ac = S.ac; if (!ac || !S.fx) return; const t = ac.currentTime;
  const tone = (type, f0, f1, t0, dur, peak, attack = 0.01) => {
    const o = ac.createOscillator(), g2 = ac.createGain(); o.type = type;
    o.frequency.setValueAtTime(f0, t0); o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    g2.gain.setValueAtTime(0.0001, t0); g2.gain.exponentialRampToValueAtTime(peak, t0 + attack); g2.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g2); g2.connect(S.fx); o.start(t0); o.stop(t0 + dur + 0.05);
  };
  const hiss = (t0, dur, peak, hp) => {
    const n = ac.createBufferSource(), f = ac.createBiquadFilter(), g2 = ac.createGain(); n.buffer = noiseBuf(dur); f.type = 'highpass'; f.frequency.value = hp;
    g2.gain.setValueAtTime(peak, t0); g2.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    n.connect(f); f.connect(g2); g2.connect(S.fx); n.start(t0);
  };
  if (on) { tone('sine', 95, 42, t, 0.55, 0.55, 0.008); tone('sine', 1800, 4300, t + 0.05, 0.6, 0.05, 0.2); hiss(t, 0.5, 0.12, 1500); tone('sine', 3900, 3900, t + 0.5, 0.35, 0.02, 0.05); }
  else { tone('sawtooth', 1500, 60, t, 0.32, 0.12, 0.01); hiss(t, 0.14, 0.09, 3000); tone('sine', 75, 28, t + 0.3, 0.16, 0.4, 0.005); tone('sine', 3800, 3800, t, 0.55, 0.03, 0.02); }
}
function blip(freq = 880, len = 0.08) {   // beep del control remoto (solo parlantes, no entra en la grabación)
  if (!S.ac || !S.on) return;
  const o = S.ac.createOscillator(), gn = S.ac.createGain(), t = S.ac.currentTime;
  o.type = 'square'; o.frequency.value = freq; gn.gain.setValueAtTime(0.18, t); gn.gain.exponentialRampToValueAtTime(0.0001, t + len);
  o.connect(gn); gn.connect(S.fx); o.start(t); o.stop(t + len + 0.02);
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
// Voz del navegador (respaldo cuando una noticia no tiene audio pregrabado). Se dice frase por frase: así un cambio de
// volumen se nota en la frase siguiente sin repetir nada, y al des-silenciar se retoma desde el comienzo de la frase en curso.
function speakFrom(text, startSentence = 0) {
  if (!('speechSynthesis' in window) || S.muted || !S.on) return;
  const parts = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
  const sp = { text, parts, i: startSentence, done: startSentence >= parts.length, stopping: false, air: S.air };
  S.speech = sp; if (sp.done) return;
  const vs = ('speechSynthesis' in window && speechSynthesis.getVoices) ? speechSynthesis.getVoices() : [];
  const v = vs.find((x) => /es-AR/i.test(x.lang)) || vs.find((x) => /^es/i.test(x.lang));
  const next = () => {
    if (S.speech !== sp || sp.stopping || S.muted || !S.on) return;
    if (sp.i >= parts.length) { sp.done = true; return; }
    const u = new SpeechSynthesisUtterance(parts[sp.i].trim());
    if (v) u.voice = v;
    u.lang = v ? v.lang : 'es-AR'; u.rate = 1.12; u.pitch = 0.85; u.volume = S.vol;     // el volumen se lee en cada frase
    u.onend = () => { if (S.speech === sp && !sp.stopping) { sp.i++; next(); } };
    speechSynthesis.speak(u);
  };
  speechSynthesis.cancel(); next();
}
const speakFallback = (text) => speakFrom(text, 0);
function stopSpeech() { if (S.speech) S.speech.stopping = true; if (window.speechSynthesis) speechSynthesis.cancel(); }
function resumeSpeechSoon() { clearTimeout(S.speechT); S.speechT = setTimeout(resumeSpeech, 220); }
function resumeSpeech() {
  const sp = S.speech;   // solo si se había cortado (mute) y sigue al aire el mismo segmento; un cambio de volumen NO reinicia la voz
  if (!sp || sp.done || !sp.stopping || !S.on || S.muted || !S.air || S.air.cancel || S.air !== sp.air) return;
  speakFrom(sp.text, sp.i);
}

// Voces pregrabadas (public/audio/<id>.mp3 + manifest.json; ver scripts/generar-voces.mjs). Pasan por la mezcla: el volumen y el mute
// actúan en vivo, no se repite nada y la voz queda dentro de los clips que se graban. Sin audio, se usa la voz del navegador.
const VOICES = { ids: new Set(), bufs: new Map() };
const manifestReady = fetch('audio/manifest.json').then((r) => (r.ok ? r.json() : null)).then((m) => { if (m && Array.isArray(m.ids)) VOICES.ids = new Set(m.ids); }).catch(() => {});
async function segVoice(seg) {
  await manifestReady;   // la primera noticia al abrir la página arranca antes de que llegue la lista: hay que esperarla
  if (!seg || !seg.id || !S.ac || !VOICES.ids.has(seg.id)) return null;
  if (VOICES.bufs.has(seg.id)) return VOICES.bufs.get(seg.id);
  try {
    const r = await fetch(`audio/${seg.id}.mp3`); if (!r.ok) throw new Error('sin audio');
    const buf = await S.ac.decodeAudioData(await r.arrayBuffer()); VOICES.bufs.set(seg.id, buf); return buf;
  } catch { VOICES.ids.delete(seg.id); return null; }
}

/* ---------------- Encendido, canales, navegación ---------------- */
const PAGES = { 1: 'pCam', 2: 'pDesk', 4: 'pStudio', 6: 'pX' };
function renderPages() {
  const show = (id, v) => { $(id).hidden = !v; };
  ['pCam', 'pDesk', 'pStudio', 'pGuide', 'pAir', 'pX', 'pHow', 'pComBar', 'pShare'].forEach((id) => show(id, false));
  if (!S.on || S.guide || S.ch !== 6) stopX();
  if (!S.on) return;
  if (S.guide) { show('pGuide', true); focusFirst('pGuide'); return; }
  if (PAGES[S.ch]) { show(PAGES[S.ch], true); focusFirst(PAGES[S.ch]); }
  if (S.ch === 3) show('pAir', true);                // en el canal 3 siempre está: tiene el acceso a conectar la IA
  if (S.ch === 5) show('pAir', ready());             // en la comunidad aparece cuando hay una noticia tuya para descargar o compartir
  if (S.ch === 3 || S.ch === 5) {
    const r = ready();
    $('btnAgain').hidden = !r || S.ch !== 3; $('btnDl').hidden = !r; $('btnShare').hidden = !r; $('btnCta').hidden = S.ch !== 3;
    $('pAir').classList.toggle('low', S.ch === 5);
    if (S.share && r && !S.guide) { show('pShare', true); show('pAir', false); focusFirst('pShare'); }   // con el panel abierto, los botones de atrás se ocultan
  }
  if (S.ch === 1) $('btnNext').hidden = !(S.clipDur > 0);
  if (S.ch === 2) refreshDesk();
  if (S.ch === 5) { show('pComBar', true); if (S.how) { show('pHow', true); focusFirst('pHow'); } }
  if (S.ch === 6) enterX();
}
function focusFirst(id) {
  if (matchMedia('(pointer: coarse)').matches) return;   // en el celular no abrimos el teclado solos
  const el = $(id).querySelector('button:not([disabled]),input:not([hidden]):not([disabled]),label.osd-btn');
  if (el && el.focus) setTimeout(() => el.focus({ preventScroll: true }), 30);
}
function guardBusy() { if (S.busy) { say('Grabando la emisión… esperá un momento.'); return true; } return false; }

function setChannel(n, silent) {
  if (!S.on || guardBusy()) return;
  if (S.mode === 'live') { say('Detené la grabación antes de cambiar de canal.'); return; }
  n = ((n - 1 + NCH) % NCH) + 1;
  if (n !== S.ch) S.prevCh = S.ch;
  S.ch = n; S.guide = false; S.share = false; S.loopId++; S.order = []; S.how = n === 5 && (S.wantHow || !S.seenHow); if (n === 5) S.seenHow = true; S.wantHow = false;   // el panel de conectores se abre solo la primera vez
  if (S.air) S.air.cancel = true;
  if (!silent) { S.staticUntil = performance.now() + 380; blip(660, 0.12); }
  badge(); renderPages(); renderVote(); $('sheet').scrollTop = 0;
  if (n === 3) startLoop();
  if (n === 5) loadRemote().then(() => { if (S.ch !== 5 || S.guide) return; if (!pool().length) { S.how = true; renderPages(); } startLoop(); });
}
function toggleGuide() { if (!S.on || guardBusy()) return; S.guide = !S.guide; blip(990, 0.06); renderPages(); }

function power() {
  if (S.busy) { say('Grabando la emisión… esperá un momento.'); return; }
  if (S.mode === 'live') { say('Detené la grabación antes de apagar.'); return; }
  S.on = !S.on; S.loopId++;
  if (S.air) S.air.cancel = true;
  S.pwr = { type: S.on ? 'on' : 'off', at: performance.now() };
  ensureAudio(); crtSound(S.on);
  S.share = false;
  if (S.on) { S.guide = false; S.ch = 3; S.staticUntil = performance.now() + 500; setTimeout(badge, 450); startLoop(); }
  else { vid.pause(); window.speechSynthesis && speechSynthesis.cancel(); ['chbadge', 'volbar', 'msg'].forEach((i) => ($(i).hidden = true)); }
  applyVolume(); renderPages();
}

function fullscreen() {
  const fail = () => say('Tu navegador no permite pantalla completa acá.');
  try { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(fail); } catch { fail(); }
}

const ACT = { power, guide: toggleGuide, chup: () => setChannel(S.ch + 1), chdn: () => setChannel(S.ch - 1), volup: () => { if (S.on) setVol(0.1); }, voldn: () => { if (S.on) setVol(-0.1); }, mute: () => { if (S.on) toggleMute(); }, full: fullscreen };
function ensureAudioSoft() { try { ensureAudio(); } catch { /* sin audio */ } }
// Ruido en todos los botones: pulsador mecánico en el control remoto y «bip» en los botones de pantalla. data-sfx="own": ya hacen su propio sonido.
function uiClick(kind) {
  const ac = S.ac; if (!ac || !S.fx) return; const t = ac.currentTime, rb = kind === 'rb';
  const o = ac.createOscillator(), g2 = ac.createGain(); o.type = 'square';
  o.frequency.setValueAtTime(rb ? 190 : 1150, t); o.frequency.exponentialRampToValueAtTime(rb ? 70 : 760, t + 0.045);
  g2.gain.setValueAtTime(rb ? 0.45 : 0.14, t); g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  o.connect(g2); g2.connect(S.fx); o.start(t); o.stop(t + 0.07);
  if (rb) { const n = ac.createBufferSource(), f = ac.createBiquadFilter(), g3 = ac.createGain(); n.buffer = noiseBuf(0.02); f.type = 'bandpass'; f.frequency.value = 2200; g3.gain.setValueAtTime(0.3, t); g3.gain.exponentialRampToValueAtTime(0.0001, t + 0.02); n.connect(f); f.connect(g3); g3.connect(S.fx); n.start(t); }
}
const BTN = 'button, .osd-btn';
const btnOf = (e) => { const el = e.target && e.target.closest ? e.target.closest(BTN) : null; return el && !el.disabled && el.dataset.sfx !== 'own' ? el : null; };
addEventListener('pointerdown', (e) => { const el = btnOf(e); if (!el) return; ensureAudioSoft(); uiClick(el.closest('#remote') ? 'rb' : 'osd'); }, true);
addEventListener('click', (e) => { if (e.detail !== 0) return; const el = btnOf(e); if (el) { ensureAudioSoft(); uiClick(el.closest('#remote') ? 'rb' : 'osd'); } }, true);   // teclado: Enter o espacio sobre un botón
document.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => { ensureAudioSoft(); ACT[b.dataset.act](); }));
document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => setChannel(Number(b.dataset.goto))));

addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (/^(INPUT|TEXTAREA)$/.test(t.tagName) && t.type !== 'checkbox') return;
  const k = e.key.toLowerCase();
  const map = { p: 'power', g: 'guide', m: 'mute', f: 'full', '+': 'volup', '=': 'volup', '-': 'voldn', arrowright: 'volup', arrowleft: 'voldn', arrowup: 'chup', arrowdown: 'chdn' };
  if (k === 'escape' && S.guide) { toggleGuide(); return; }
  if (k === 'escape' && S.share) { S.share = false; renderPages(); return; }
  if ((k === 'escape' || k === 'backspace') && S.prevCh && S.on) { setChannel(S.prevCh); e.preventDefault(); return; }   // volver al canal anterior
  if (/^[1-7]$/.test(k)) { ensureAudioSoft(); setChannel(Number(k)); e.preventDefault(); return; }
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
  S.clipDur = 0; S.story = null; S.deskBack = false;
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
  $('camInfo').textContent = `Video listo: ${S.clipDur.toFixed(1)} s.`; $('btnNext').hidden = false;
  say('¡Video cargado! Pasamos a la redacción.', 2500);
  setTimeout(() => S.ch === 1 && !S.guide && setChannel(2), 900);
}

/* ---------------- Canal 2: Redacción ---------------- */
function refreshDesk() {
  const has = S.clipDur > 0, form = !!S.story && !S.deskBack;
  $('deskEmpty').hidden = has; $('deskGen').hidden = !has || form; $('deskForm').hidden = !form;
  $('btnContinue').hidden = !S.story;                    // hay una noticia ya escrita a la que volver
  $('btnGen').disabled = !$('consent').checked;
}
$('btnBackCam').onclick = () => setChannel(1);
$('btnBackGen').onclick = () => { S.deskBack = true; refreshDesk(); focusFirst('deskGen'); };
$('btnContinue').onclick = () => { S.deskBack = false; refreshDesk(); focusFirst('deskForm'); };
$('btnNext').onclick = () => setChannel(2);
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
    S.story = { ticker: d.ticker }; S.deskBack = false;
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
function loadVid2(url) {
  return new Promise((res) => {
    const done = (v) => { clearTimeout(t); vid2.onloadedmetadata = vid2.onerror = null; res(v); };
    const t = setTimeout(() => done(false), 6000);
    vid2.onloadedmetadata = () => done(true); vid2.onerror = () => done(false);
    vid2.preload = 'auto'; vid2.src = url;
  });
}
function onAir(rec, seg = { mine: true }) {
  if (S.airPromise) return S.airPromise;
  S.airPromise = runAir(rec, seg).finally(() => { S.airPromise = null; });
  return S.airPromise;
}
async function runAir(rec, seg) {
  ensureAudio();
  const mine = !!seg.mine;
  const st = mine ? story() : { ...seg, movil: seg.credito || seg.movil, ticker: (seg.ticker?.length ? seg.ticker : ['Pampa 7 Noticias, informando desde siempre']).join('   ◆   ') };
  const a = { cancel: false, start: Infinity, intro: 0, total: 0, st, mine, seg, clipDur: mine ? S.clipDur : seg.kind === 'clima' ? 8 : 4, v2: false, clipStarted: false, done: null, key: mine ? clipKey() : null, recording: false };
  S.air = a; S.mode = 'air'; if (rec) S.busy = true; renderVote();
  // rec === true: descarga; rec === 'render': solo prepara el clip. Si no: tu noticia se graba sola mientras la mirás, así «Compartir» ya la tiene lista.
  const auto = !rec && mine && !clipFresh() && typeof MediaRecorder !== 'undefined', record = !!rec || auto;
  let buf = null;
  if (mine) { await prepareVoice(st.conductor); buf = S.ttsBuf; }
  else {
    if (seg.video && await loadVid2(seg.video)) { a.v2 = true; a.clipDur = Math.min(vid2.duration || 8, 20); }
    buf = await segVoice(seg);   // voz pregrabada si existe
  }
  if (!a.cancel) {
    const words = st.conductor.split(/\s+/).length;
    a.intro = buf ? Math.max(4.5, buf.duration + 1) : Math.min(9, Math.max(4.5, words * 0.33 + 1.5));
    a.total = a.intro + a.clipDur + (mine ? 1.6 : 0.6);
    let recorder = null;
    if (record) {
      try { recorder = await startClip({ screen: cv, ac: S.ac, mix: S.mix, dest: S.dest, onFrame: CLIP }); a.recording = true; }
      catch (e) { recorder = null; if (rec) throw e; }   // la grabación automática nunca rompe la emisión
    }
    const t0 = S.ac.currentTime + 0.1; sting(t0);
    let src = null;
    if (buf) { src = S.ac.createBufferSource(); src.buffer = buf; src.connect(S.mix); src.start(t0 + 0.8); }
    else if (!rec) speakFallback(st.conductor);   // la voz del navegador no se puede grabar: al grabar no se usa
    a.start = performance.now() + 100;
    if (rec) say(rec === 'render' ? 'Grabando tu clip…' : 'Grabando la emisión…', 2000);
    await new Promise((res) => { a.done = res; if (a.cancel) res(); });
    vid.pause(); vid2.pause(); src && src.stop(); window.speechSynthesis && speechSynthesis.cancel();
    if (recorder) {
      let clip = null;
      try { clip = await recorder.stop(a.cancel); } catch (e) { console.error('No se pudo cerrar el clip:', e); }
      if (!a.cancel && clip) {
        const c = { ...clip, key: a.key };
        if (mine) S.clip = c;
        if (rec === true || rec === 'dl') downloadClip(c, rec === 'dl');
        if (rec === 'dl') {
          const msg = { aac: 'con sonido', opus: 'con sonido (Opus)', mediarecorder: 'con sonido', silencio: 'SIN sonido: la mezcla de audio estaba muda. Subí el volumen y probá de nuevo', ninguno: 'SIN sonido: este navegador no pudo codificar el audio' }[c.audio] || '';
          say(`Descargado .${c.ext} ${msg}`.trim() + (/SIN/.test(msg) ? '' : '. ¡Subilo a tus redes!'), 6000);
          console.info('Clip:', { ext: c.ext, audio: c.audio, nivel: c.peak, ctx: S.ac && S.ac.state, vol: S.vol, mute: S.muted });
        }
        if (S.share) renderShareIfOpen();
      } else if (rec === 'dl' && !a.cancel) say('No se pudo armar el clip. Probá de nuevo.', 3500);
    }
  }
  S.air = null; S.busy = false; S.mode = 'idle'; renderVote();
  if (mine && vid.src && S.clipDur) await seek(0);
}
async function stopAir() { if (S.air) S.air.cancel = true; if (S.airPromise) await S.airPromise; }

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
// Canal 3: programación de relleno + todo lo aprobado. Canal 5: solo lo que mandó la comunidad (MCP y colaboraciones).
// Qué pasa con las noticias de la comunidad (las calcula el servidor según los votos, ver lib/ranking.js):
//   canal 5 (Comunidad): todas las que están a prueba o destacadas, con más aire a las nuevas (para juntar votos) y a las bien votadas.
//   canal 3: las originales de siempre, y cada N (por defecto 3) entra UNA destacada de la comunidad. Una noticia no llega al principal sin ganárselo.
//   Las que la gente no banca el servidor las retira y dejan de aparecer.
const origs = () => (location.hash === '#clima' ? CLIMA.slice() : SEGMENTS.concat(CLIMA));   // #clima = solo el canal del clima
const tierOfSeg = (x) => x.tier || 'featured';
const communityPool = () => S.remote.filter((x) => x.source !== 'trend');
const featuredPool = () => (location.hash === '#clima' ? [] : S.remote.filter((x) => tierOfSeg(x) === 'featured'));
const pool = () => (S.ch === 5 ? communityPool() : origs().concat(featuredPool()));
function pickWeighted(list) {   // sorteo ponderado por «peso», sin repetir las últimas 3
  if (!list.length) return null;
  const fresh = list.filter((x) => !S.recent.includes(x.id)), base = fresh.length ? fresh : list;
  let r = Math.random() * base.reduce((t, x) => t + (x.peso || 1), 0), pick = base[base.length - 1];
  for (const x of base) { r -= x.peso || 1; if (r <= 0) { pick = x; break; } }
  S.recent = [...S.recent, pick.id].slice(-3); return pick;
}
function nextSeg() {
  if (S.ch === 3 && ready() && (S.userNext || S.sinceMine >= 4)) { S.userNext = false; S.sinceMine = 0; return { mine: true }; }   // tu noticia sale primero y vuelve cada tanto
  if (S.ch === 5) return pickWeighted(communityPool());
  if (S.ch === 3) S.sinceMine++;
  const feats = featuredPool();
  if (S.ch === 3 && feats.length && S.sinceComm >= S.interleave) { S.sinceComm = 0; return pickWeighted(feats); }
  S.sinceComm++;
  if (!S.order.length) S.order = shuffle(origs());
  return S.order.pop() || null;
}
// Programación continua: segmento tras segmento con zapping (estática) en el medio.
async function startLoop() {
  const id = ++S.loopId;
  await stopAir();
  while (id === S.loopId && S.on && (S.ch === 3 || S.ch === 5)) {
    const seg = nextSeg();
    if (!seg) break;
    S.staticUntil = performance.now() + 350;
    await onAir(false, seg);
    if (id !== S.loopId) break;
  }
}
async function loadRemote() {
  try { const r = await fetch('/api/programacion'); if (!r.ok) return; const d = await r.json(); S.remote = d.segments || []; X.list = d.embeds || []; S.interleave = d.intercalado || 3; } catch { /* sin servidor: solo la programación de relleno */ }
}
$('btnAgain').onclick = () => { S.userNext = true; if (S.air) S.air.cancel = true; };   // salta al siguiente y pone la tuya primero
// Clip de tu noticia: se identifica por su contenido; si editás algo, deja de valer y se vuelve a grabar.
function clipKey() { return JSON.stringify([story(), S.clipDur, vid.currentSrc || vid.src]); }
function clipFresh() { return !!S.clip && S.clip.key === clipKey(); }
function downloadClip(c, quiet) {
  const el = document.createElement('a');
  el.href = URL.createObjectURL(c.blob); el.download = `pampa7-noticia.${c.ext}`;
  document.body.appendChild(el); el.click(); el.remove();
  if (!quiet) say(`Descargado como .${c.ext}. ¡Subilo a tus redes!`, 4500);
}
async function prepareClip() {   // devuelve true si hay un clip vigente
  if (clipFresh()) return true;
  if (S.air && S.air.mine && S.air.recording) { await S.airPromise; if (clipFresh()) return true; }   // ya se está grabando mientras sale al aire
  ++S.loopId; await stopAir(); S.staticUntil = 0;
  await onAir('render', { mine: true });
  const ok = clipFresh();
  if (S.on && (S.ch === 3 || S.ch === 5)) startLoop();
  return ok;
}
$('btnDl').onclick = async () => {
  if (!ready() || S.busy) return;
  if (clipFresh()) { downloadClip(S.clip); return; }          // ya estaba grabado: descarga instantánea
  ++S.loopId; await stopAir(); S.staticUntil = 0;
  await onAir(true, { mine: true });
  if (S.on && (S.ch === 3 || S.ch === 5)) startLoop();
};

/* ---------------- Canal 5: cómo participar (instalar el MCP en cada asistente) ---------------- */
const mcpUrl = () => location.origin + '/mcp';
// Pasos verificados contra la documentación de cada producto; cambian seguido, por eso se avisa en pantalla.
// Íconos de las herramientas (Simple Icons, dominio público CC0; las marcas son de sus dueños y se usan solo para indicar compatibilidad). Ver THIRD_PARTY.md.
const TOOL_ICONS = {
  claude: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
  openai: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
  gemini: "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81",
  cursor: "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23",
  link: { stroke: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1' },   // genérico (propio)
};
function toolIcon(name) {
  const ic = TOOL_ICONS[name]; if (!ic) return null;
  const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg'), path = document.createElementNS(NS, 'path');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'ico');
  if (typeof ic === 'string') { svg.setAttribute('fill', 'currentColor'); path.setAttribute('d', ic); }
  else { svg.setAttribute('fill', 'none'); path.setAttribute('d', ic.stroke); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '2.2'); path.setAttribute('stroke-linecap', 'round'); }
  svg.appendChild(path); return svg;
}
const CLIENTS = [
  // Link de instalación documentado por Anthropic: abre «Agregar conector personalizado» con nombre y URL ya cargados; la persona solo confirma.
  { name: 'Claude', icon: 'claude', href: () => `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=${encodeURIComponent('Pampa 7 Noticias')}&connectorUrl=${encodeURIComponent(mcpUrl())}`, copy: mcpUrl,
    text: 'Se abre Claude con el nombre y el link ya cargados: revisalos y confirmá. Si no se abre, pegá el link en Personalizar → Conectores → «Agregar conector personalizado».' },
  { name: 'ChatGPT', icon: 'openai', href: 'https://chatgpt.com/', copy: mcpUrl,
    text: 'En ChatGPT: Ajustes → Conectores → Ajustes avanzados → activá el Modo desarrollador. Creá un conector nuevo, poné «Pampa 7» como nombre, pegá este link y elegí «Sin autenticación». Depende de tu plan.' },
  { name: 'Gemini CLI', icon: 'gemini', href: 'https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md', copy: () => `gemini mcp add --transport http pampa7 ${mcpUrl()}`,
    text: 'Pegá este comando en tu terminal, reiniciá Gemini CLI y revisá con /mcp. (La app web de Gemini: no confirmamos que acepte servidores propios.)' },
  { name: 'Cursor', icon: 'cursor', href: () => `cursor://anysphere.cursor-deeplink/mcp/install?name=pampa7&config=${encodeURIComponent(btoa(JSON.stringify({ url: mcpUrl() })))}`, copy: mcpUrl,
    text: 'Se abre Cursor y te pide confirmar la instalación. Si no pasa nada, agregá este link a mano en Ajustes → MCP.' },
  { name: 'Claude Code', icon: 'claude', copy: () => `claude mcp add --transport http pampa7 ${mcpUrl()}`,
    text: 'Pegá este comando en tu terminal y listo.' },
  { name: 'Otro', icon: 'link', copy: mcpUrl,
    text: 'Cualquier cliente MCP que admita servidores remotos por HTTP: agregá este link como servidor nuevo.' },
];
function renderHow() {
  $('mcpUrl').value = mcpUrl();
  $('howWarn').hidden = location.protocol === 'https:';
  const box = $('howBtns'); box.innerHTML = '';
  CLIENTS.forEach((c) => {
    const href = typeof c.href === 'function' ? c.href() : c.href;
    const el = document.createElement(href ? 'a' : 'button');
    el.className = 'osd-btn'; const ic = toolIcon(c.icon); if (ic) el.appendChild(ic); el.appendChild(document.createTextNode(c.name));
    if (href) { el.href = href; if (/^https?:/.test(href)) { el.target = '_blank'; el.rel = 'noopener noreferrer'; } }
    el.addEventListener('click', async () => {
      const snippet = c.copy(); let ok = false;
      try { await navigator.clipboard.writeText(snippet); ok = true; } catch { /* sin permiso de portapapeles */ }
      $('howText').textContent = (ok ? 'Copiado. ' : 'Copialo a mano. ') + c.text; $('howCode').textContent = snippet; $('howSteps').hidden = false;
      if (ok) say('Copiado al portapapeles.', 2000);
    });
    box.appendChild(el);
  });
}
renderHow();
$('btnCta').onclick = $('btnCtaStudio').onclick = () => { S.wantHow = true; setChannel(5); };   // atajo desde otros canales
$('btnHow').onclick = () => { S.how = !S.how; renderPages(); };
$('btnHowClose').onclick = () => { S.how = false; renderPages(); };
$('btnCopy').onclick = async () => { try { await navigator.clipboard.writeText($('mcpUrl').value); say('Link copiado.'); } catch { $('mcpUrl').select(); say('Copialo con Ctrl+C.'); } };

/* ---------------- Compartir tu noticia (X, Instagram, menú nativo) ---------------- */
// Los navegadores solo dejan abrir el menú de compartir o una ventana justo después de un toque: por eso el clip se graba antes
// (solo, la primera vez que tu noticia sale al aire) y acá el toque ya encuentra todo listo.
TOOL_ICONS.x = "M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z";
TOOL_ICONS.instagram = "M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077";
[['shX', 'x'], ['shIg', 'instagram']].forEach(([id, name]) => $(id).prepend(toolIcon(name)));
const SH_BTNS = ['shX', 'shIg', 'shCopy', 'shDl'];
const shareText = () => { const st = story(); return `${st.titular}\n${st.bajada}\nMi noticia en Pampa 7 Noticias (humor, ficción). Hacé la tuya:`; };
const shareFile = () => new File([S.clip.blob], `pampa7-noticia.${S.clip.ext}`, { type: S.clip.type });
const canNativeShare = () => { try { return !!(S.clip && navigator.canShare && navigator.canShare({ files: [shareFile()] })); } catch { return false; } };
const shareHelp = (t) => { $('shareHelp').textContent = t; };
function shareState(msg, ok) { $('shareState').textContent = msg; SH_BTNS.forEach((id) => ($(id).disabled = !ok)); $('shNative').hidden = !ok || !canNativeShare(); }
function renderShareIfOpen() {
  if (!S.share) return;
  shareState('Tu clip está listo. Elegí dónde compartirlo.', true);
  shareHelp(S.clip.ext === 'webm' ? 'Tu navegador grabó en WebM. Si X o Instagram no lo aceptan, probá desde Chrome de escritorio o desde el celular.' : '');
}
let shareTimer = 0;
async function openShare() {
  if (!ready() || S.busy) return;
  S.share = true; renderPages();
  if (clipFresh()) { renderShareIfOpen(); return; }
  shareState('Preparando tu clip…', false); shareHelp('Se graba la emisión en vivo: tarda lo que dura tu noticia.');
  clearInterval(shareTimer);
  shareTimer = setInterval(() => {   // cuenta regresiva mientras se graba
    const a = S.air; if (a && a.start !== Infinity && a.total) shareState(`Grabando tu clip… faltan ${Math.max(0, Math.ceil((a.start + a.total * 1000 - performance.now()) / 1000))} s`, false);
  }, 500);
  const ok = await prepareClip(); clearInterval(shareTimer);
  if (!S.share) return;
  if (ok) renderShareIfOpen(); else { shareState('No pude grabar el clip en este navegador.', false); shareHelp('Probá desde Chrome o Safari actualizados.'); }
}
async function copyText(t) { try { await navigator.clipboard.writeText(t); return true; } catch { return false; } }
$('btnShare').onclick = openShare;
$('shClose').onclick = () => { S.share = false; renderPages(); };
$('shNative').onclick = async () => {
  try { await navigator.share({ files: [shareFile()], text: `${shareText()} ${location.origin}`, title: 'Pampa 7 Noticias' }); }
  catch (e) { if (e.name !== 'AbortError') say('Tu navegador no pudo abrir el menú de compartir. Probá con Descargar.', 4000); }
};
$('shX').onclick = () => {
  downloadClip(S.clip, true);
  window.open(`https://x.com/intent/post?text=${encodeURIComponent(shareText())}&url=${encodeURIComponent(location.origin)}`, '_blank', 'noopener');
  shareHelp('Se descargó tu clip. X no permite subir un video desde un link: adjuntalo en el tuit.');
};
$('shIg').onclick = async () => {
  if (canNativeShare()) { $('shNative').click(); return; }   // en el celular, el menú del sistema incluye Instagram
  downloadClip(S.clip, true); const ok = await copyText(`${shareText()} ${location.origin}`);
  window.open('https://www.instagram.com/', '_blank', 'noopener');
  shareHelp(`Instagram no permite publicar desde un link. Descargamos tu clip${ok ? ' y copiamos el texto' : ''}: en Instagram tocá «+» → Reel y subí el archivo.`);
};
$('shCopy').onclick = async () => { const ok = await copyText(`${shareText()} ${location.origin}`); say(ok ? 'Texto copiado.' : 'No pude copiar: seleccionalo a mano.', 2200); };
$('shDl').onclick = () => downloadClip(S.clip);

/* ---------------- Canal 6: tweets elegidos (embeds oficiales de X) ---------------- */
function loadWidgets() {
  if (X.widgets) return X.widgets;
  X.widgets = new Promise((res) => {
    const sc = document.createElement('script'); sc.src = 'https://platform.twitter.com/widgets.js'; sc.async = true;
    sc.onload = () => res(window.twttr || null); sc.onerror = () => res(null); setTimeout(() => res(window.twttr || null), 8000);
    document.head.appendChild(sc);
  });
  return X.widgets;
}
function stopX() { clearInterval(X.timer); X.timer = 0; }
function fitX() {   // achica el tweet para que entre en la pantalla
  const box = $('xBox'), host = $('xHost'); host.style.transform = 'none';
  const k = Math.min(1, box.clientHeight / (host.scrollHeight || 1), box.clientWidth / (host.scrollWidth || 1));
  host.style.transform = `scale(${k})`;
}
async function showTweet() {
  const t = X.list[X.idx], host = $('xHost'); host.innerHTML = '';
  $('xLink').href = t.url; $('xCount').textContent = `${X.idx + 1}/${X.list.length}`;
  const tw = await loadWidgets();
  if (!tw || !tw.widgets) { $('xCap').textContent = 'No pude cargar X desde acá. Podés abrir el tweet con el botón.'; return; }
  try {
    const el = await tw.widgets.createTweet(t.id, host, { theme: 'dark', conversation: 'none', dnt: true, align: 'center' });
    $('xCap').textContent = el ? 'Contenido de X, de sus autores. Pampa 7 no está afiliado.' : 'Este tweet ya no está disponible.';
    setTimeout(fitX, 400); setTimeout(fitX, 1500);
  } catch { $('xCap').textContent = 'Este tweet no se pudo cargar.'; }
}
function stepX(d) { if (!X.list.length) return; X.idx = (X.idx + d + X.list.length) % X.list.length; showTweet(); clearInterval(X.timer); X.timer = setInterval(() => stepX(1), 25000); }
async function enterX() {
  stopX(); await loadRemote();
  if (S.ch !== 6 || S.guide || !S.on) return;
  const empty = !X.list.length;
  ['xPrev', 'xNext', 'xLink'].forEach((id) => ($(id).hidden = empty));
  if (empty) { $('xHost').innerHTML = ''; $('xCount').textContent = ''; $('xCap').textContent = 'Todavía no hay tweets elegidos. Se agregan desde el panel de administración.'; return; }
  X.idx = Math.min(X.idx, X.list.length - 1); showTweet(); X.timer = setInterval(() => stepX(1), 25000);
}
$('xPrev').onclick = () => stepX(-1); $('xNext').onclick = () => stepX(1);
addEventListener('resize', () => { if (S.ch === 6) fitX(); });

/* ---------------- Celular en vertical: la pantalla muestra solo la imagen y los menús van en un panel debajo ---------------- */
const mqPortrait = matchMedia('(max-aspect-ratio: 1/1)');
const PANELS = ['pCam', 'pDesk', 'pAir', 'pX', 'pComBar', 'pHow', 'pShare', 'pStudio', 'pGuide'];
function placePanels() {
  const target = mqPortrait.matches ? $('sheet') : $('osd');
  PANELS.forEach((id) => target.appendChild($(id)));
  document.body.classList.toggle('portrait', mqPortrait.matches);
  setTimeout(() => S.ch === 6 && fitX(), 60);
}
mqPortrait.addEventListener('change', placePanels);
placePanels();

/* ---------------- Canal 4: Estudio ---------------- */
$('optFilter').onchange = (e) => { S.filter = e.target.checked; };
$('btnFull').onclick = fullscreen;

/* ---------------- Gente en línea (latido anónimo: un id al azar por pestaña, sin cookies ni datos personales) ---------------- */
const PID = (() => {
  try { let v = sessionStorage.getItem('p7pid'); if (!v) { v = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20); sessionStorage.setItem('p7pid', v); } return v; }
  catch { return Math.random().toString(36).slice(2, 12) + Date.now().toString(36); }
})();
// Display de 7 segmentos (como el de una videocasetera): 3 dígitos, los apagados se ven como fantasma.
const SEG_POLY = {
  a: '2.2,0 7.8,0 8.8,1 7.8,2 2.2,2 1.2,1', g: '2.2,8 7.8,8 8.8,9 7.8,10 2.2,10 1.2,9', d: '2.2,16 7.8,16 8.8,17 7.8,18 2.2,18 1.2,17',
  f: '1,1.2 2,2.2 2,7.8 1,8.8 0,7.8 0,2.2', b: '9,1.2 10,2.2 10,7.8 9,8.8 8,7.8 8,2.2',
  e: '1,9.2 2,10.2 2,15.8 1,16.8 0,15.8 0,10.2', c: '9,9.2 10,10.2 10,15.8 9,16.8 8,15.8 8,10.2',
};
const SEG_ON = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg' };
function renderSeg(n) {
  const txt = String(Math.min(999, Math.max(0, n))).padStart(3, ' ');
  const NS = 'http://www.w3.org/2000/svg', svg = $('seg'); svg.textContent = '';
  [...txt].forEach((ch, i) => {
    const g2 = document.createElementNS(NS, 'g'); g2.setAttribute('transform', `translate(${i * 15} 0) skewX(-7)`);
    for (const k of 'abcdefg') {
      const poly = document.createElementNS(NS, 'polygon'); poly.setAttribute('points', SEG_POLY[k]);
      poly.setAttribute('class', ch !== ' ' && SEG_ON[ch].includes(k) ? 'on' : 'off'); g2.appendChild(poly);
    }
    svg.appendChild(g2);
  });
}
function showAudience(online) {
  const el = $('presence');
  if (!(Number.isInteger(online) && online > 0)) { el.hidden = true; return; }
  const changed = el.hidden || el.dataset.n !== String(online); el.hidden = false; el.dataset.n = online; renderSeg(online);
  const txt = `${online} ${online === 1 ? 'espectador' : 'espectadores'} ahora`; el.setAttribute('aria-label', txt); el.title = txt;
  if (changed) { el.classList.remove('tick'); void el.offsetWidth; el.classList.add('tick'); }   // parpadeo breve al cambiar el número
}
async function pingPresence() {
  if (document.hidden) return;
  if (location.hash === '#audiencia') { showAudience(12); return; }   // vista previa del diseño sin servidor
  try {
    const r = await fetch('/api/presence', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: PID }) });
    if (!r.ok) return;
    showAudience((await r.json()).online);
  } catch { /* sin servidor: no se muestra */ }
}
pingPresence(); setInterval(pingPresence, 45000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) pingPresence(); });

/* ---------------- Votos 👍 / 👎 sobre el clip que está al aire (anónimos, uno por clip y por navegador) ---------------- */
const VID = (() => {
  try { let v = localStorage.getItem('p7vid'); if (!v) { v = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20); localStorage.setItem('p7vid', v); } return v; }
  catch { return PID; }
})();
const MY_VOTES = (() => { try { return JSON.parse(localStorage.getItem('p7votes') || '{}'); } catch { return {}; } })();
const saveVotes = () => { try { localStorage.setItem('p7votes', JSON.stringify(MY_VOTES)); } catch { /* sin almacenamiento */ } };
const votableId = () => (S.on && S.mode === 'air' && S.air && !S.air.cancel && !S.air.mine && S.air.seg?.id ? S.air.seg.id : null);
function renderVote() {
  const id = votableId(), mine = id ? MY_VOTES[id] || 0 : 0;
  $('btnTV').disabled = !S.on || !!S.recTV || !!S.busy;
  [['btnUp', 1], ['btnDown', -1]].forEach(([b, v]) => { const el = $(b); el.disabled = !id; el.setAttribute('aria-pressed', String(mine === v)); el.classList.toggle('lit', mine === v); });
}
async function castVote(v) {
  const id = votableId(); if (!id) return;
  const next = (MY_VOTES[id] || 0) === v ? 0 : v;          // tocar de nuevo el mismo botón retira el voto
  if (next === 0) delete MY_VOTES[id]; else MY_VOTES[id] = next;
  saveVotes(); renderVote(); blip(next === 1 ? 990 : 330, 0.08);
  say(next === 0 ? 'Voto retirado.' : next === 1 ? '¡Gracias! Te gustó.' : 'Anotado: no te gustó.', 1400);
  try { await fetch('/api/vote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seg: id, voter: VID, v: next }) }); } catch { /* sin servidor: queda solo en tu navegador */ }
}
$('btnUp').onclick = () => castVote(1); $('btnDown').onclick = () => castVote(-1);

/* ---------------- Descargar lo que ves: la noticia al aire, con el marco del televisor y la voz, como MP4 ---------------- */
// Vuelve a emitir desde el principio y graba en el momento, sin diálogos (ver clip.js). La voz sale de audio/<id>.mp3 (scripts/generar-voces.mjs),
// que pasa por la mezcla y por eso queda en el clip. La voz del navegador (speechSynthesis) no se puede grabar: las noticias sin archivo de voz
// (las de la comunidad y la tuya) salen sin voz hablada, con el texto del conductor en pantalla.
async function downloadOnAir() {
  if (!S.on || S.busy || S.recTV) return;
  if (S.ch !== 3 && S.ch !== 5) { say('Sintonizá el canal 3 o 5 para descargar un clip.', 3000); return; }
  S.recTV = true; $('btnTV').classList.add('busy'); $('btnTV').disabled = true;
  const cur = S.air && !S.air.cancel ? S.air.seg : null;
  const myLoop = ++S.loopId; await stopAir(); S.staticUntil = performance.now() + 450;
  try {
    const seg = cur && (!cur.mine || ready()) ? cur : nextSeg();
    if (seg) { say('Armando el clip…', 2500); await onAir('dl', seg); }
  } catch (e) { console.error(e); say('Este navegador no pudo armar el clip.', 3500); }
  S.recTV = false; $('btnTV').classList.remove('busy'); renderVote();
  if (S.on && (S.ch === 3 || S.ch === 5) && S.loopId === myLoop) startLoop();
}
$('btnTV').onclick = () => { blip(660, 0.06); downloadOnAir(); };

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
  if (a && st.movil) { g.fillStyle = 'rgba(0,0,0,.65)'; g.font = '600 13px Arial'; g.fillRect(24, 108, g.measureText(st.movil).width + 16, 22); g.fillStyle = '#fff'; g.fillText(st.movil, 32, 124); }
  if (a) {
    const full = st.conductor, shown = full.slice(0, Math.max(0, Math.floor(((t - 0.8) / Math.max(1, a.intro - 1.8)) * full.length)));
    g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(24, 136, 330, 180); g.fillStyle = '#fff';
    wrap(shown, 300, '600 17px Arial').slice(0, 7).forEach((l, i) => g.fillText(l, 40, 164 + i * 22));
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
/* ---- Sketch del clima (estética Star4000) ---- */
// Los GIF viven en el DOM (dentro de #iconPool) para que sigan animados cuando se dibujan en el canvas.
const ICONS = {};
function icon(name) {
  if (!ICONS[name]) { const im = new Image(); im.src = `assets/weather/${name}.gif`; $('iconPool').appendChild(im); ICONS[name] = im; }
  return ICONS[name];
}
['current/sunny', 'current/cloud', 'current/rain', 'current/storm', 'moon/full'].forEach(icon);
if (document.fonts) { document.fonts.load('24px Star4000'); document.fonts.load('24px "Star4000 Large"'); }
const noAccent = (t) => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '');   // la fuente Star4000 no trae tildes ni ñ
function sTxt(text, x, y, color = '#f4f0d5', size = 18, align = 'left', large = false, maxW = 0) {
  text = noAccent(text); const fam = large ? '"Star4000 Large"' : 'Star4000';
  g.font = `${size}px ${fam}, Impact, Arial, sans-serif`;
  if (maxW) while (g.measureText(text).width > maxW && size > 9) { size -= 1; g.font = `${size}px ${fam}, Impact, Arial, sans-serif`; }
  g.textAlign = align; g.textBaseline = 'alphabetic';
  g.fillStyle = '#050510'; g.fillText(text, x + 2, y + 2); g.fillStyle = color; g.fillText(text, x, y);
}
function drawClima(t, seg) {
  // Misma paleta que el noticiero: azul marino y azul, rojo, amarillo y blanco. De Star4000 quedan la tipografía y los íconos.
  const NAVY = '#061050', BLUE = '#1b4fd8', RED = '#e0202b', YEL = '#ffd400', WHITE = '#ffffff', SOFT = '#cfd8ff';
  const c = seg.clima;
  g.fillStyle = NAVY; g.fillRect(0, 0, W, H);
  const hd = g.createLinearGradient(0, 0, W, 0); hd.addColorStop(0, '#0a1e5c'); hd.addColorStop(1, BLUE);
  g.fillStyle = hd; g.fillRect(16, 24, W - 32, 62); g.fillStyle = RED; g.fillRect(16, 82, W - 32, 4);
  logo(26, 34, 1.15); sTxt('EL CLIMA', 86, 62, WHITE, 20, 'left', true);                          // logo P7 del canal
  sTxt(seg.titular, 200, 56, YEL, 24, 'left', true, 300); sTxt(c.ciudad, 200, 76, SOFT, 13);
  const d = new Date(); sTxt(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, W - 30, 54, WHITE, 18, 'right');
  const pn = g.createLinearGradient(0, 94, W, 392); pn.addColorStop(0, '#071a55'); pn.addColorStop(1, BLUE);   // mismo degradé que el estudio
  g.fillStyle = pn; g.fillRect(30, 94, W - 60, 298);
  g.strokeStyle = 'rgba(255,255,255,.08)'; g.lineWidth = 1;
  for (let i = 0; i < 5; i++) { g.beginPath(); g.arc(W - 110, 150, 40 + i * 38, 0, 7); g.stroke(); }
  g.save(); g.beginPath(); g.rect(30, 94, W - 60, 298); g.clip();
  const step = Math.floor(t / 0.9);
  if (c.pagina === 'pronostico') {
    const im = icon(c.icono); if (im.complete && im.naturalWidth) g.drawImage(im, W - 150, 112, 96, 92);
    c.lineas.forEach((l, i) => {
      if (i > step) return;
      const y = 120 + i * 62; g.fillStyle = 'rgba(6,16,80,.78)'; g.fillRect(44, y - 24, W - 220, 50); g.fillStyle = RED; g.fillRect(44, y - 24, 6, 50);
      wrap(noAccent(l), W - 250, '17px Star4000').slice(0, 2).forEach((ln, j) => sTxt(ln, 62, y - 2 + j * 22, WHITE, 17));
    });
  } else {
    sTxt('AHORA', 130, 118, YEL, 15, 'center'); sTxt(c.temp, 130, 176, WHITE, 46, 'center', true);
    g.fillStyle = RED; g.fillRect(44, 190, 172, 30); sTxt(c.estado, 130, 212, WHITE, 15, 'center', false, 160);
    const im = icon(c.icono); if (im.complete && im.naturalWidth) g.drawImage(im, 82, 226, 96, 92);
    sTxt(c.sensacion, 130, 338, SOFT, 12, 'center', false, 190);
    c.pares.forEach(([k, v], i) => { if (i > step) return; const y = 130 + i * 34; sTxt(k, 244, y, WHITE, 17); sTxt(v, W - 46, y, YEL, 14, 'right', false, 240); });
    if (step >= c.pares.length) { g.fillStyle = 'rgba(224,32,43,.28)'; g.fillRect(44, 346, W - 88, 38); g.fillStyle = RED; g.fillRect(44, 346, 6, 38); wrap(noAccent(c.alerta), W - 120, '12px Star4000').slice(0, 2).forEach((ln, i) => sTxt(ln, 60, 362 + i * 15, YEL, 12)); }
  }
  g.restore();
  g.fillStyle = WHITE; g.fillRect(16, 398, W - 32, 2); g.fillStyle = '#0a0a0a'; g.fillRect(16, 400, W - 32, 44);    // barra de ticker como la del noticiero
  g.fillStyle = BLUE; g.fillRect(16, 400, 128, 44); sTxt(c.pagina === 'pronostico' ? 'LOCAL' : 'AHORA', 80, 430, WHITE, 20, 'center', true);
  g.save(); g.beginPath(); g.rect(150, 400, W - 180, 44); g.clip();
  const tk = noAccent(seg.ticker?.[0] || '').toUpperCase(); g.font = '16px Star4000, Arial, sans-serif'; const tw = g.measureText(tk).width;
  sTxt(tk, W - 30 - ((t * 70) % (tw + W)), 428, YEL, 16); g.restore();
  g.textAlign = 'left';
}
function drawSnow() {
  for (let i = 0; i < sd.data.length; i += 4) { const v = Math.random() * 255; sd.data[i] = sd.data[i + 1] = sd.data[i + 2] = v; sd.data[i + 3] = 255; }
  sx.putImageData(sd, 0, 0); g.imageSmoothingEnabled = false; g.drawImage(snow, 0, 0, W, H); g.imageSmoothingEnabled = true;
}
// Canal 7: cartel fijo «Dificultades técnicas», dibujado con la estética de la app (azules, rojo y amarillo del noticiero, tipografía Star4000).
// Es la pantalla para cuando algo falla (servidor, emisión). El camarógrafo se tambalea con el mate en la mano.
const TC = { NAVY: '#061050', BLUE: '#1b4fd8', RED: '#e0202b', YEL: '#ffd400', WHITE: '#ffffff', SKIN: '#f2bf90', SKIN2: '#d99a6c', INK: '#0b0f2a', PANTS: '#233a9e', SOFT: '#cfd8ff' };
function tcLimb(pts, w, col) {   // miembro con contorno de dibujito
  g.lineCap = 'round'; g.lineJoin = 'round';
  [[TC.INK, w + 6], [col, w]].forEach(([c, lw]) => { g.strokeStyle = c; g.lineWidth = lw; g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke(); });
}
function tcBlob(draw, fill, lw = 3.5) { g.beginPath(); draw(); g.fillStyle = fill; g.fill(); g.lineWidth = lw; g.strokeStyle = TC.INK; g.lineJoin = 'round'; g.stroke(); }
function tcStar(x, y, r, rot) { g.beginPath(); for (let k = 0; k < 8; k++) { const rr = k % 2 ? r * 0.42 : r, b = rot + k * Math.PI / 4; g.lineTo(x + Math.cos(b) * rr, y + Math.sin(b) * rr); } g.closePath(); g.fillStyle = TC.YEL; g.fill(); g.lineWidth = 1.5; g.strokeStyle = TC.INK; g.stroke(); }
function drawTechCamera(t) {
  const cx = 168, cy = 262, { INK, BLUE, RED, WHITE } = TC;
  g.lineCap = 'round';
  [[-50, 396], [52, 398], [4, 404]].forEach(([dx, y]) => { g.strokeStyle = INK; g.lineWidth = 9; g.beginPath(); g.moveTo(cx, cy + 50); g.lineTo(cx + dx, y); g.stroke(); g.strokeStyle = '#4a5a9a'; g.lineWidth = 4; g.stroke(); });
  g.strokeStyle = INK; g.lineWidth = 4; g.beginPath(); g.moveTo(cx - 30, 372); g.lineTo(cx + 32, 374); g.stroke();   // riostra
  tcBlob(() => g.rect(cx - 8, cy + 28, 16, 28), '#39467f');
  tcBlob(() => g.roundRect(cx - 54, cy - 48, 118, 80, 6), '#2a3a8f');                                         // cuerpo
  g.fillStyle = 'rgba(255,255,255,.16)'; g.fillRect(cx - 50, cy - 44, 110, 9);
  tcBlob(() => g.roundRect(cx - 34, cy - 70, 70, 22, 5), '#16203f');                                          // visor
  tcBlob(() => g.rect(cx - 90, cy - 30, 38, 46), '#16203f');                                                   // portaobjetivo
  tcBlob(() => g.arc(cx - 94, cy - 7, 24, 0, 7), '#0e1636');                                                  // lente
  tcBlob(() => g.arc(cx - 94, cy - 7, 14, 0, 7), '#2f5fc4', 2.5);
  g.fillStyle = 'rgba(255,255,255,.75)'; g.beginPath(); g.arc(cx - 99, cy - 13, 4, 0, 7); g.fill();
  tcBlob(() => g.ellipse(cx + 24, cy - 8, 24, 15, 0, 0, 7), WHITE);                                           // chapa P7
  g.fillStyle = BLUE; g.font = '900 17px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('P7', cx + 24, cy - 7);
  const on = Math.floor(t * 2) % 2 === 0;                                                                      // luz de grabación
  g.fillStyle = on ? RED : '#5a1020'; g.beginPath(); g.arc(cx - 40, cy - 34, 4.5, 0, 7); g.fill();
  if (on) { g.fillStyle = 'rgba(224,32,43,.28)'; g.beginPath(); g.arc(cx - 40, cy - 34, 10, 0, 7); g.fill(); }
  tcBlob(() => g.roundRect(cx + 46, cy - 30, 22, 8, 3), '#16203f', 2.5);                                      // manija
}
function drawTechCameraman(t) {
  const { INK, RED, WHITE, SKIN, SKIN2, PANTS, BLUE, YEL } = TC;
  const sw = Math.sin(t * 2.2), px = 408 + sw * 9;
  g.save(); g.translate(px, 394); g.rotate(sw * 0.06); g.scale(0.9, 0.9);
  g.textBaseline = 'middle';
  tcLimb([[-8, -118], [-38, -58 + sw * 4], [-64, -10]], 18, PANTS);                                            // piernas
  tcLimb([[8, -118], [26, -60], [24, -8]], 18, PANTS);
  tcBlob(() => g.ellipse(-70, -3, 19, 9, 0.1, 0, 7), '#f4f0d5'); tcBlob(() => g.ellipse(33, -2, 19, 9, 0, 0, 7), '#f4f0d5');   // zapatillas
  g.fillStyle = RED; g.fillRect(-82, -3, 12, 3); g.fillRect(24, -2, 12, 3);
  tcBlob(() => { g.moveTo(-32, -126); g.lineTo(32, -126); g.lineTo(38, -204); g.quadraticCurveTo(0, -214, -38, -204); g.closePath(); }, RED);   // remera
  g.fillStyle = 'rgba(0,0,0,.14)'; g.beginPath(); g.moveTo(14, -126); g.lineTo(32, -126); g.lineTo(38, -204); g.lineTo(22, -206); g.fill();      // sombra lateral
  g.fillStyle = WHITE; g.fillRect(-33, -136, 66, 6);                                                           // ribete de la remera
  g.fillStyle = WHITE; g.font = '900 22px Arial'; g.textAlign = 'center'; g.fillText('P7', -1, -168);
  tcLimb([[-32, -194], [-92, -180], [-136, -172]], 12, SKIN);                                                  // brazo izquierdo apoyado en la cámara
  tcBlob(() => g.arc(-141, -172, 10, 0, 7), SKIN);
  tcLimb([[32, -194], [78, -164], [90, -202 + sw * 6]], 12, SKIN);                                             // brazo derecho con el mate
  tcBlob(() => g.arc(90, -206 + sw * 6, 10, 0, 7), SKIN);
  const mx = 90, my = -224 + sw * 6;                                                                           // mate: calabaza, yerba y bombilla
  g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 3; g.lineCap = 'round';                               // vapor
  for (let i = 0; i < 3; i++) { g.beginPath(); for (let k = 0; k <= 10; k++) { const yy = my - 20 - k * 4, xx = mx - 8 + i * 8 + Math.sin(t * 3 + i * 2 + k * 0.7) * 3; k ? g.lineTo(xx, yy) : g.moveTo(xx, yy); } g.globalAlpha = 0.5; g.stroke(); g.globalAlpha = 1; }
  tcBlob(() => { g.moveTo(mx - 17, my - 14); g.lineTo(mx + 17, my - 14); g.quadraticCurveTo(mx + 19, my + 13, mx, my + 16); g.quadraticCurveTo(mx - 19, my + 13, mx - 17, my - 14); }, '#7a4a22');
  tcBlob(() => g.ellipse(mx, my - 14, 17, 5, 0, 0, 7), '#3f8a2c', 2.5);
  g.strokeStyle = INK; g.lineWidth = 6; g.beginPath(); g.moveTo(mx + 3, my - 14); g.lineTo(mx + 17, my - 46); g.stroke(); g.strokeStyle = '#e8ecf6'; g.lineWidth = 2.5; g.stroke();
  tcBlob(() => g.roundRect(-70, -186, 20, 52, 5), '#c7cfe3'); g.fillStyle = RED; g.fillRect(-69, -184, 18, 10); g.fillStyle = 'rgba(255,255,255,.55)'; g.fillRect(-64, -168, 4, 30);   // termo
  tcBlob(() => g.roundRect(-9, -216, 18, 18, 4), SKIN2);                                                       // cuello
  tcBlob(() => g.ellipse(-31, -240, 6, 9, 0, 0, 7), SKIN2); tcBlob(() => g.ellipse(31, -240, 6, 9, 0, 0, 7), SKIN2);   // orejas
  tcBlob(() => g.ellipse(0, -240, 31, 35, 0, 0, 7), SKIN);                                                      // cabeza
  g.fillStyle = 'rgba(224,32,43,.28)'; g.beginPath(); g.arc(-19, -228, 6, 0, 7); g.arc(19, -228, 6, 0, 7); g.fill();   // cachetes
  tcBlob(() => g.ellipse(3, -236, 6, 8, 0, 0, 7), SKIN2, 2.5);                                                  // nariz
  [[-11, -252], [11, -252]].forEach(([ex, ey], i) => { tcBlob(() => g.arc(ex, ey, 10, 0, 7), WHITE, 2.5); g.fillStyle = INK; g.beginPath(); g.arc(ex + Math.sin(t * 5 + i) * 3.5, ey + Math.cos(t * 5 + i) * 3.5, 3.6, 0, 7); g.fill(); });   // ojos desorbitados
  g.strokeStyle = INK; g.lineWidth = 3; g.lineCap = 'round'; g.beginPath(); g.moveTo(-22, -268); g.lineTo(-5, -264); g.moveTo(22, -268); g.lineTo(5, -262); g.stroke();   // cejas
  tcBlob(() => g.ellipse(2, -218, 11, 6 + Math.abs(sw) * 2.5, 0, 0, 7), '#3b0f18', 2.5); g.fillStyle = '#e8708a'; g.beginPath(); g.ellipse(2, -214, 6, 3, 0, 0, 7); g.fill();   // boca de «ay»
  tcBlob(() => { g.moveTo(-34, -262); g.quadraticCurveTo(-30, -296, 0, -298); g.quadraticCurveTo(30, -296, 34, -262); g.closePath(); }, BLUE);   // gorra
  tcBlob(() => { g.moveTo(-34, -262); g.quadraticCurveTo(0, -252, 52, -264); g.quadraticCurveTo(48, -272, 34, -272); g.lineTo(-34, -270); g.closePath(); }, '#1440b0');   // visera
  g.fillStyle = WHITE; g.font = '900 12px Arial'; g.fillText('P7', 0, -282);
  const dr = (t * 1.3) % 1;                                                                                    // gotas de sudor
  [[-1, 0], [1, 0.5]].forEach(([d, o]) => { const q = (dr + o) % 1; g.globalAlpha = 1 - q; tcBlob(() => { const x = d * (38 + q * 22), y = -262 + q * 34; g.moveTo(x, y - 8); g.quadraticCurveTo(x + 6, y, x, y + 5); g.quadraticCurveTo(x - 6, y, x, y - 8); }, '#8fd0ff', 2); g.globalAlpha = 1; });
  g.restore();
  for (let i = 0; i < 4; i++) { const a = t * 2.6 + i * Math.PI / 2; tcStar(px + Math.cos(a) * 52, 394 - 262 + Math.sin(a) * 11, 7, a); }   // estrellitas de mareo
}
function drawTech(t) {
  const { NAVY, BLUE, RED, YEL, WHITE, INK, SOFT } = TC;
  const gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, '#04103f'); gr.addColorStop(0.6, '#123fc0'); gr.addColorStop(1, '#1b4fd8');
  g.fillStyle = gr; g.fillRect(0, 0, W, H);
  const sp = g.createRadialGradient(W / 2, 250, 20, W / 2, 250, 330); sp.addColorStop(0, 'rgba(160,200,255,.30)'); sp.addColorStop(1, 'rgba(160,200,255,0)');
  g.fillStyle = sp; g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(255,255,255,.06)'; g.lineWidth = 14;                                                  // rayos del fondo
  for (let i = -3; i < 10; i++) { g.beginPath(); g.moveTo(i * 90 + 40, 70); g.lineTo(i * 90 - 120, 420); g.stroke(); }
  const fl = g.createLinearGradient(0, 372, 0, 420); fl.addColorStop(0, '#0a1a63'); fl.addColorStop(1, '#050b33');
  g.fillStyle = fl; g.fillRect(0, 372, W, 50);                                                                 // piso
  g.fillStyle = 'rgba(255,255,255,.12)'; g.fillRect(0, 372, W, 2);
  g.fillStyle = 'rgba(0,0,0,.30)'; g.beginPath(); g.ellipse(168, 402, 70, 9, 0, 0, 7); g.fill(); g.beginPath(); g.ellipse(408, 398, 78, 9, 0, 0, 7); g.fill();   // sombras
  // franja superior: logo, barras de ajuste en miniatura y aviso intermitente
  g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(0, 0, W, 58);
  ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'].forEach((c, i) => { g.fillStyle = c; g.fillRect((W / 7) * i, 58, W / 7 + 1, 5); });
  logo(24, 14, 1.0); sTxt('PAMPA 7 NOTICIAS', 80, 38, WHITE, 18, 'left', true);
  const on = Math.floor(t * 1.6) % 2 === 0; g.fillStyle = on ? RED : '#5a1020'; g.beginPath(); g.arc(W - 150, 30, 7, 0, 7); g.fill();
  sTxt('SIN SENAL', W - 134, 38, WHITE, 18, 'left', true);
  // título
  g.fillStyle = RED; g.fillRect(36, 104, W - 72, 4);
  sTxt('DIFICULTADES TECNICAS', W / 2, 100, YEL, 42, 'center', true, W - 80);
  drawTechCamera(t); drawTechCameraman(t);
  // cable desde la cámara hasta una ficha tirada en el piso
  g.lineCap = 'round'; g.lineJoin = 'round';
  [[INK, 9], ['#2b3a78', 5]].forEach(([c, lw]) => { g.strokeStyle = c; g.lineWidth = lw; g.beginPath(); g.moveTo(172, 402); g.bezierCurveTo(230, 424, 290, 378, 322, 398); g.bezierCurveTo(340, 410, 318, 414, 336, 404); g.stroke(); });
  tcBlob(() => g.roundRect(332, 396, 20, 12, 3), '#c7cfe3', 2.5);
  // cinta de novedades, como las del noticiero
  g.fillStyle = 'rgba(0,0,0,.5)'; g.fillRect(0, 414, W, 66);
  g.fillStyle = RED; g.fillRect(0, 414, W, 4);
  sTxt('POR FAVOR, NO CAMBIE DE CANAL', W / 2, 448, WHITE, 24, 'center', true, W - 60);
  g.fillStyle = BLUE; g.fillRect(0, 456, W, 24); g.fillStyle = YEL; g.fillRect(0, 456, 70, 24);
  g.font = '13px Star4000'; g.fillStyle = INK; g.textAlign = 'center'; g.fillText('AHORA', 35, 473); g.save(); g.beginPath(); g.rect(70, 456, W - 70, 24); g.clip();
  const tk = 'VOLVEMOS EN CUANTO EL CAMAROGRAFO ENCUENTRE EL CABLE  ///  NO MUEVA EL DIAL  ///  ESTAMOS TRABAJANDO PARA VOLVER AL AIRE  ///  ', tw = (g.font = '14px Star4000', g.measureText(tk).width);
  for (let k = 0; k < 3; k++) sTxt(tk, 80 + k * tw - ((t * 60) % tw), 474, YEL, 14);
  g.restore(); g.textAlign = 'left'; g.textBaseline = 'alphabetic';
}
function drawIdle(t) {
  if (S.ch === 7) drawTech(t);
  else if (S.ch === 1) {
    if (S.clipDur && vid.readyState >= 2 && vid.videoWidth) { cover(vid, vid.videoWidth, vid.videoHeight); g.fillStyle = 'rgba(0,0,40,.45)'; g.fillRect(0, 0, W, H); logo(W - 64, 20); }
    else drawBars(t, '');
  } else if (S.ch === 3) {
    if (ready()) { drawStudio(t, { conductor: '' }, null); g.fillStyle = 'rgba(0,0,0,.4)'; g.fillRect(0, 0, W, H); }
    else drawBars(t, 'SIN SEÑAL · CREÁ TU NOTICIA EN LOS CANALES 1 Y 2');
  } else if (S.ch === 5 && !pool().length) drawBars(t, 'SIN SEÑAL · SÉ EL PRIMERO EN MANDAR UNA NOTICIA');
  else drawStudio(t, { conductor: '' }, null);
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

function drawFrame(now) {
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
        } else if (a.v2) {   // video de una colaboración con permiso
          if (!a.clipStarted) { a.clipStarted = true; vid2.currentTime = 0; vid2.muted = S.muted; vid2.volume = S.vol; vid2.play().catch(() => { vid2.muted = true; vid2.play().catch(() => {}); }); }
          if (vid2.videoWidth) cover(vid2, vid2.videoWidth, vid2.videoHeight);
        } else if (a.seg.kind === 'clima') drawClima(el - a.intro, a.seg);
        else drawBroll(el - a.intro, a.seg);
        if (!(a.seg.kind === 'clima' && !a.v2)) drawOverlay(el - a.intro, a.st);
      } else if (el < a.total) {
        drawStudio(el, a.st, null);
        g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, 190, W, a.mine ? 112 : 90); g.fillStyle = '#fff'; g.textAlign = 'center';
        g.font = '800 30px Impact, Arial'; g.fillText('VOLVEMOS ENSEGUIDA', W / 2, 245);
        g.font = '600 14px Arial'; g.fillText('Pampa 7 Noticias · Informando desde siempre', W / 2, 268);
        if (a.mine && !/^(localhost|127\.)/.test(location.hostname)) { g.fillStyle = '#ffd400'; g.font = '700 14px Arial'; g.fillText('Hacé tu noticia en ' + location.host, W / 2, 292); }   // gancho para quien lo ve compartido
        g.textAlign = 'left';
      } else { a.done && a.done(); a.done = null; }
    } else drawIdle(t);
    if (S.filter) filter(t);
  }
}
// El siguiente cuadro se pide SIEMPRE, antes de dibujar: un error al dibujar (p. ej. una imagen que no cargó) no puede congelar la tele.
function frame(now) {
  requestAnimationFrame(frame);
  try { drawFrame(now); CLIP.current && CLIP.current(); } catch (e) { if (!frame.avisado) { frame.avisado = true; console.error('Error al dibujar un cuadro (se sigue emitiendo):', e); } }
}
requestAnimationFrame(frame);

// Arranca encendido y ya en el aire (canal 3). El sonido empieza con el primer toque.
S.pwr = { type: 'on', at: performance.now() };
S.staticUntil = performance.now() + 500;
renderPages();
setTimeout(badge, 500);
setTimeout(() => say('Tocá cualquier botón para activar el sonido.', 4500), 1200);
loadRemote();
startLoop();
for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, ensureAudioSoft, { once: true });
