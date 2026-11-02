// Prueba del modo Vercel + Supabase sin red: un PostgREST simulado y la función api/[...path].js con las rutas reescritas.
// Verifica que el código usa la API REST de Supabase de forma coherente (filtros, upsert, RPC) y que las rutas /api/mcp y /api/admin/* funcionan.
// No reemplaza una prueba contra tu proyecto real de Supabase.
import http from 'node:http';
import assert from 'node:assert/strict';

const KEY = 'service-key-de-prueba', tables = { segments: [], embeds: [] }, rate = new Map(), log = [];
const readJson = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b ? JSON.parse(b) : undefined)); });
const mock = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://m'), body = await readJson(req), p = u.pathname.replace('/rest/v1/', '');
  log.push(`${req.method} ${p}${u.search}`);
  const send = (s, d) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(d === undefined ? '' : JSON.stringify(d)); };
  if (req.headers.apikey !== KEY || req.headers.authorization !== `Bearer ${KEY}`) return send(401, { message: 'bad key' });
  const eqf = (rows) => rows.filter((r) => [...u.searchParams].every(([k, v]) => !v.startsWith('eq.') || String(r[k]) === v.slice(3)));
  if (p === 'rpc/bump_limit') { const n = (rate.get(body.p_key) || 0) + 1; rate.set(body.p_key, n); return send(200, n <= body.p_lim); }
  const t = tables[p]; if (!t) return send(404, { message: 'no table' });
  if (req.method === 'GET') { let rows = eqf(t.slice()); if (p === 'segments') rows.sort((a, b) => b.created_at.localeCompare(a.created_at)); return send(200, rows.slice(0, Number(u.searchParams.get('limit')) || 1000)); }
  if (req.method === 'POST') { t.push({ added_at: new Date().toISOString(), ...body }); return send(201); }
  if (req.method === 'PATCH') { const rows = eqf(t); rows.forEach((r) => Object.assign(r, body)); return send(200, rows); }
  if (req.method === 'DELETE') { const rows = eqf(t); rows.forEach((r) => t.splice(t.indexOf(r), 1)); return send(200, rows); }
});
await new Promise((r) => mock.listen(0, r));

