// Servidor local sin dependencias: API (lib/app.js) + archivos estáticos de /public.
// En Vercel no se usa: allí /public lo sirve la CDN y la API corre como función (api/[...path].js).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');

if (existsSync(join(ROOT, '.env'))) {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]] && m[2]) process.env[m[1]] = m[2];
  }
}
const { handle, store } = await import('./lib/app.js');   // después de cargar .env

const PORT = Number(process.env.PORT || 4173);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.gif': 'image/gif', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8' };

const server = http.createServer(async (req, res) => {
  try {
    if (await handle(req, res)) return;
    const url = new URL(req.url, 'http://x');
    let p = normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
    if (p === '/' || p === '\\') p = '/index.html';
    const file = join(PUBLIC, p);
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(await readFile(file));
  } catch (e) {
    if (e.code === 'ENOENT') { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    console.error(e); res.writeHead(500); res.end('Error interno');
  }
});
server.listen(PORT, () => console.log(`Pampa 7 Noticias en http://localhost:${PORT}  (${process.env.ANTHROPIC_API_KEY ? 'IA real' : 'modo demo'}, almacenamiento: ${store().kind}${process.env.ADMIN_TOKEN ? ', admin en /admin.html' : ', admin desactivado'})`));
