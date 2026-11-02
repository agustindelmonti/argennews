# Pampa 7 Noticias

Noticiero argentino ficticio (estética 90/2000). Grabás ~10 s, la IA escribe una noticia de humor
en castellano rioplatense y se arma un clip con estudio, zócalo, ticker y filtro CRT, descargable.

## Correr
```sh
cp .env.example .env     # opcional: poné ANTHROPIC_API_KEY (y OPENAI_API_KEY para la voz)
node server.js           # http://localhost:4173  (Node >= 18, sin dependencias)
```
Sin `ANTHROPIC_API_KEY` funciona en modo demo (guiones de ejemplo).

## La tele
Arranca encendida en el canal 3 con programación continua (`public/seed.js`: noticias, clima, publicidades y
horóscopo ficticios) con zapping entre segmentos. Canales: 1 Cámara, 2 Redacción, 3 Pampa 7, 4 Estudio, 5 Comunidad, 6 Tweets.
Tu noticia entra primero y vuelve a salir cada 4 segmentos. Teclas: `P` encender/apagar, `1-4` canal,
`↑↓` canal, `←→` volumen, `M` mute, `G` guía, `F` pantalla completa.

## Contenido que entra por afuera
- **Canal 5 · Comunidad (MCP):** `POST /mcp` (Streamable HTTP, sin estado). El asistente de cada persona (ChatGPT, Claude, etc.) escribe la noticia con sus propios tokens usando `guia_de_estilo` y la envía con `crear_noticia`. Se valida (largos, sin links, filtro de temas), se limita por IP y queda pendiente hasta que la apruebes en `/admin.html` (o `AUTO_APPROVE=1` con moderación por IA).
- **Canal 6 · Tweets:** elegís los tweets en el admin y se muestran con el embed oficial de X (el video queda en X).
- **Tendencias:** en el admin traés los temas del día (RSS de Google Trends, Argentina), la IA los convierte en situaciones ficticias saltando personas, política y temas sensibles, y queda pendiente de tu aprobación.
- **Colaboraciones:** desde el admin cargás un segmento con crédito y, si querés, un link https a un video del que tengas permiso.

- **Canal del clima:** sketches con la tipografía y los íconos de Star4000, repintados con la paleta del noticiero. `/#clima` muestra solo esos segmentos.
- **Instalar el MCP:** en el canal 5, «Cómo participar» tiene botones para Claude, ChatGPT, Gemini CLI, Cursor, Claude Code y otros. Copian el link o el comando y abren la página de cada herramienta. Necesitás una URL pública con https.

Celular: en vertical la TV ocupa el ancho y los menús pasan a un panel debajo; en apaisado quedan dentro de la pantalla.

Prueba del backend: `node test/smoke.mjs`. Créditos de terceros: `THIRD_PARTY.md`.

## Cómo funciona
- `public/app.js`: todo el render va a un `<canvas>`; la vista previa y la descarga usan el mismo pipeline
  (`captureStream` + `MediaRecorder`), así que no hay costo de render en servidor.
- `server.js`: `/api/script` (fotogramas -> Claude con visión -> JSON), `/api/tts` (opcional), límites diarios por IP y globales.
- El video nunca se sube: solo ~5 fotogramas JPEG de 512 px viajan a la IA.

## Pendiente para el canal en vivo
Persistencia (Supabase), moderación previa a emisión, loop sincronizado por hora de servidor con relleno
(dólar blue, clima, horóscopo), TTS rioplatense por defecto, conversión a MP4 H.264 en servidor cuando el
navegador solo graba WebM, y límites con Redis/Supabase en lugar de memoria.
