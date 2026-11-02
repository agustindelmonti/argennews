// Grabador de clips: compone el televisor entero (marco + pantalla) en un canvas y lo guarda como video.
// 1) Camino bueno (Chrome/Edge/Safari recientes): WebCodecs + mp4-muxer → MP4 con H.264 y AAC, con el índice al principio
//    (se abre en cualquier reproductor y lo aceptan X, Instagram y WhatsApp). No usa MediaRecorder, que es lo que dejaba archivos «rotos».
// 2) Camino de reserva (Firefox y navegadores sin H.264 en WebCodecs): MediaRecorder sobre el mismo canvas compuesto.
// El audio sale de la mezcla de la app (cortina, efectos y la voz pregrabada si hay).
// El video se compone acá (no sale de una captura de pantalla), para que el MP4 sea válido.
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
// screen: canvas de la pantalla (640×480). ac/mix: contexto y nodo de la mezcla de audio. dest: MediaStreamDestination (solo para el camino de reserva).
export async function startClip({ screen, ac, mix, dest, onFrame, audioStream }) {
  await frameReady;
  const out = document.createElement('canvas'); out.width = W; out.height = H;
  const o = out.getContext('2d');
  const compose = () => {
    o.fillStyle = '#000'; o.fillRect(0, 0, W, H);
    o.drawImage(screen, SX, SY, SW, SH);
    if (frameImg.complete && frameImg.naturalWidth) o.drawImage(frameImg, 0, 0, W, H);
  };
  const vc = await videoConfig();
  return vc ? startWebCodecs({ out, compose, ac, mix, vc, onFrame, audioStream }) : startFallback({ out, compose, dest, onFrame, audioStream });
}

// Ayuda: codifica el audio ya grabado (PCM) con un códec y lo decodifica para comprobar que suena. Devuelve {chunks, peak} o null.
async function encodeAudio(pcm, sampleRate, codec) {
  const cfg = { codec, sampleRate, numberOfChannels: 2, bitrate: 128000 };
  try { if (!(await AudioEncoder.isConfigSupported(cfg)).supported) return null; } catch { return null; }
  const chunks = []; let err = null;
  const enc = new AudioEncoder({ output: (c, m) => chunks.push({ c, m }), error: (e) => { err = e; } });
  try {
    enc.configure(cfg);
    let at = 0;
    for (const blk of pcm) {   // blk: Float32Array planar [canal 0 | canal 1]
      const n = blk.length / 2;
      enc.encode(new AudioData({ format: 'f32-planar', sampleRate, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((at / sampleRate) * 1e6), data: blk }));
      at += n;
    }
    await enc.flush(); enc.close();
  } catch (e) { err = err || e; }
  if (err || !chunks.length) return null;
  // Verificación: se decodifica lo codificado y se mide el nivel. Un MP4 con la pista de audio rota se ve «sin sonido» en el reproductor.
  let peak = null;
  try {
    const dc = chunks.find((x) => x.m && x.m.decoderConfig)?.m.decoderConfig;
    if (dc && typeof AudioDecoder !== 'undefined' && (await AudioDecoder.isConfigSupported(dc)).supported) {
      peak = 0;
      const dec = new AudioDecoder({ output: (d) => { const f = new Float32Array(d.numberOfFrames); d.copyTo(f, { planeIndex: 0, format: 'f32-planar' }); for (let i = 0; i < f.length; i++) { const v = Math.abs(f[i]); if (v > peak) peak = v; } d.close(); }, error: () => { peak = null; } });
      dec.configure(dc);
      for (const x of chunks) dec.decode(x.c);
      await dec.flush(); dec.close();
    }
  } catch { peak = null; }
  return { chunks, peak, cfg };
}

