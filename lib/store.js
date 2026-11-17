// 資料存放：有設定 SUPABASE_URL 就存 Supabase（上線用），否則存本機 SQLite＋照片資料夾（開發用）。
import fs from 'node:fs';
import path from 'node:path';

const iso = (v) => (v ? new Date(v).toISOString() : v);
const normalize = (e) => (e ? { ...e, id: Number(e.id), taken_at: iso(e.taken_at), created_at: iso(e.created_at) } : e);

export async function createStore(dataDir) {
  if (process.env.SUPABASE_URL) return supabaseStore();
  return sqliteStore(dataDir);
}

// ---------- Supabase（PostgREST） ----------
function supabaseStore() {
  const base = process.env.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1';
  const key = process.env.SUPABASE_KEY;
  const secret = process.env.SUPABASE_APP_SECRET;
  if (!key || !secret) throw new Error('使用 Supabase 需要 SUPABASE_KEY 和 SUPABASE_APP_SECRET');

  async function rest(pathAndQuery, { method = 'GET', body, headers = {} } = {}) {
    const res = await fetch(base + pathAndQuery, {
      method,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'x-app-secret': secret,
        'Content-Type': 'application/json',
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }

  return {
    kind: 'supabase',
    async ping() {
      await rest('/events?select=id&limit=1');
    },
    async insertEvent(row) {
      const [e] = await rest('/events', { method: 'POST', body: row, headers: { Prefer: 'return=representation' } });
      return normalize(e);
    },
    async getEvent(id) {
      const [e] = await rest(`/events?id=eq.${Number(id)}&select=*`);
      return normalize(e);
    },
    async allEvents() {
      const out = [];
      const page = 1000; // PostgREST 一次最多回 1000 筆
      for (let offset = 0; ; offset += page) {
        const rows = await rest(`/events?select=*&order=taken_at.asc,id.asc&limit=${page}&offset=${offset}`);
        out.push(...rows.map(normalize));
        if (rows.length < page) return out;
      }
    },
    async updateEvent(id, fields) {
      await rest(`/events?id=eq.${Number(id)}`, { method: 'PATCH', body: fields });
    },
    async deleteEvent(id) {
      const rows = await rest(`/events?id=eq.${Number(id)}`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
      return normalize(rows[0]);
    },
    async savePhoto(name, buf) {
      await rest('/rpc/put_photo', { method: 'POST', body: { p_name: name, p_b64: buf.toString('base64') } });
    },
    async getPhoto(name) {
      const b64 = await rest('/rpc/get_photo', { method: 'POST', body: { p_name: name } });
      return b64 ? Buffer.from(b64, 'base64') : null;
    },
    async deletePhotoIfUnused(name) {
      await rest('/rpc/delete_photo_if_unused', { method: 'POST', body: { p_name: name } });
    },
  };
}

// ---------- 本機 SQLite ----------
async function sqliteStore(dataDir) {
  const { DatabaseSync } = await import('node:sqlite');
  const photos = path.join(dataDir, 'photos');
  fs.mkdirSync(photos, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'parking.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plate TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('in','out','auto')),
      taken_at TEXT NOT NULL,
      time_source TEXT NOT NULL,
      photo TEXT NOT NULL,
      confidence REAL,
      vehicle TEXT,
      ai_plate TEXT,
      gate TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_events_plate ON events(plate, taken_at);
    CREATE INDEX IF NOT EXISTS idx_events_time ON events(taken_at);
  `);
  const photoPath = (name) => {
    const p = path.normalize(path.join(photos, name));
    if (!p.startsWith(photos)) throw new Error('bad photo name');
    return p;
  };
  const get = (id) => normalize(db.prepare('SELECT * FROM events WHERE id = ?').get(Number(id)));

  return {
    kind: 'sqlite',
    async ping() {
      db.prepare('SELECT 1').get();
    },
    async insertEvent(r) {
      const res = db
        .prepare('INSERT INTO events (plate, direction, taken_at, time_source, photo, confidence, vehicle, ai_plate, gate) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(r.plate, r.direction, r.taken_at, r.time_source, r.photo, r.confidence ?? null, r.vehicle ?? '', r.ai_plate ?? '', r.gate ?? '');
      return get(res.lastInsertRowid);
    },
    async getEvent(id) {
      return get(id);
    },
    async allEvents() {
      return db.prepare('SELECT * FROM events ORDER BY taken_at, id').all().map(normalize);
    },
    async updateEvent(id, f) {
      const cols = Object.keys(f);
      if (!cols.length) return;
      db.prepare(`UPDATE events SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => f[c]), Number(id));
    },
    async deleteEvent(id) {
      const e = get(id);
      db.prepare('DELETE FROM events WHERE id = ?').run(Number(id));
      return e;
    },
    async savePhoto(name, buf) {
      const p = photoPath(name);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, buf);
    },
    async getPhoto(name) {
      const p = photoPath(name);
      return fs.existsSync(p) ? fs.readFileSync(p) : null;
    },
    async deletePhotoIfUnused(name) {
      const used = db.prepare('SELECT 1 FROM events WHERE photo = ? LIMIT 1').get(name);
      if (!used) fs.rmSync(photoPath(name), { force: true });
    },
  };
}
