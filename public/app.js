import { readExifDate } from './exif.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

let password = store.get('pw', '');

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-App-Password': password, ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    password = prompt('請輸入密碼') || '';
    store.set('pw', password);
    if (password) return api(path, opts);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `錯誤 ${res.status}`);
  return data;
}
const photoUrl = (p) => `/photos/${p}${password ? `?k=${encodeURIComponent(password)}` : ''}`;

// ---------- 時間格式 ----------
const pad = (n) => String(n).padStart(2, '0');
const fmtTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const fmtDur = (min) => {
  if (min == null) return '—';
  if (min < 60) return `${min} 分`;
  const h = Math.floor(min / 60);
  return h >= 24 ? `${Math.floor(h / 24)} 天 ${h % 24} 時` : `${h} 時 ${min % 60} 分`;
};
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayStartIso = (ymd) => new Date(`${ymd}T00:00:00`).toISOString();
const dayEndIso = (ymd) => { const d = new Date(`${ymd}T00:00:00`); d.setDate(d.getDate() + 1); return d.toISOString(); };
const toLocalInput = (iso) => { const d = new Date(iso); return `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };

const SRC_TEXT = { exif: '照片時間', camera: '拍照當下', file: '檔案時間', upload: '上傳時間', manual: '手動修改' };
const STATUS = {
  done: ['已出場', ''],
  inside: ['在場內', 'in'],
  missing_exit: ['缺出場紀錄', 'warn'],
  missing_entry: ['缺進場紀錄', 'warn'],
};

// ---------- 分頁 ----------
function showTab(name) {
  $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === name));
  $$('.panel').forEach((p) => (p.hidden = p.id !== `tab-${name}`));
  store.set('tab', name);
  if (name === 'stats') loadStats();
  if (name === 'events') loadEvents();
}
$$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---------- 方向 ----------
const DIR_HINT = {
  in: '在入口拍：全部記為進場。',
  out: '在出口拍：全部記為出場。',
  auto: '同一個出入口時使用：車子不在場內就算進場，已在場內就算出場。',
};
let direction = store.get('dir', 'auto');
function setDir(d) {
  direction = d;
  store.set('dir', d);
  $$('#dirSeg button').forEach((b) => b.classList.toggle('on', b.dataset.dir === d));
  $('#dirHint').textContent = DIR_HINT[d];
}
$$('#dirSeg button').forEach((b) => b.addEventListener('click', () => setDir(b.dataset.dir)));
setDir(direction);

// ---------- 上傳 ----------
// 縮圖到長邊 1600px 再上傳（省流量、AI 也看得清楚）
async function shrink(file, max = 1440) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
  if (!bmp) return { dataUrl: await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); }) };
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return { dataUrl: c.toDataURL('image/jpeg', 0.8) };
}

async function handleFiles(fileList, fromCamera) {
  const files = [...fileList];
  if (!files.length) return;
  // 先讀每張的拍攝時間，再依時間排序上傳
  const jobs = await Promise.all(files.map(async (file) => {
    const exif = await readExifDate(file);
    let takenAt, timeSource;
    if (exif) { takenAt = exif.date; timeSource = 'exif'; }
    else if (fromCamera) { takenAt = new Date(); timeSource = 'camera'; } // 剛拍的照片：現在就是拍攝時間
    else if (file.lastModified) { takenAt = new Date(file.lastModified); timeSource = 'file'; }
    else { takenAt = new Date(); timeSource = 'upload'; }
    return { file, takenAt, timeSource, dir: direction };
  }));
  jobs.sort((a, b) => a.takenAt - b.takenAt);

  const items = jobs.map((j) => {
    const li = document.createElement('li');
    li.className = 'item';
    li.innerHTML = `<img alt=""><div class="meta"><div class="small">${esc(fmtTime(j.takenAt.toISOString()))}・${SRC_TEXT[j.timeSource]}</div><div>辨識中…</div></div>`;
    $('img', li).src = URL.createObjectURL(j.file);
    $('#queue').prepend(li);
    return { ...j, li };
  });

  // 同時最多 3 張
  let i = 0;
  const worker = async () => { while (i < items.length) await uploadOne(items[i++]); };
  await Promise.all([worker(), worker(), worker()]);
}

async function uploadOne(job) {
  const meta = $('.meta', job.li);
  try {
    const { dataUrl } = await shrink(job.file);
    const r = await api('/api/upload', {
      method: 'POST',
      body: JSON.stringify({ image: dataUrl, direction: job.dir, takenAt: job.takenAt.toISOString(), timeSource: job.timeSource, filename: job.file.name }),
    });
    const head = `<div class="small">${esc(fmtTime(r.takenAt))}・${SRC_TEXT[r.timeSource] || ''}</div>`;
    if (!r.events.length) {
      meta.innerHTML = `${head}<div class="err">沒有辨識到車牌</div><div class="small">${esc(r.note)}</div>`;
      return;
    }
    meta.innerHTML = head + r.events.map(eventRow).join('');
    bindEventRows(meta);
  } catch (err) {
    meta.innerHTML = `<div class="err">上傳失敗：${esc(err.message)}</div>`;
    const retry = document.createElement('button');
    retry.className = 'btn sm';
    retry.textContent = '重試';
    retry.onclick = () => { meta.innerHTML = '<div>辨識中…</div>'; uploadOne(job); };
    meta.append(retry);
  }
}

$('#camInput').addEventListener('change', (e) => { handleFiles(e.target.files, true); e.target.value = ''; });
$('#pickInput').addEventListener('change', (e) => { handleFiles(e.target.files, false); e.target.value = ''; });

// 單筆事件：車牌（可改）、方向（可改）、時間、刪除
function eventRow(e) {
  const resolved = e.resolved || e.direction;
  const conf = e.confidence != null && e.confidence < 0.8 ? ' <span class="tag warn">請確認</span>' : '';
  return `<div class="ev" data-id="${e.id}">
    <div class="inline">
      <input class="plate-input" type="text" value="${esc(e.plate)}" aria-label="車牌">
      <span class="tag ${resolved}">${resolved === 'in' ? '進場' : '出場'}</span>${conf}
    </div>
    <div class="inline small">
      <select aria-label="方向">
        <option value="auto" ${e.direction === 'auto' ? 'selected' : ''}>自動</option>
        <option value="in" ${e.direction === 'in' ? 'selected' : ''}>進場</option>
        <option value="out" ${e.direction === 'out' ? 'selected' : ''}>出場</option>
      </select>
      ${e.vehicle ? esc(e.vehicle) : ''}
      ${e.ai_plate && e.ai_plate !== e.plate ? `・AI 原判：${esc(e.ai_plate)}` : ''}
    </div>
  </div>`;
}

function bindEventRows(root, onChange) {
  $$('.ev', root).forEach((row) => {
    const id = row.dataset.id;
    const save = async (patch) => {
      try { await api(`/api/events/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }); onChange?.(); }
      catch (err) { alert(err.message); }
    };
    const input = $('.plate-input', row);
    input.addEventListener('change', () => save({ plate: input.value }));
    $('select', row).addEventListener('change', (e) => save({ direction: e.target.value }));
  });
}