async function startWebCodecs({ out, compose, ac, mix, vc, onFrame, audioStream }) {
  // El video se codifica en vivo; el audio se guarda crudo (PCM) y se codifica al final, así se puede verificar y, si un códec falla, probar otro.
  const vchunks = []; let failed = null;
  const venc = new VideoEncoder({ output: (c, m) => vchunks.push({ c, m }), error: (e) => { failed = e; } });
  venc.configure(vc.cfg);
  const pcm = []; let proc = null, mute = null, tap = mix, written = 0, inPeak = 0;
  if (typeof AudioEncoder !== 'undefined') {
    proc = ac.createScriptProcessor(4096, 2, 2);
    mute = ac.createGain(); mute.gain.value = 0;
    proc.onaudioprocess = (ev) => {
      const n = ev.inputBuffer.length, data = new Float32Array(n * 2);
      data.set(ev.inputBuffer.getChannelData(0), 0); data.set(ev.inputBuffer.getChannelData(ev.inputBuffer.numberOfChannels > 1 ? 1 : 0), n);
      for (let i = 0; i < n; i += 8) { const v = Math.abs(data[i]); if (v > inPeak) inPeak = v; }
      pcm.push(data); written += n;
    };
    if (audioStream && audioStream.getAudioTracks().length) tap = ac.createMediaStreamSource(audioStream);
    tap.connect(proc); proc.connect(mute); mute.connect(ac.destination);
  }
  const t0 = performance.now(); let next = 0, frames = 0, stopped = false;
  const tick = () => {
    if (stopped || failed) return;
    const t = performance.now() - t0;
    if (t < next) return;                      // un cuadro cada 1/30 s aunque la pantalla refresque a 60 o 144 Hz
    if (venc.encodeQueueSize > 8) { next = t + 1000 / FPS; return; }   // el codificador no da abasto: se saltea en vez de acumular
    compose();
    // Cada cuadro se sella con su turno ideal (cada 33,3 ms), no con la hora real: el video queda a 30 cuadros parejos.
    // Si la máquina se atrasó, se repite el último cuadro para no acelerar el video (como mucho 4 seguidos).
    for (let k = 0; k < 4 && next <= t; k++) {
      const vf = new VideoFrame(out, { timestamp: Math.round(next * 1000) });
      venc.encode(vf, { keyFrame: frames % (FPS * 2) === 0 }); vf.close(); frames++;
      next += 1000 / FPS;
    }
    if (next <= t) next = t + 1000 / FPS;
  };
  onFrame.current = tick;
  return {
    kind: 'mp4',
    async stop(discard) {
      stopped = true; onFrame.current = null;
      if (proc) { try { tap.disconnect(proc); proc.disconnect(); mute.disconnect(); } catch { /* ya desconectado */ } proc.onaudioprocess = null; }
      try { await venc.flush(); } catch (e) { failed = failed || e; }
      try { venc.close(); } catch { /* ya cerrado */ }
      if (discard) return null;
      if (failed || !frames) throw failed || new Error('sin cuadros');
      // Audio: AAC primero (lo aceptan X, Instagram y todos los reproductores); si no se puede codificar o no se escucha al decodificarlo, Opus.
      let audio = null, how = 'ninguno';
      if (pcm.length && inPeak < 1e-4) how = 'silencio';          // la mezcla de la app estaba muda: no es un problema de códec
      else if (pcm.length) {
        for (const [codec, mux] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
          const r = await encodeAudio(pcm, ac.sampleRate, codec);
          if (r && (r.peak === null || r.peak > 1e-4)) { audio = { ...r, mux }; how = mux; break; }
          console.warn('Audio', codec, r ? 'se decodifica en silencio' : 'no se pudo codificar');
        }
      }
      const muxer = new Muxer({
        target: new ArrayBufferTarget(), fastStart: 'in-memory', firstTimestampBehavior: 'offset',
        video: { codec: vc.mux, width: W, height: H },   // sin frameRate: con él el muxer redondea las marcas de tiempo a la grilla de 30 cuadros y quedan repetidas
        ...(audio ? { audio: { codec: audio.mux, sampleRate: ac.sampleRate, numberOfChannels: 2 } } : {}),
      });
      // Se intercalan video y audio por marca de tiempo (como un archivo normal).
      const all = vchunks.map((x) => ({ ...x, v: true })).concat(audio ? audio.chunks.map((x) => ({ ...x, v: false })) : []).sort((a, b) => a.c.timestamp - b.c.timestamp);
      for (const x of all) { if (x.v) muxer.addVideoChunk(x.c, x.m); else muxer.addAudioChunk(x.c, x.m); }
      muxer.finalize();
      return { blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }), type: 'video/mp4', ext: 'mp4', audio: how, peak: Math.round(inPeak * 100) / 100 };
    },
  };
}

function startFallback({ out, compose, dest, onFrame, audioStream }) {
  const stream = out.captureStream(FPS);
  const tabAudio = audioStream && audioStream.getAudioTracks().length ? audioStream : dest.stream;
  tabAudio.getAudioTracks().forEach((t) => stream.addTrack(t));
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
      return { blob: new Blob(chunks, { type }), type, ext: type.includes('mp4') ? 'mp4' : 'webm', audio: 'mediarecorder' };
    },
  };
}

export const clipSupported = () => !!(window.MediaRecorder || (typeof VideoEncoder !== 'undefined' && typeof AudioData !== 'undefined'));
