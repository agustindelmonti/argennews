// Prueba de humo del backend: MCP, moderación, tweets y programación. Uso: node test/smoke.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const PORT = 4990 + Math.floor(Math.random() * 9), DIR = mkdtempSync(join(tmpdir(), 'p7-'));
const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT, DATA_DIR: DIR, ADMIN_TOKEN: 'secreto', ANTHROPIC_API_KEY: '', MCP_LIMIT_PER_IP: '2' }, stdio: 'ignore' });
const base = `http://localhost:${PORT}`;
for (let i = 0; i < 40; i++) { try { await fetch(base + '/api/config'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
const call = async (path, body, token, method = body ? 'POST' : 'GET') => { const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null }; };
const rpc = (method, params, id = 1) => call('/mcp', { jsonrpc: '2.0', id, method, params });
let n = 0; const ok = (name) => console.log(`ok ${++n} - ${name}`);

try {
  let r = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(r.json.result.serverInfo.name, 'pampa7-noticias'); ok('initialize');
  r = await call('/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }); assert.equal(r.status, 202); ok('notificación sin respuesta (202)');
  r = await rpc('tools/list'); assert.deepEqual(r.json.result.tools.map((t) => t.name), ['guia_de_estilo', 'crear_noticia', 'ver_noticias_recientes']); ok('tools/list');
  r = await rpc('tools/call', { name: 'guia_de_estilo', arguments: {} }); assert.match(r.json.result.content[0].text, /rioplatense/); ok('guia_de_estilo');

  const good = { titular: 'Alarma en el edificio por un gato en el balcón', bajada: 'Vecinos se turnan para mirarlo. Él no se inmuta.', conductor: 'Atención, atención. Un gato se instaló en el balcón del segundo piso y desde hace horas mira a la calle con autoridad. Los vecinos piden calma y yerba.', emoji: ['🐈', '🏢'], ticker: ['El gato no dio declaraciones'], autor: 'agus_dev' };
  r = await rpc('tools/call', { name: 'crear_noticia', arguments: good }); assert.ok(!r.json.result.isError); assert.match(r.json.result.content[0].text, /pendiente/); ok('crear_noticia queda pendiente');
  r = await call('/api/programacion'); assert.equal(r.json.segments.length, 0); ok('pendiente no sale en la programación');

  for (const [bad, why] of [[{ ...good, conductor: 'Hoy Milei dijo algo increíble en la plaza y todos se rieron muchísimo.' }, 'persona/política real'], [{ ...good, bajada: 'Mirá https://example.com ahora mismo' }, 'link'], [{ titular: 'corto' }, 'faltan datos']]) {
    r = await rpc('tools/call', { name: 'crear_noticia', arguments: bad }); assert.equal(r.json.result.isError, true, why);
  }
  ok('rechaza política real, links y datos incompletos');
  r = await rpc('tools/call', { name: 'crear_noticia', arguments: { ...good, titular: 'Segundo gato en el balcón del tercero' } }); assert.match(r.json.result.content[0].text, /pendiente/);
  r = await rpc('tools/call', { name: 'crear_noticia', arguments: { ...good, titular: 'Tercer gato exige su propio balcón' } }); assert.match(r.json.result.content[0].text, /límite/); ok('límite diario por IP (solo cuentan las válidas)');

  r = await call('/admin/api/state'); assert.equal(r.status, 401); ok('admin sin token = 401');
  r = await call('/admin/api/state', null, 'secreto'); const seg = r.json.segments.find((s) => s.status === 'pending'); assert.ok(seg); ok('admin ve pendientes');
  r = await call(`/admin/api/segments/${seg.id}/approve`, {}, 'secreto'); assert.equal(r.status, 200);
  r = await call('/api/programacion'); assert.equal(r.json.segments.length, 1); assert.equal(r.json.segments[0].credito, 'Enviada por @agus_dev'); assert.equal(r.json.segments[0].source, 'mcp'); ok('aprobada sale con crédito');

  r = await call('/admin/api/embeds', { url: 'https://x.com/algun_usuario/status/1790000000000000001?s=20' }, 'secreto'); assert.equal(r.status, 200);
  r = await call('/admin/api/embeds', { url: 'https://evil.example/status/1790000000000000001' }, 'secreto'); assert.equal(r.status, 400);
  r = await call('/api/programacion'); assert.deepEqual(r.json.embeds.map((e) => e.id), ['1790000000000000001']); ok('tweets: acepta x.com, rechaza otros dominios');

  r = await call('/admin/api/segments', { ...good, autor: 'Creadora Ejemplo', video: 'http://insegura.example/v.mp4', permiso: true }, 'secreto'); assert.equal(r.status, 400); ok('colaboración: video solo https');
  r = await call('/admin/api/segments', { ...good, titular: 'Colaboración con permiso del autor', autor: 'Creadora Ejemplo', video: 'https://cdn.example/clip.mp4', permiso: true }, 'secreto'); assert.equal(r.status, 200);
  r = await call('/admin/api/segments', { ...good, autor: 'X' }, 'secreto'); assert.equal(r.status, 400); ok('colaboración exige permiso');
  r = await call('/api/programacion'); const colab = r.json.segments.find((s) => s.source === 'colab'); assert.equal(colab.credito, 'Gentileza de Creadora Ejemplo'); assert.equal(colab.video, 'https://cdn.example/clip.mp4'); ok('colaboración con video y crédito');
  r = await call('/admin/api/trends/generate', { topics: ['lluvia'] }, 'secreto'); assert.equal(r.status, 400); ok('tendencias sin API key = error claro');
  console.log(`\n${n} verificaciones ok`);
} catch (e) { console.error('FALLÓ:', e.message); process.exitCode = 1; } finally { srv.kill(); rmSync(DIR, { recursive: true, force: true }); }
