// Grabador de clips: compone el televisor entero (marco + pantalla) en un canvas y lo guarda como video.
// 1) Camino bueno (Chrome/Edge/Safari recientes): WebCodecs + mp4-muxer → MP4 con H.264 y AAC, con el índice al principio
//    (se abre en cualquier reproductor y lo aceptan X, Instagram y WhatsApp). No usa MediaRecorder, que es lo que dejaba archivos «rotos».
// 2) Camino de reserva (Firefox y navegadores sin H.264 en WebCodecs): MediaRecorder sobre el mismo canvas compuesto.
// El audio sale de la mezcla de la app (cortina, efectos y la voz pregrabada si hay), no de los parlantes.
import { Muxer, ArrayBufferTarget } from './vendor/mp4-muxer.js';

const W = 1280, H = 970;               // el televisor (marco incluido)
const SX = 19, SY = 19, SW = 1243, SH = 932;   // dónde va la pantalla dentro del marco (coincide con assets/tv-frame.png)
const FPS = 30;

const frameImg = new Image(); frameImg.src = 'assets/tv-frame.png';
const frameReady = frameImg.decode ? frameImg.decode().catch(() => {}) : Promise.resolve();

function pickMime() {
  const c = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return c.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

async function videoConfig() {
  if (typeof VideoEncoder === 'undefined' || typeof AudioData === 'undefined') return null;
  const force = window.__clipCodec;     // solo para pruebas: 'vp9' fuerza VP9 dentro del MP4
  const tries = force === 'vp9' ? [['vp09.00.40.08', 'vp9']] : [['avc1.640028', 'avc'], ['avc1.4D0028', 'avc'], ['avc1.42E028', 'avc']];
  for (const [codec, mux] of tries) {
    const cfg = { codec, width: W, height: H, bitrate: 6e6, framerate: FPS };
    try { const r = await VideoEncoder.isConfigSupported(cfg); if (r.supported) return { cfg, mux }; } catch { /* siguiente */ }
  }
  return null;
}
async function audioConfig(sampleRate) {
  if (typeof AudioEncoder === 'undefined') return null;
  for (const [codec, mux] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
    const cfg = { codec, sampleRate, numberOfChannels: 2, bitrate: 128000 };
    try { const r = await AudioEncoder.isConfigSupported(cfg); if (r.supported) return { cfg, mux }; } catch { /* siguiente */ }
  }
  return null;
}

// screen: canvas de la pantalla (640×480). ac/mix: contexto y nodo de la mezcla de audio. dest: MediaStreamDestination (solo para el camino de reserva).
export async function startClip({ screen, ac, mix, dest, onFrame }) {
  await frameReady;
  const out = document.createElement('canvas'); out.width = W; out.height = H;
  const o = out.getContext('2d');
  const compose = () => {
    o.fillStyle = '#000'; o.fillRect(0, 0, W, H);
    o.drawImage(screen, SX, SY, SW, SH);
    if (frameImg.complete && frameImg.naturalWidth) o.drawImage(frameImg, 0, 0, W, H);
  };
  const vc = await videoConfig();
  return vc ? startWebCodecs({ out, compose, ac, mix, vc, onFrame }) : startFallback({ out, compose, dest, onFrame });
}

async function startWebCodecs({ out, compose, ac, mix, vc, onFrame }) {
  const ac_ = await audioConfig(ac.sampleRate);
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target, fastStart: 'in-memory', firstTimestampBehavior: 'offset',
    video: { codec: vc.mux, width: W, height: H },   // sin frameRate: con él el muxer redondea las marcas de tiempo a la grilla de 30 cuadros y quedan repetidas
    ...(ac_ ? { audio: { codec: ac_.mux, sampleRate: ac.sampleRate, numberOfChannels: 2 } } : {}),
  });
  let failed = null;
  const venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => { failed = e; } });
  venc.configure(vc.cfg);
  let aenc = null, proc = null, mute = null;
  if (ac_) {
    aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: (e) => { failed = e; } });
    aenc.configure(ac_.cfg);
    proc = ac.createScriptProcessor(4096, 2, 2);
    mute = ac.createGain(); mute.gain.value = 0;
    let written = 0;
    proc.onaudioprocess = (ev) => {
      const n = ev.inputBuffer.length, data = new Float32Array(n * 2);
      data.set(ev.inputBuffer.getChannelData(0), 0); data.set(ev.inputBuffer.getChannelData(ev.inputBuffer.numberOfChannels > 1 ? 1 : 0), n);
      try { aenc.encode(new AudioData({ format: 'f32-planar', sampleRate: ac.sampleRate, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((written / ac.sampleRate) * 1e6), data })); } catch (e) { failed = e; }
      written += n;
    };
    mix.connect(proc); proc.connect(mute); mute.connect(ac.destination);
  }
  const t0 = performance.now(); let next = 0, frames = 0, stopped = false;
  const tick = () => {
    if (stopped || failed) return;
    const t = performance.now() - t0;
    if (t < next) return;                      // un cuadro cada 1/30 s aunque la pantalla refresque a 60 o 144 Hz
    const slot = next;                         // el cuadro se sella con su turno ideal (cada 33,3 ms) y no con la hora real: el video queda a 30 cuadros parejos
    next += 1000 / FPS; if (next < t) next = t + 1000 / FPS;
    if (venc.encodeQueueSize > 8) return;      // el codificador no da abasto: se saltea un cuadro en vez de acumular
    compose();
    const vf = new VideoFrame(out, { timestamp: Math.round(slot * 1000) });
    venc.encode(vf, { keyFrame: frames % (FPS * 2) === 0 }); vf.close(); frames++;
  };
  onFrame.current = tick;
  return {
    kind: 'mp4',
    async stop(discard) {
      stopped = true; onFrame.current = null;
      if (proc) { try { mix.disconnect(proc); proc.disconnect(); mute.disconnect(); } catch { /* ya desconectado */ } proc.onaudioprocess = null; }
      try { await venc.flush(); if (aenc) await aenc.flush(); } catch (e) { failed = failed || e; }
      try { venc.close(); aenc && aenc.close(); } catch { /* ya cerrado */ }
      if (discard) return null;
      if (failed || !frames) throw failed || new Error('sin cuadros');
      muxer.finalize();
      return { blob: new Blob([target.buffer], { type: 'video/mp4' }), type: 'video/mp4', ext: 'mp4' };
    },
  };
}

function startFallback({ out, compose, dest, onFrame }) {
  const stream = out.captureStream(FPS);
  dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
  const mime = pickMime(), chunks = [];
  const rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 5e6 });
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.start(250);
  onFrame.current = compose;
  return {
    kind: 'recorder',
    async stop(discard) {
      onFrame.current = null;
      await new Promise((res) => { rec.onstop = res; rec.stop(); });
      if (discard || !chunks.length) return null;
      const type = rec.mimeType || mime || 'video/webm';
      return { blob: new Blob(chunks, { type }), type, ext: type.includes('mp4') ? 'mp4' : 'webm' };
    },
  };
}

export const clipSupported = () => !!(window.MediaRecorder || (typeof VideoEncoder !== 'undefined' && typeof AudioData !== 'undefined'));
