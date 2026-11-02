// Almacenamiento con dos implementaciones:
//  - archivo JSON (desarrollo local; en Vercel NO persiste entre ejecuciones)
//  - Supabase por REST (producción): SUPABASE_URL + SUPABASE_SERVICE_KEY, tablas en supabase/schema.sql
// Un "segmento" es siempre un objeto plano: { id, source, status, createdAt, ...campos de la noticia }.
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const today = () => new Date().toISOString().slice(0, 10);

export function createStore(env = process.env) {
  // La integración Supabase ↔ Vercel inyecta SUPABASE_SERVICE_ROLE_KEY; también aceptamos el nombre SUPABASE_SERVICE_KEY.
  const key = env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  return env.SUPABASE_URL && key ? supabaseStore(env, key) : fileStore(env);
}

function fileStore(env) {
  const dir = env.DATA_DIR || (env.VERCEL ? join(tmpdir(), 'pampa7') : fileURLToPath(new URL('../data', import.meta.url)));
  const file = join(dir, 'db.json');
  let db = { segments: [], embeds: [] };
  if (existsSync(file)) { try { db = { segments: [], embeds: [], ...JSON.parse(readFileSync(file, 'utf8')) }; } catch { console.error('db.json ilegible, arranco vacío'); } }
  let saving = Promise.resolve();
  const save = () => (saving = saving.then(async () => { await mkdir(dir, { recursive: true }); const tmp = file + '.tmp'; await writeFile(tmp, JSON.stringify(db, null, 1)); await rename(tmp, file); }).catch((e) => console.error('save', e)));
  let day = today(); const counters = new Map();
  return {
    kind: 'archivo',
    async segments({ status, source, limit = 200 } = {}) {
      return db.segments.filter((s) => (!status || s.status === status) && (!source || s.source === source)).slice(-limit).reverse();
    },
    async addSegment(row) { db.segments.push(row); await save(); },
    async setStatus(id, status) { const s = db.segments.find((x) => x.id === id); if (!s) return false; s.status = status; await save(); return true; },
    async deleteSegment(id) { const i = db.segments.findIndex((x) => x.id === id); if (i < 0) return false; db.segments.splice(i, 1); await save(); return true; },
    async embeds() { return db.embeds.slice(); },
    async addEmbed(e) { if (db.embeds.some((x) => x.id === e.id)) return false; db.embeds.push(e); await save(); return true; },
    async deleteEmbed(id) { db.embeds = db.embeds.filter((e) => e.id !== id); await save(); },
    async bump(key, limit) {   // true si todavía está dentro del límite diario
      if (today() !== day) { day = today(); counters.clear(); }
      const n = (counters.get(key) || 0) + 1; counters.set(key, n); return n <= limit;
    },
  };
}

function supabaseStore(env, key) {
  const base = env.SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/';
  async function rest(path, { method = 'GET', body, prefer } = {}) {
    const r = await fetch(base + path, { method, headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(prefer ? { prefer } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const t = await r.text(); return t ? JSON.parse(t) : null;
  }
  const flat = (r) => ({ ...r.data, id: r.id, source: r.source, status: r.status, createdAt: r.created_at });
  const eq = (v) => encodeURIComponent(String(v));
  return {
    kind: 'supabase',
    async segments({ status, source, limit = 200 } = {}) {
      let q = `segments?select=id,source,status,created_at,data&order=created_at.desc&limit=${Number(limit) || 200}`;
      if (status) q += `&status=eq.${eq(status)}`; if (source) q += `&source=eq.${eq(source)}`;
      return (await rest(q)).map(flat);
    },
    async addSegment(row) {
      const { id, source, status, createdAt, ...data } = row;
      await rest('segments', { method: 'POST', prefer: 'return=minimal', body: { id, source, status, created_at: createdAt, data } });
    },
    async setStatus(id, status) {
      if (!UUID.test(id)) return false;
      const r = await rest(`segments?id=eq.${eq(id)}`, { method: 'PATCH', prefer: 'return=representation', body: { status } }); return r.length > 0;
    },
    async deleteSegment(id) {
      if (!UUID.test(id)) return false;
      const r = await rest(`segments?id=eq.${eq(id)}`, { method: 'DELETE', prefer: 'return=representation' }); return r.length > 0;
    },
    async embeds() { return (await rest('embeds?select=id,url,added_at&order=added_at.asc')).map((e) => ({ id: e.id, url: e.url, addedAt: e.added_at })); },
    async addEmbed(e) {
      if ((await rest(`embeds?select=id&id=eq.${eq(e.id)}`)).length) return false;
      await rest('embeds', { method: 'POST', prefer: 'return=minimal', body: { id: e.id, url: e.url } }); return true;
    },
    async deleteEmbed(id) { await rest(`embeds?id=eq.${eq(id)}`, { method: 'DELETE', prefer: 'return=minimal' }); },
    async bump(k, limit) {
      try { return (await rest('rpc/bump_limit', { method: 'POST', body: { p_key: k, p_lim: limit } })) === true; }
      catch (e) { console.error('bump_limit', e.message); return false; }   // ante la duda, no gastar
    },
  };
}