// ---------- 統計 ----------
function setRange(kind) {
  const today = new Date();
  const d = (n) => { const x = new Date(today); x.setDate(x.getDate() + n); return localDate(x); };
  if (kind === 'today') { $('#fromDate').value = d(0); $('#toDate').value = d(0); }
  if (kind === 'yesterday') { $('#fromDate').value = d(-1); $('#toDate').value = d(-1); }
  if (kind === '7d') { $('#fromDate').value = d(-6); $('#toDate').value = d(0); }
  if (kind === 'all') { $('#fromDate').value = ''; $('#toDate').value = ''; }
  loadStats();
}
$$('[data-range]').forEach((b) => b.addEventListener('click', () => setRange(b.dataset.range)));
['#fromDate', '#toDate'].forEach((s) => $(s).addEventListener('change', loadStats));
let qTimer;
$('#plateQ').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(loadStats, 300); });

function rangeParams() {
  const p = new URLSearchParams();
  const f = $('#fromDate').value, t = $('#toDate').value;
  if (f) p.set('from', dayStartIso(f));
  if (t) p.set('to', dayEndIso(t));
  return p;
}

async function loadStats() {
  const p = rangeParams();
  if ($('#plateQ').value.trim()) p.set('plate', $('#plateQ').value.trim());
  const csv = rangeParams();
  csv.set('tz', Intl.DateTimeFormat().resolvedOptions().timeZone);
  if (password) csv.set('k', password);
  $('#csvBtn').href = `/api/export.csv?${csv}`;

  let data;
  try { data = await api(`/api/stats?${p}`); } catch (err) { $('#anomaly').textContent = err.message; return; }
  const s = data.summary;
  $('#kIn').textContent = s.entries;
  $('#kOut').textContent = s.exits;
  $('#kInside').textContent = s.insideNow;
  $('#kAvg').textContent = s.avgDurationMin == null ? '—' : fmtDur(s.avgDurationMin);
  const warn = [];
  if (s.missingExit) warn.push(`${s.missingExit} 筆缺出場紀錄`);
  if (s.missingEntry) warn.push(`${s.missingEntry} 筆缺進場紀錄`);
  $('#anomaly').textContent = `共 ${s.uniquePlates} 台車` + (warn.length ? `；${warn.join('、')}（可能漏拍或車牌認錯，請到「照片紀錄」檢查）` : '');

  // 每小時圖表（用本機時區）
  const from = p.get('from'), to = p.get('to');
  const inR = (iso) => iso && (!from || iso >= from) && (!to || iso < to);
  const hin = Array(24).fill(0), hout = Array(24).fill(0);
  for (const x of data.sessions) {
    if (inR(x.entry_time)) hin[new Date(x.entry_time).getHours()]++;
    if (inR(x.exit_time)) hout[new Date(x.exit_time).getHours()]++;
  }
  const max = Math.max(1, ...hin, ...hout);
  $('#chart').innerHTML = hin.map((n, h) =>
    `<div class="h" data-h="${h}" title="${h}:00 進 ${n}／出 ${hout[h]}"><div class="b in" style="height:${(n / max) * 100}%"></div><div class="b out" style="height:${(hout[h] / max) * 100}%"></div></div>`
  ).join('');

  $('#sessBody').innerHTML = data.sessions.map((x) => {
    const [txt, cls] = STATUS[x.status];
    const link = (iso, photo) => (iso ? `<a href="#" data-photo="${esc(photo)}">${esc(fmtTime(iso))}</a>` : '—');
    return `<tr>
      <td><span class="plate">${esc(x.plate)}</span></td>
      <td>${link(x.entry_time, x.entry_photo)}</td>
      <td>${link(x.exit_time, x.exit_photo)}</td>
      <td>${fmtDur(x.duration_min)}</td>
      <td><span class="tag ${cls}">${txt}</span></td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" class="small">這段期間沒有資料</td></tr>';
}

// ---------- 照片紀錄 ----------
$('#evDate').value = localDate(new Date());
$('#evDate').addEventListener('change', loadEvents);
let eTimer;
$('#evQ').addEventListener('input', () => { clearTimeout(eTimer); eTimer = setTimeout(loadEvents, 300); });

async function loadEvents() {
  const p = new URLSearchParams();
  const d = $('#evDate').value;
  if (d) { p.set('from', dayStartIso(d)); p.set('to', dayEndIso(d)); }
  if ($('#evQ').value.trim()) p.set('plate', $('#evQ').value.trim());
  const { events } = await api(`/api/events?${p}`);
  const list = $('#evList');
  list.innerHTML = events.map((e) => `<li class="item">
      <img src="${esc(photoUrl(e.photo))}" data-photo="${esc(e.photo)}" alt="" loading="lazy">
      <div class="meta">
        <div class="inline small">
          <input type="datetime-local" step="1" value="${toLocalInput(e.taken_at)}" data-time="${e.id}" aria-label="拍攝時間">
          ${SRC_TEXT[e.time_source] || ''}
        </div>
        ${eventRow(e)}
        <div><button class="btn sm" data-del="${e.id}">刪除</button></div>
      </div>
    </li>`).join('') || '<li class="small">這天沒有照片</li>';
  bindEventRows(list, loadEvents);
  $$('[data-time]', list).forEach((inp) => inp.addEventListener('change', async () => {
    try { await api(`/api/events/${inp.dataset.time}`, { method: 'PATCH', body: JSON.stringify({ takenAt: new Date(inp.value).toISOString() }) }); loadEvents(); }
    catch (err) { alert(err.message); }
  }));
  $$('[data-del]', list).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('確定刪除這筆紀錄？')) return;
    await api(`/api/events/${b.dataset.del}`, { method: 'DELETE' });
    loadEvents();
  }));
}

// ---------- 點照片放大 ----------
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-photo]');
  if (!el) return;
  e.preventDefault();
  $('#photoDlg img').src = photoUrl(el.dataset.photo);
  $('#photoDlg').showModal();
});

// ---------- 啟動 ----------
api('/api/config').then((c) => { $('#mockBadge').hidden = !c.mock; });
setRange('today');
showTab(store.get('tab', 'upload'));
