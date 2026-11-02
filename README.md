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

- **Votos 👍 / 👎:** dos pulsadores en el mentón del televisor votan el clip que está al aire. Son anónimos (un id al azar guardado en el navegador), uno por clip y por navegador, y se pueden cambiar o retirar. El público no ve los totales: vos los ves en `/admin.html`, en «Ranking de clips». Tablas y funciones en `supabase/votes.sql`.
- **Compartir y descargar tu noticia:** tu clip se graba solo la primera vez que sale al aire, así «Compartir» y «Descargar» lo encuentran listo. En el celular abre el menú del sistema (Instagram, WhatsApp y más). En escritorio, «Publicar en X» descarga el clip y abre el tuit con el texto (X no permite adjuntar un video desde un link) e «Instagram» descarga el clip, copia el texto y abre Instagram (no permite publicar desde un link). El clip termina con «Hacé tu noticia en <tu dominio>».
- **Descargar lo que estás viendo (botón ⬇ junto a los 👍/👎):** vuelve a emitir la noticia desde el principio y la graba en el momento como **MP4** (H.264, con el televisor entero: marco y pantalla), sin diálogos del navegador. Se arma con WebCodecs + `mp4-muxer` (`public/clip.js`), así que el archivo es válido en cualquier reproductor y en X; en navegadores sin WebCodecs (Firefox) cae a MediaRecorder y baja un `.webm`. El clip lleva cortina, efectos y la voz pregrabada si existe; la voz del navegador (speechSynthesis) no se puede grabar, por eso el texto del conductor va escrito en pantalla.
- **Audiencia en línea:** display de 7 segmentos en el mentón; `/#audiencia` muestra una vista previa del diseño sin servidor.

Celular: en vertical la TV ocupa el ancho y los menús pasan a un panel debajo; en apaisado quedan dentro de la pantalla.

Pruebas: `npm test` (servidor local y modo Vercel + Supabase simulado). Créditos de terceros: `THIRD_PARTY.md`.

## Deploy en Vercel
1. **Supabase:** creá un proyecto y ejecutá `supabase/schema.sql` en el SQL Editor (tablas con RLS activado y sin políticas: solo el servidor entra).
2. **Almacenamiento: elegí una de dos formas** (la app usa la primera que encuentra):
   - **Puente (recomendado, sin copiar claves):** desplegá `supabase/functions/store` como Edge Function (sin verificación de JWT: se autentica sola), generá un token al azar, guardá **solo su hash** SHA-256 en la tabla `store_auth` (`supabase/store_auth.sql`) y cargá en Vercel `STORE_URL` (`https://<proyecto>.supabase.co/functions/v1/store`) y `STORE_TOKEN` (el token, como variable sensible). La clave `service_role` nunca sale de Supabase.
   - **Directo:** `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` (o `SUPABASE_SERVICE_ROLE_KEY`, que inyecta la integración Supabase ↔ Vercel al conectar el proyecto).
3. **Vercel:** importá el repo (sin framework; `vercel.json` define `public/`, las rutas `/mcp` y `/admin/api/*` y la función `api/[...path].js`). Cada push a `main` despliega solo.
4. **Variables de entorno.** Lo que habilita cada una:

   | Variable | Para qué | Sin ella |
   | --- | --- | --- |
   | `STORE_URL` + `STORE_TOKEN` (o `SUPABASE_*`) | **Guardar todo**: votos, audiencia, tweets, noticias de la comunidad, límites | Archivo temporal (se pierde en Vercel); la audiencia se oculta |
   | `ADMIN_TOKEN` | Entrar a `/admin.html` | Admin desactivado |
   | `ANTHROPIC_API_KEY` | **Solo IA**: escribir la noticia desde tu video, generar por tendencias y moderar | Guiones de ejemplo; el resto anda igual |
   | `OPENAI_API_KEY` | Voz del conductor en el archivo descargado | Voz solo en la vista previa |
   | `AUTO_APPROVE=1` | Aprobar solas las noticias del MCP que pasen la moderación (requiere `ANTHROPIC_API_KEY`) | Todo queda pendiente hasta que aprobás |

   **El guardado no depende de Anthropic.** Los votos, la audiencia y el resto se guardan con solo configurar el almacenamiento.
5. **Probalo:** `/` es el televisor, `/admin.html` el panel, `/mcp` el servidor MCP y `/api/health` dice qué almacenamiento se usa y si responde.
6. **MCP público:** ChatGPT y Claude llaman a `/mcp` desde sus servidores: usá el dominio de producción y revisá que *Deployment Protection* no lo bloquee.

## Cómo funciona
- `public/app.js`: todo el render va a un `<canvas>`; la vista previa y la descarga usan el mismo pipeline
  (`captureStream` + `MediaRecorder`), así que no hay costo de render en servidor.
- `server.js`: `/api/script` (fotogramas -> Claude con visión -> JSON), `/api/tts` (opcional), límites diarios por IP y globales.
- El video nunca se sube: solo ~5 fotogramas JPEG de 512 px viajan a la IA.

## Pendiente para el canal en vivo
Persistencia (Supabase), moderación previa a emisión, loop sincronizado por hora de servidor con relleno
(dólar blue, clima, horóscopo), TTS rioplatense por defecto, conversión a MP4 H.264 en servidor cuando el
navegador solo graba WebM, y límites con Redis/Supabase en lugar de memoria.