process.env.SUPABASE_URL = `http://localhost:${mock.address().port}`; process.env.SUPABASE_SERVICE_KEY = KEY;
process.env.ADMIN_TOKEN = 'secreto'; process.env.MCP_LIMIT_PER_IP = '1'; process.env.ANTHROPIC_API_KEY = ''; process.env.VERCEL = '1';
const { default: fn } = await import(new URL('../api/[...path].js', import.meta.url));   // la función tal como la carga Vercel
const app = http.createServer((req, res) => fn(req, res)); await new Promise((r) => app.listen(0, r));
const base = `http://localhost:${app.address().port}`;
const call = async (path, body, token, method = body ? 'POST' : 'GET') => { const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); return { status: r.status, headers: r.headers, json: t ? JSON.parse(t) : null }; };
const tool = (name, args) => call('/api/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
let n = 0; const ok = (m) => console.log(`ok ${++n} - ${m}`);

try {
  let r = await call('/api/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }); assert.equal(r.json.result.serverInfo.name, 'pampa7-noticias'); ok('MCP por /api/mcp (ruta reescrita)');
  const good = { titular: 'Alarma en el edificio por un gato en el balcón', bajada: 'Vecinos se turnan para mirarlo. Él no se inmuta.', conductor: 'Atención, atención. Un gato se instaló en el balcón del segundo piso y mira la calle con autoridad. Los vecinos piden calma y yerba.', emoji: ['🐈'], autor: 'agus_dev' };
  r = await tool('crear_noticia', good); assert.match(r.json.result.content[0].text, /pendiente/);
  assert.equal(tables.segments.length, 1); const row = tables.segments[0];
  assert.equal(row.status, 'pending'); assert.equal(row.source, 'mcp'); assert.match(row.id, /^[0-9a-f-]{36}$/); assert.ok(row.created_at); assert.equal(row.data.titular, 'ALARMA EN EL EDIFICIO POR UN GATO EN EL BALCÓN'); assert.equal(row.data.autor, 'agus_dev');
  assert.equal(row.data.id, undefined); assert.equal(row.data.status, undefined); ok('crear_noticia guarda fila {id, source, status, created_at, data} en Supabase');
  r = await tool('crear_noticia', { ...good, titular: 'Segundo gato exige su propio balcón' }); assert.match(r.json.result.content[0].text, /límite/); ok('límite diario vía RPC bump_limit');
  r = await call('/api/admin/state'); assert.equal(r.status, 401);
  r = await call('/api/admin/state', null, 'secreto'); assert.equal(r.json.storage, 'supabase'); assert.equal(r.json.ephemeral, false); assert.equal(r.json.segments[0].titular, row.data.titular); assert.equal(r.json.segments[0].status, 'pending'); ok('admin por /api/admin/* con estado y almacenamiento supabase');
  r = await call('/api/programacion'); assert.equal(r.json.segments.length, 0); ok('pendiente no sale en la programación');
  r = await call(`/api/admin/segments/${row.id}/approve`, {}, 'secreto'); assert.equal(r.status, 200); assert.equal(tables.segments[0].status, 'approved');
  r = await call('/api/programacion'); assert.equal(r.json.segments.length, 1); assert.equal(r.json.segments[0].credito, 'Enviada por @agus_dev'); assert.match(r.headers.get('cache-control'), /s-maxage=30/); ok('aprobada sale con crédito y con caché de CDN');
  assert.ok(log.some((l) => l.startsWith('GET segments?') && l.includes('status=eq.approved')), 'filtro status'); ok('consulta con filtro status=eq.approved');
  const before = log.length; r = await call('/api/admin/segments/no-es-uuid/approve', {}, 'secreto'); assert.equal(r.status, 404); assert.ok(!log.slice(before).some((l) => l.startsWith('PATCH')), 'no debe llegar a la base'); ok('id que no es UUID no llega a la base');
  r = await call('/api/admin/embeds', { url: 'https://x.com/alguien/status/1790000000000000001' }, 'secreto'); assert.equal(r.status, 200); assert.equal(tables.embeds[0].id, '1790000000000000001');
  r = await call('/api/admin/embeds', { url: 'https://x.com/alguien/status/1790000000000000001' }, 'secreto'); assert.equal(r.status, 409);
  r = await call('/api/programacion'); assert.deepEqual(r.json.embeds.map((e) => e.id), ['1790000000000000001']); ok('tweets: alta, duplicado 409 y listado');
  r = await call('/api/admin/embeds/1790000000000000001/delete', {}, 'secreto'); assert.equal(tables.embeds.length, 0); ok('tweets: baja');
  r = await call('/api/admin/segments', { ...good, titular: 'Colaboración con permiso del autor', autor: 'Creadora Ejemplo', video: 'https://cdn.example/clip.mp4', permiso: true }, 'secreto'); assert.equal(r.status, 200);
  const colab = tables.segments.find((s) => s.source === 'colab'); assert.equal(colab.status, 'approved'); assert.equal(colab.data.video, 'https://cdn.example/clip.mp4'); ok('colaboración con video guardada');
  r = await call(`/api/admin/segments/${row.id}/delete`, {}, 'secreto'); assert.equal(tables.segments.some((s) => s.id === row.id), false); ok('baja de segmento');
  r = await call('/api/no-existe'); assert.equal(r.status, 404); ok('ruta desconocida = 404 JSON');
  console.log(`\n${n} verificaciones ok`);
} catch (e) { console.error('FALLÓ:', e.stack || e.message); process.exitCode = 1; } finally { mock.close(); app.close(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
