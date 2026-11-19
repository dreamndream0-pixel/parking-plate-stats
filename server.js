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
import { buildMatcher, normalizeMask, readMonthlyList } from './lib/monthly.js';
import { summarizeFees, dailyReport, isRough, DEFAULT_RATE, DEFAULT_FREE_MIN } from './lib/fees.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');

const MOCK = process.argv.includes('--mock');
const PORT = Number(process.env.PORT) || 3000;
const PASSWORD = process.env.APP_PASSWORD || '';
// 「合計」（收費金額）另外一道密碼
const FEE_PASSWORD = process.env.FEE_PASSWORD || '12345';

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

// 新增的紀錄是不是重複的：已在場內又記進場 → 確認在場；已出場又記出場 → 重複出場
// 月租名單比對器（每次查詢重讀名單，名單很小）
const monthlyMatcher = async () => buildMatcher(await store.listMonthly());

async function describe(inserted) {
  const events = await allEvents();
  const monthly = await monthlyMatcher();
  const dirs = resolveDirections(events);
  const sessions = pairSessions(events);
  const hhmm = (iso) => new Date(iso).toLocaleTimeString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' });
  return inserted.map((e) => {
    const resolved = dirs.get(e.id);
    let repeat = '';
    if (resolved === 'recheck') {
      const s = sessions.find((x) => x.checks.some((c) => c.id === e.id));
      repeat = `重複：${e.plate} 在 ${hhmm(s.entry_time)} 已進場，確認還在場內`;
    } else if (resolved === 'repeat_out') {
      const s = sessions.find((x) => x.repeat_exits.some((c) => c.id === e.id));
      repeat = `重複：${e.plate} 在 ${hhmm(s.exit_time)} 已出場`;
    }
    return { ...e, resolved, repeat, monthly: monthly(e.plate) };
  });
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

  // ---------- 員工暫時離開（空檔）→ 回來盤點 ----------
  // 流程：start（離開）→ return（回來，開始盤點拍照）→ finish（盤點完成，系統比對）
  if (url.pathname === '/api/gap' && req.method === 'GET') {
    return send(res, 200, { gap: await store.openGap() });
  }
  if (url.pathname === '/api/gap/start' && req.method === 'POST') {
    const open = await store.openGap();
    if (open) return send(res, 200, { gap: open });
    return send(res, 200, { gap: await store.insertGap({ start_at: new Date().toISOString() }) });
  }
  if (url.pathname === '/api/gap/cancel' && req.method === 'POST') {
    const open = await store.openGap();
    if (open && !open.end_at) await store.updateGap(open.id, { end_at: open.start_at, audit_done: true });
    return send(res, 200, { gap: null });
  }
  if (url.pathname === '/api/gap/return' && req.method === 'POST') {
    const open = await store.openGap();
    if (!open) return send(res, 400, { error: '目前沒有離開中的紀錄' });
    if (!open.end_at) await store.updateGap(open.id, { end_at: new Date().toISOString() });
    return send(res, 200, { gap: await store.getGap(open.id) });
  }
  if (url.pathname === '/api/gap/finish' && req.method === 'POST') {
    const open = await store.openGap();
    if (!open || !open.end_at) return send(res, 400, { error: '還沒按「回來」' });
    const events = await allEvents();
    // 系統說在場內，但回來後沒再拍到 → 空檔期間出場（時間介於最後看到／離開時間 和 回來時間之間）
    // 盤點照片是用相機 App 先拍好再從相簿選的，拍攝時間可能早於按「回來」，所以用「這次盤點有沒有拍到」來判斷
    const audited = new Set(events.filter((e) => e.gap_id === open.id).map((e) => e.plate));
    const gone = pairSessions(events).filter((s) => s.status === 'inside' && s.last_seen < open.end_at && !audited.has(s.plate));
    const exited = [];
    for (const s of gone) {
      const from = s.last_seen > open.start_at ? s.last_seen : open.start_at;
      await store.insertEvent({
        plate: s.plate, direction: 'out', taken_at: open.end_at, time_source: 'gap', photo: '',
        confidence: null, vehicle: '', ai_plate: '', gate: '', gap_id: open.id, estimated_from: from,
      });
      exited.push(s.plate);
    }
    // 盤點時拍到、但原本不在場內 → 空檔期間進場
    const entered = events.filter((e) => e.gap_id === open.id && e.estimated_from).map((e) => e.plate);
    await store.updateGap(open.id, { audit_done: true });
    return send(res, 200, { gap: { ...open, audit_done: true }, entered: [...new Set(entered)], exited });
  }

  // ---------- 月租名單 ----------
  if (url.pathname === '/api/monthly' && req.method === 'GET') {
    return send(res, 200, { rows: await store.listMonthly() });
  }
  if (url.pathname === '/api/monthly' && req.method === 'PUT') {
    const { rows = [] } = await readJson(req, 500_000);
    const clean = rows
      .map((r) => ({ mask: normalizeMask(r.mask), name: String(r.name || '').trim().slice(0, 30) }))
      .filter((r) => r.mask);
    await store.replaceMonthly(clean);
    return send(res, 200, { rows: await store.listMonthly() });
  }
  // 拍公告上的名單 → AI 讀出車號（不會直接存，讓人確認後再按儲存）
  if (url.pathname === '/api/monthly/read' && req.method === 'POST') {
    const { image } = await readJson(req);
    const m = String(image || '').match(/^data:(image\/[a-z+]+);base64,(.+)$/);
    if (!m) return send(res, 400, { error: '沒有照片' });
    if (MOCK) return send(res, 200, { rows: [{ no: 1, name: '林O華', mask: 'AQ***26' }, { no: 2, name: '翁O宗', mask: 'AU***00' }], note: '模擬模式' });
    try {
      return send(res, 200, await readMonthlyList(m[2], m[1]));
    } catch (err) {
      console.error('名單辨識失敗：', err);
      return send(res, 502, { error: `名單辨識失敗：${err.message}` });
    }
  }

  // 上傳照片 → AI 辨識 → 存事件
  if (url.pathname === '/api/upload' && req.method === 'POST') {
    const body = await readJson(req);
    const { image, direction, takenAt, timeSource = 'upload', filename = '', gate = '', gapId = null } = body;
    // 盤點中拍的照片：記在這次空檔底下
    const gap = gapId ? await store.getGap(gapId) : null;
    if (gapId && (!gap || !gap.end_at || gap.audit_done)) return send(res, 400, { error: '盤點已結束，請改用進場／出場按鈕' });
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

    // 有辨識到車牌才存照片，免得占用資料庫空間。重複拍的照片也照樣保存。
    if (main.length) await store.savePhoto(photo, buf);
    // 盤點時：這台車原本不在場內 → 是空檔期間進場的，進場時間推估為「離開時間～現在」
    const insideNow = gap ? new Set(pairSessions(await allEvents()).filter((s) => s.status === 'inside').map((s) => s.plate)) : null;
    const inserted = [];
    for (const p of main) {
      inserted.push(await store.insertEvent({
        plate: p.plate, direction, taken_at: t, time_source: src, photo,
        confidence: p.confidence, vehicle: p.vehicle || '', ai_plate: p.plate, gate,
        gap_id: gap ? gap.id : null,
        estimated_from: gap && !insideNow.has(p.plate) ? gap.start_at : null,
      }));
    }

    const created = await describe(inserted);
    return send(res, 200, { events: created, note: ai.note, model: ai.model, takenAt: t, timeSource: src, photo });
  }

  // 手動輸入車牌（沒有照片），時間用現在
  if (url.pathname === '/api/manual' && req.method === 'POST') {
    const { plate: raw, direction } = await readJson(req, 10_000);
    const plate = normalizePlate(raw);
    if (!plate) return send(res, 400, { error: '請輸入車牌' });
    if (!['in', 'out'].includes(direction)) return send(res, 400, { error: '請選擇進場或出場' });
    const t = new Date().toISOString();
    const e = await store.insertEvent({
      plate, direction, taken_at: t, time_source: 'typed', photo: '',
      confidence: null, vehicle: '', ai_plate: '', gate: '',
    });
    return send(res, 200, { events: await describe([e]), takenAt: t, timeSource: 'typed', photo: '' });
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
    const gapFilter = Number(url.searchParams.get('gap')) || null; // 只看某次盤點的照片
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const q = normalizePlate(url.searchParams.get('plate') || '');
    const events = await allEvents();
    const dirs = resolveDirections(events);
    const monthly = await monthlyMatcher();
    const list = events
      .filter((e) => inRange(e.taken_at, from, to) && (!q || e.plate.includes(q)) && (!gapFilter || e.gap_id === gapFilter))
      .map((e) => ({ ...e, resolved: dirs.get(e.id), monthly: monthly(e.plate) }))
      .reverse();
    return send(res, 200, { events: list });
  }

  // 統計 + 停車紀錄
  if (url.pathname === '/api/stats' && req.method === 'GET') {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const q = normalizePlate(url.searchParams.get('plate') || '');
    const monthly = await monthlyMatcher();
    const sessions = pairSessions(await allEvents()).map((s) => ({ ...s, monthly: monthly(s.plate) }));
    const touches = (s) => (s.entry_time && inRange(s.entry_time, from, to)) || (s.exit_time && inRange(s.exit_time, from, to));
    const list = sessions.filter((s) => touches(s) && (!q || s.plate.includes(q)));
    const entered = sessions.filter((s) => s.entry_time && inRange(s.entry_time, from, to));
    const inside = sessions.filter((s) => s.status === 'inside');

    const entries = sessions.filter((s) => s.entry_time && inRange(s.entry_time, from, to)).length;
    const exits = sessions.filter((s) => s.exit_time && inRange(s.exit_time, from, to)).length;
    const insideNow = sessions.filter((s) => s.status === 'inside').length;
    // 平均停留不算盤點推估的車（員工離開超過 30 分鐘，進場或出場時間不準）；只離開一下的照算
    const done = list.filter((s) => s.duration_min != null && !isRough(s));
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
        // 員工離開期間推估的進出（時間不精確）
        estimatedEntries: sessions.filter((s) => s.entry_estimated_from && inRange(s.entry_time, from, to)).length,
        estimatedExits: sessions.filter((s) => s.exit_estimated_from && inRange(s.exit_time, from, to)).length,
        // 月租／臨停（月租名單比對，中間 3 碼看不到，所以是「疑似月租」）
        monthlyEntries: entered.filter((s) => s.monthly).length,
        tempEntries: entered.filter((s) => !s.monthly).length,
        monthlyInside: inside.filter((s) => s.monthly).length,
        tempInside: inside.filter((s) => !s.monthly).length,
      },
      sessions: list,
    });
  }

  // 合計（臨停收費），要另外的合計密碼
  if (url.pathname === '/api/fees' && req.method === 'GET') {
    const given = Buffer.from(String(req.headers['x-fee-password'] || ''));
    const want = Buffer.from(FEE_PASSWORD);
    if (!(given.length === want.length && crypto.timingSafeEqual(given, want))) return send(res, 403, { error: '合計密碼錯誤' });
    const num = (k, d) => { const raw = url.searchParams.get(k); const v = Number(raw); return raw && Number.isFinite(v) && v >= 0 ? v : d; };
    const rate = num('rate', DEFAULT_RATE);
    const freeMin = num('free', DEFAULT_FREE_MIN);
    const monthly = await monthlyMatcher();
    const sessions = pairSessions(await allEvents()).map((s) => ({ ...s, monthly: monthly(s.plate) }));
    const now = Date.now();
    const from = url.searchParams.get('from'), to = url.searchParams.get('to');
    const result = summarizeFees(sessions, { from, to, now, rate, freeMin });
    const days = dailyReport(sessions, { from, to, now, rate, freeMin, tzOffsetMin: num('tzo', 480) });
    return send(res, 200, { rate, freeMin, now: new Date(now).toISOString(), ...result, days });
  }

  // 匯出 CSV
  if (url.pathname === '/api/export.csv' && req.method === 'GET') {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const tz = url.searchParams.get('tz') || 'Asia/Taipei';
    const fmt = (iso) => (iso ? new Date(iso).toLocaleString('zh-TW', { timeZone: tz, hour12: false }) : '');
    const statusText = { done: '已出場', inside: '在場內', missing_exit: '缺出場紀錄', missing_entry: '缺進場紀錄' };
    const monthly = await monthlyMatcher();
    const rows = pairSessions(await allEvents()).filter(
      (s) => (s.entry_time && inRange(s.entry_time, from, to)) || (s.exit_time && inRange(s.exit_time, from, to))
    );
    const lines = [['車牌', '類別', '月租名單', '進場時間', '出場時間', '停留(分鐘)', '狀態', '備註'].join(',')];
    for (const s of rows) {
      const note = [];
      if (s.entry_estimated_from) note.push(`員工離開期間進場：${fmt(s.entry_estimated_from)}～${fmt(s.entry_time)} 之間`);
      if (s.exit_estimated_from) note.push(`員工離開期間出場：${fmt(s.exit_estimated_from)}～${fmt(s.exit_time)} 之間`);
      if (s.checks.length) note.push(`重複拍 ${s.checks.length} 次`);
      const mm = monthly(s.plate);
      lines.push([s.plate, mm ? '月租' : '臨停', mm ? `${mm.mask} ${mm.names.join('/')}` : '', fmt(s.entry_time), fmt(s.exit_time), s.duration_min ?? '', statusText[s.status], note.join('；')].map(csvCell).join(','));
    }
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
