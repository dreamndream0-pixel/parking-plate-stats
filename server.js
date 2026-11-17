// 停車場車牌進出統計 — 伺服器
// 啟動：npm start（需要 .env 裡的 ANTHROPIC_API_KEY）；npm run mock（不呼叫 AI，測試用）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createStore } from './lib/store.js';
import { pairSessions, resolveDirections, normalizePlate } from './lib/pairing.js';
import { recognizePlates, mockRecognize } from './lib/recognize.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');

const MOCK = process.argv.includes('--mock');
const PORT = Number(process.env.PORT) || 3000;
const PASSWORD = process.env.APP_PASSWORD || '';

if (!MOCK && !process.env.ANTHROPIC_API_KEY) {
  console.warn('⚠ 沒有設定 ANTHROPIC_API_KEY，上傳照片時 AI 辨識會失敗。請建立 .env（參考 .env.example），或用 npm run mock 測試。');
}

// ---------- 資料存放（本機 SQLite 或 Supabase） ----------
const store = await createStore(DATA);
const allEvents = () => store.allEvents();

// ---------- 小工具 ----------
function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body) || typeof body === 'string';
  res.writeHead(status, {
    'Content-Type': isBuf ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(isBuf ? body : JSON.stringify(body));
}

async function readJson(req, limit = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('照片太大'), { status: 413 });
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function authorized(req, url) {
  if (!PASSWORD) return true;
  const given = req.headers['x-app-password'] || url.searchParams.get('k') || '';
  const a = Buffer.from(String(given));
  const b = Buffer.from(PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function inRange(iso, from, to) {
  return (!from || iso >= from) && (!to || iso < to);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

function serveFile(res, base, rel) {
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---------- API ----------
async function handleApi(req, res, url) {
  // 給 UptimeRobot 定時連線：讓 Render 不休眠，也順便讀一下資料庫讓 Supabase 不被暫停（不需要密碼、不回傳任何資料）
  if (url.pathname === '/api/health') {
    try {
      await store.ping();
      return send(res, 200, { ok: true });
    } catch (err) {
      console.error('health check 失敗：', err);
      return send(res, 503, { ok: false });
    }
  }

  if (!authorized(req, url) && url.pathname !== '/api/config') return send(res, 401, { error: '密碼錯誤' });

  // 前端設定
  if (url.pathname === '/api/config') return send(res, 200, { needPassword: !!PASSWORD, mock: MOCK });

  // 上傳照片 → AI 辨識 → 存事件
  if (url.pathname === '/api/upload' && req.method === 'POST') {
    const body = await readJson(req);
    const { image, direction, takenAt, timeSource = 'upload', filename = '', gate = '' } = body;
    if (!image) return send(res, 400, { error: '沒有照片' });
    if (!['in', 'out'].includes(direction)) return send(res, 400, { error: '請選擇進場或出場' });
    const t = takenAt && !Number.isNaN(Date.parse(takenAt)) ? new Date(takenAt).toISOString() : new Date().toISOString();
    const src = takenAt ? timeSource : 'upload';

    const m = String(image).match(/^data:(image\/[a-z+]+);base64,(.+)$/);
    const mediaType = m ? m[1] : 'image/jpeg';
    const b64 = m ? m[2] : String(image);
    const buf = Buffer.from(b64, 'base64');

    const photo = `${t.slice(0, 10)}/${t.replace(/[:.]/g, '-')}_${crypto.randomBytes(3).toString('hex')}.jpg`;
    let ai;
    try {
      ai = MOCK ? mockRecognize(filename) : await recognizePlates(b64, mediaType);
    } catch (err) {
      console.error('AI 辨識失敗：', err);
      return send(res, 502, { error: `AI 辨識失敗：${err.message}` });
    }

    // 只記錄最主要（最近、最大）的那台車，背景停著的車不算
    const main = ai.plates.slice(0, 1);

    // 同一車牌 2 分鐘內已有紀錄 → 視為重複照片，不再記一次
    const all = await allEvents();
    const tMs = Date.parse(t);
    const dup = main.length && all.find((e) => e.plate === main[0].plate && Math.abs(Date.parse(e.taken_at) - tMs) < 2 * 60 * 1000);
    if (dup) {
      return send(res, 200, {
        events: [],
        duplicate: `${main[0].plate} 在 ${new Date(dup.taken_at).toLocaleTimeString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' })} 已經有紀錄，這張視為重複照片，沒有記錄`,
        note: ai.note, takenAt: t, timeSource: src,
      });
    }

    // 有辨識到車牌才存照片，免得占用資料庫空間
    if (main.length) await store.savePhoto(photo, buf);
    const inserted = [];
    for (const p of main) {
      inserted.push(await store.insertEvent({
        plate: p.plate, direction, taken_at: t, time_source: src, photo,
        confidence: p.confidence, vehicle: p.vehicle || '', ai_plate: p.plate, gate,
      }));
    }
    const dirs = resolveDirections(await allEvents());
    const created = inserted.map((e) => ({ ...e, resolved: dirs.get(e.id) }));
    return send(res, 200, { events: created, note: ai.note, takenAt: t, timeSource: src, photo });
  }

  // 修改事件（改車牌 / 改方向 / 改時間）
  let m = url.pathname.match(/^\/api\/events\/(\d+)$/);
  if (m && req.method === 'PATCH') {
    const id = Number(m[1]);
    const body = await readJson(req, 100_000);
    const e = await store.getEvent(id);
    if (!e) return send(res, 404, { error: '找不到' });
    const plate = body.plate != null ? normalizePlate(body.plate) : e.plate;
    const direction = ['in', 'out'].includes(body.direction) ? body.direction : e.direction;
    const taken_at = body.takenAt && !Number.isNaN(Date.parse(body.takenAt)) ? new Date(body.takenAt).toISOString() : e.taken_at;
    if (!plate) return send(res, 400, { error: '車牌不能空白' });
    const fields = { plate, direction };
    if (taken_at !== e.taken_at) Object.assign(fields, { taken_at, time_source: 'manual' });
    await store.updateEvent(id, fields);
    return send(res, 200, { ok: true });
  }
  if (m && req.method === 'DELETE') {
    const gone = await store.deleteEvent(Number(m[1]));
    if (gone) await store.deletePhotoIfUnused(gone.photo);
    return send(res, 200, { ok: true });
  }

  // 事件列表（每張照片）
  if (url.pathname === '/api/events' && req.method === 'GET') {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const q = normalizePlate(url.searchParams.get('plate') || '');
    const events = await allEvents();
    const dirs = resolveDirections(events);
    const list = events
      .filter((e) => inRange(e.taken_at, from, to) && (!q || e.plate.includes(q)))
      .map((e) => ({ ...e, resolved: dirs.get(e.id) }))
      .reverse();
    return send(res, 200, { events: list });
  }

  // 統計 + 停車紀錄
  if (url.pathname === '/api/stats' && req.method === 'GET') {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const q = normalizePlate(url.searchParams.get('plate') || '');
    const sessions = pairSessions(await allEvents());
    const touches = (s) => (s.entry_time && inRange(s.entry_time, from, to)) || (s.exit_time && inRange(s.exit_time, from, to));
    const list = sessions.filter((s) => touches(s) && (!q || s.plate.includes(q)));

    const entries = sessions.filter((s) => s.entry_time && inRange(s.entry_time, from, to)).length;
    const exits = sessions.filter((s) => s.exit_time && inRange(s.exit_time, from, to)).length;
    const insideNow = sessions.filter((s) => s.status === 'inside').length;
    const done = list.filter((s) => s.duration_min != null);
    const avg = done.length ? Math.round(done.reduce((a, s) => a + s.duration_min, 0) / done.length) : null;

    // 每小時進/出（給圖表用；小時以伺服器時區計算，前端會用自己的時區重算）
    return send(res, 200, {
      summary: {
        entries,
        exits,
        insideNow,
        uniquePlates: new Set(list.map((s) => s.plate)).size,
        avgDurationMin: avg,
        missingExit: list.filter((s) => s.status === 'missing_exit').length,
        missingEntry: list.filter((s) => s.status === 'missing_entry').length,
      },
      sessions: list,
    });
  }

  // 匯出 CSV
  if (url.pathname === '/api/export.csv' && req.method === 'GET') {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const tz = url.searchParams.get('tz') || 'Asia/Taipei';
    const fmt = (iso) => (iso ? new Date(iso).toLocaleString('zh-TW', { timeZone: tz, hour12: false }) : '');
    const statusText = { done: '已出場', inside: '在場內', missing_exit: '缺出場紀錄', missing_entry: '缺進場紀錄' };
    const rows = pairSessions(await allEvents()).filter(
      (s) => (s.entry_time && inRange(s.entry_time, from, to)) || (s.exit_time && inRange(s.exit_time, from, to))
    );
    const lines = [['車牌', '進場時間', '出場時間', '停留(分鐘)', '狀態'].join(',')];
    for (const s of rows) lines.push([s.plate, fmt(s.entry_time), fmt(s.exit_time), s.duration_min ?? '', statusText[s.status]].map(csvCell).join(','));
    return send(res, 200, '﻿' + lines.join('\r\n'), {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="parking.csv"',
    });
  }

  return send(res, 404, { error: 'Not found' });
}

// ---------- 啟動 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname.startsWith('/photos/')) {
      if (!authorized(req, url)) return send(res, 401, '密碼錯誤');
      const img = await store.getPhoto(decodeURIComponent(url.pathname.slice(8)));
      if (!img) return send(res, 404, 'Not found');
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
      return res.end(img);
    }
    return serveFile(res, path.join(ROOT, 'public'), url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
  } catch (err) {
    console.error(err);
    send(res, err.status || 500, { error: err.message || '伺服器錯誤' });
  }
});

server.listen(PORT, () => {
  console.log(`停車統計系統已啟動：http://localhost:${PORT}（資料存放：${store.kind}）${MOCK ? '（模擬模式，不呼叫 AI）' : ''}`);
});
