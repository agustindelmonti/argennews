// Prueba de humo del backend: MCP, moderación, tweets y programación. Uso: node test/smoke.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const PORT = 4990 + Math.floor(Math.random() * 9), DIR = mkdtempSync(join(tmpdir(), 'p7-'));
const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT, DATA_DIR: DIR, ADMIN_TOKEN: 'secreto', ANTHROPIC_API_KEY: '', MCP_LIMIT_PER_IP: '3' }, stdio: 'ignore' });
const base = `http://localhost:${PORT}`;
for (let i = 0; i < 40; i++) { try { await fetch(base + '/api/config'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
const call = async (path, body, token, method = body ? 'POST' : 'GET', extra = {}) => { const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null }; };
const rpc = (method, params, id = 1) => call('/mcp', { jsonrpc: '2.0', id, method, params });
let n = 0; const ok = (name) => console.log(`ok ${++n} - ${name}`);

try {
  let r = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(r.json.result.serverInfo.name, 'pampa7-noticias'); ok('initialize');
  r = await call('/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }); assert.equal(r.status, 202); ok('notificación sin respuesta (202)');
  r = await rpc('tools/list'); assert.deepEqual(r.json.result.tools.map((t) => t.name), ['guia_de_estilo', 'crear_noticia', 'ver_noticias_recientes']); ok('tools/list');
  r = await rpc('tools/call', { name: 'guia_de_estilo', arguments: {} }); assert.match(r.json.result.content[0].text, /rioplatense/); ok('guia_de_estilo');

  const good = { titular: 'Alarma en el edificio por un gato en el balcón', bajada: 'Vecinos se turnan para mirarlo. Él no se inmuta.', conductor: 'Atención, atención. Un gato se instaló en el balcón del segundo piso y desde hace horas mira a la calle con autoridad. Los vecinos piden calma y yerba.', emoji: ['🐈', '🏢'], ticker: ['El gato no dio declaraciones'], autor: 'agus_dev' };
  r = await rpc('tools/call', { name: 'crear_noticia', arguments: good }); assert.ok(!r.json.result.isError); assert.match(r.json.result.content[0].text, /revisión/); ok('crear_noticia queda pendiente');
  r = await call('/api/programacion'); assert.equal(r.json.segments.length, 0); ok('pendiente no sale en la programación');

  for (const [bad, why] of [[{ ...good, conductor: 'Hoy Milei dijo algo increíble en la plaza y todos se rieron muchísimo.' }, 'persona/política real'], [{ ...good, bajada: 'Mirá https://example.com ahora mismo' }, 'link'], [{ titular: 'corto' }, 'faltan datos']]) {
    r = await rpc('tools/call', { name: 'crear_noticia', arguments: bad }); assert.equal(r.json.result.isError, true, why);
  }
  ok('rechaza política real, links y datos incompletos');
  // Famosos del espectáculo/deporte/medios: se pueden nombrar, pero SIEMPRE quedan en revisión y marcados; la política y los fallecidos siguen bloqueados.
  const famoso = { ...good, titular: 'Lionel Messi se queja de que el mate llegó frío', bajada: 'Pidió hablar con el termo. El termo no declaró.', conductor: 'Atención, atención. Se supo que Lionel Messi, en pleno asado de domingo, descubrió que el mate llegó frío. Dicen las malas lenguas que el termo ya pidió un abogado, y que la yerba pide no ser involucrada.' };
  r = await rpc('tools/call', { name: 'crear_noticia', arguments: famoso }); assert.ok(!r.json.result.isError, 'famoso permitido'); assert.match(r.json.result.content[0].text, /nombra a una persona/);
  r = await call('/admin/api/state', null, 'secreto'); assert.equal(r.json.segments.find((x) => x.titular.includes('MESSI')).analisis.nombra, true); ok('famoso permitido, marcado y en revisión manual');
  for (const mal of ['Maradona vuelve a la cancha en un partido muy gracioso para todos.', 'Hoy Trump y Biden se pelearon por el último alfajor del kiosco.']) {
    r = await rpc('tools/call', { name: 'crear_noticia', arguments: { ...good, titular: 'Escándalo con nombre propio en el kiosco', conductor: 'Atención, atención. ' + mal + ' Los vecinos miran todo desde la vereda con asombro.' } }); assert.equal(r.json.result.isError, true, mal);
  }
  ok('fallecidos y política partidaria siguen bloqueados');
  r = await rpc('tools/call', { name: 'crear_noticia', arguments: { ...good, titular: 'Lavarropas anuncia que no centrifugará los lunes', bajada: 'Dice que necesita un fin de semana largo para sí mismo.', conductor: 'Atención, atención. Un lavarropas del barrio comunicó que los lunes no piensa centrifugar nada. Sus dueños lo escucharon con respeto, tomaron mate y acordaron lavar a mano, por esta vez y sin precedentes.' } }); assert.match(r.json.result.content[0].text, /revisión/);
  r = await rpc('tools/call', { name: 'crear_noticia', arguments: { ...good, titular: 'Heladera exige que no le abran la puerta de noche', bajada: 'Asegura que el flan ya no tiene secretos para nadie.', conductor: 'Atención, atención. Una heladera se declaró en huelga de luces y pide que nadie la abra de madrugada. Los vecinos de la casa evalúan su pedido mientras miran, por las dudas, la cocina a oscuras.' } }); assert.match(r.json.result.content[0].text, /límite/); ok('límite diario por IP (solo cuentan las válidas)');

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
  r = await call('/api/presence', { id: 'pestana0001' }); assert.equal(r.json.online, 1);
  r = await call('/api/presence', { id: 'pestana0002' }); assert.equal(r.json.online, 2);
  r = await call('/api/presence', { id: 'pestana0002' }); assert.equal(r.json.online, 2);
  r = await call('/api/presence', { id: 'x' }); assert.equal(r.status, 400); ok('gente en línea: cuenta ids distintos, no duplica y rechaza ids inválidos');
  const V = (body) => call('/api/vote', body);
  r = await V({ seg: 'seed-clip-uno', voter: 'votante0001', v: 1 }); assert.equal(r.status, 200); assert.equal(r.json.stored, true);
  await V({ seg: 'seed-clip-uno', voter: 'votante0002', v: 1 }); await V({ seg: 'seed-clip-uno', voter: 'votante0003', v: -1 });
  await V({ seg: 'seed-clip-uno', voter: 'votante0003', v: 1 });   // cambia de opinión: no suma un voto más
  await V({ seg: 'seed-clip-dos', voter: 'votante0001', v: -1 }); await V({ seg: 'seed-clip-dos', voter: 'votante0001', v: 0 });   // retira el voto
  r = await call('/admin/api/state', null, 'secreto'); const tot = Object.fromEntries(r.json.votes.map((x) => [x.seg_id, x]));
  assert.deepEqual([tot['seed-clip-uno'].up, tot['seed-clip-uno'].down], [3, 0]); assert.deepEqual([tot['seed-clip-dos'].up, tot['seed-clip-dos'].down], [0, 0]);
  r = await V({ seg: 'a b', voter: 'votante0001', v: 1 }); assert.equal(r.status, 400); r = await V({ seg: 'seed-clip-uno', voter: 'votante0001', v: 5 }); assert.equal(r.status, 400); r = await V({ seg: 'seed-clip-uno', voter: 'x', v: 1 }); assert.equal(r.status, 400);
  ok('votos: uno por votante y clip, se puede cambiar o retirar, valida entradas y el admin ve los totales');
  // ---- Ranking de la comunidad: llegada -> prueba -> destacada / retirada ----
  const A = { titular: 'Vecino descubre que su paraguas es en realidad un bastón', bajada: 'Lleva dos años abriéndolo bajo techo. Nadie le avisó.', movil: 'Desde un pasillo de Almagro', conductor: 'Atención, atención. Un vecino descubrió que su paraguas de toda la vida jamás fue paraguas. Dos años abriéndolo en pasillos y ascensores sin que nadie le avisara. Los especialistas piden calma y un poco de lluvia para confirmarlo.', ticker: ['El bastón no dio declaraciones', 'Se estudia pedir un paraguas nuevo'], emoji: ['☂️', '🧐'], autor: 'autorA' };
  const B = { titular: 'Gato aprende a pedir permiso antes de tirar un vaso', bajada: 'La mesa, testigo del hecho, no dio declaraciones.', movil: 'Desde una cocina de Flores', conductor: 'Atención, atención. Un gato del barrio aprendió a pedir permiso antes de empujar un vaso al piso. Lo hace con la mirada, sin sonido y con gran seguridad. El vaso, por las dudas, ya se declaró en rebeldía.', ticker: ['El vaso pidió abogado', 'La mesa sigue sin comentar'], emoji: ['🐈', '🥛'], autor: 'autorB' };
  const C = { titular: 'Reloj despertador pide disculpas por llegar siempre tarde', bajada: 'Dice que el café lo distrae. Los vecinos no le creen.', movil: 'Desde una mesa de luz', conductor: 'Atención, atención. Un reloj despertador pidió disculpas públicas por sonar siempre cuando ya es demasiado tarde. Argumentó que el café lo distrae y que los lunes tiene una presión enorme. La almohada pidió reserva y silencio.', ticker: ['La almohada no confirma ni desmiente', 'El snooze evalúa dar un paso al costado'], emoji: ['⏰', '☕'], autor: 'autorC' };
  const enviar = (args, ip) => call('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'crear_noticia', arguments: args } }, null, 'POST', { 'x-forwarded-for': ip }).then((x) => x.json.result);
  const programacion = async () => (await call('/api/programacion')).json;
  const estado = async () => (await call('/admin/api/state', null, 'secreto')).json.segments;
  const idDe = async (titulo) => (await estado()).find((g) => g.titular === titulo.toUpperCase()).id;
  const aprobar = (id, accion = 'approve') => call(`/admin/api/segments/${id}/${accion}`, {}, 'secreto');
  const votar = async (id, ups, downs) => { let k = 0; for (let i = 0; i < ups; i++) await call('/api/vote', { seg: id, voter: `votarup${id.slice(0, 6)}${i}x`, v: 1 }); for (let i = 0; i < downs; i++) await call('/api/vote', { seg: id, voter: `votardn${id.slice(0, 6)}${i}x`, v: -1 }); };

  let res = await enviar(A, '10.1.0.1'); assert.ok(!res.isError); assert.match(res.content[0].text, /revisión/);
  let aid = await idDe(A.titular); const pend = (await estado()).find((g) => g.id === aid);
  assert.equal(typeof pend.analisis.puntaje, 'number'); assert.ok(pend.analisis.senales.length > 0); assert.equal((await programacion()).segments.some((g) => g.id === aid), false); ok('llega pendiente, con análisis, y no sale en la programación');
  await aprobar(aid); let pr = await programacion(); let sa = pr.segments.find((g) => g.id === aid);
  assert.equal(sa.tier, 'probation'); assert.equal(sa.peso, 1.5); assert.equal(pr.intercalado, 3); ok('al aprobarla entra A PRUEBA (peso 1,5) y el canal 3 intercala 1 cada 3');
  await votar(aid, 12, 0); sa = (await programacion()).segments.find((g) => g.id === aid); assert.equal(sa.tier, 'featured'); assert.ok(sa.peso > 1.5); ok('con 12 votos 👍 sube a DESTACADA (más peso)');
  await enviar(B, '10.1.0.2'); const bid = await idDe(B.titular); await aprobar(bid); await votar(bid, 3, 8);
  assert.equal((await programacion()).segments.some((g) => g.id === bid), false); assert.equal((await estado()).find((g) => g.id === bid).ranking.tier, 'retired'); ok('con 3 👍 y 8 👎 se RETIRA sola (no sale más; el admin la ve como retirada)');
  await enviar(C, '10.1.0.3'); const cid = await idDe(C.titular); await aprobar(cid, 'pin'); sa = (await programacion()).segments.find((g) => g.id === cid); assert.equal(sa.tier, 'featured'); ok('fijar a mano la deja destacada aunque no tenga votos');
  res = await enviar({ ...A, autor: 'otro' }, '10.1.0.4'); assert.equal(res.isError, true); assert.match(res.content[0].text, /parece demasiado/); ok('rechaza una duplicada de la comunidad');
  res = await enviar({ ...B, autor: 'copia', titular: 'Conmoción: el colectivo pasó a horario', bajada: 'Vecinos no saben cómo reaccionar. Hay quienes lloran.' }, '10.1.0.5'); assert.equal(res.isError, true); ok('rechaza una copia de las noticias originales');
  console.log(`\n${n} verificaciones ok`);
} catch (e) { console.error('FALLÓ:', e.message); process.exitCode = 1; } finally { srv.kill(); rmSync(DIR, { recursive: true, force: true }); }
