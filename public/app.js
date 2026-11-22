import { readExifDate } from './exif.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

// ---------- 搜尋框右邊的 × ----------
const X_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M8.5 8.5l7 7m0-7l-7 7" stroke="var(--card)" stroke-width="2" stroke-linecap="round"/></svg>';
$$('input[type="search"]').forEach((inp) => {
  const wrap = document.createElement('span');
  wrap.className = 'clearable';
  inp.before(wrap);
  wrap.append(inp);
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'clear-x';
  x.setAttribute('aria-label', '清除搜尋');
  x.innerHTML = X_SVG;
  wrap.append(x);
  const sync = () => { x.hidden = !inp.value; };
  inp.addEventListener('input', sync);
  sync();
  x.addEventListener('click', () => {
    inp.value = '';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.focus();
  });
});

// ---------- 日期按鈕：點開選起迄日 ----------
const CAL_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>';
const md = (s) => { const [, m, d] = s.split('-'); return `${+m}/${+d}`; };
function updateDateLabels() {
  $$('.datebtn[data-dates]').forEach((btn) => {
    const [f, t] = btn.dataset.dates.split(',').map((id) => $('#' + id).value);
    const text = !f && !t ? '全部日期' : f === t || !t ? md(f) : !f ? `～${md(t)}` : `${md(f)}～${md(t)}`;
    btn.innerHTML = `${CAL_SVG}<span>${text}</span>`;
  });
  $$('.datebtn.single').forEach((lab) => {
    const v = $('input', lab).value;
    $('.dlabel', lab).innerHTML = `${CAL_SVG}<span>${v ? md(v) : '選日期'}</span>`;
  });
}
let dateTarget = null;
$$('.datebtn[data-dates]').forEach((btn) => btn.addEventListener('click', () => {
  dateTarget = btn.dataset.dates.split(',').map((id) => $('#' + id));
  $('#dlgFrom').value = dateTarget[0].value;
  $('#dlgTo').value = dateTarget[1].value;
  $('#dateDlg').showModal();
}));
function applyDates(f, t) {
  if (f && !t) t = f;
  if (t && !f) f = t;
  if (f > t) [f, t] = [t, f];
  dateTarget[0].value = f;
  dateTarget[1].value = t;
  dateTarget[0].dispatchEvent(new Event('change'));
  updateDateLabels();
}
$('#dateForm').addEventListener('submit', () => applyDates($('#dlgFrom').value, $('#dlgTo').value));
$('#dlgClear').addEventListener('click', () => { applyDates('', ''); $('#dateDlg').close(); });
$('#dlgCancel').addEventListener('click', () => $('#dateDlg').close());
$('#dateDlg').addEventListener('click', (e) => { if (e.target.id === 'dateDlg') $('#dateDlg').close(); });

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

const SRC_TEXT = { typed: '手動輸入', gap: '系統推估', exif: '照片時間', camera: '拍照當下', file: '檔案時間', upload: '上傳時間', manual: '手動修改' };
const STATUS = {
  done: ['已出場', ''],
  inside: ['在場內', 'in'],
  missing_exit: ['缺出場紀錄', 'warn'],
  missing_entry: ['缺進場紀錄', 'warn'],
};

// ---------- 分頁 ----------
async function showTab(name) {
  closeMenu();
  // 合計要先輸入密碼，取消就留在原本的分頁
  if (name === 'fees' && !feePw && !(await askFeePw())) return;
  $$('.tabs > button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === name));
  $$('#menu button').forEach((b) => b.setAttribute('aria-current', b.dataset.tab === name));
  $('#menuBtn').classList.toggle('active', ['monthly', 'fees'].includes(name));
  $$('.panel').forEach((p) => (p.hidden = p.id !== `tab-${name}`));
  if (name !== 'fees') store.set('tab', name); // 合計不記住，下次打開網頁不會直接停在合計
  if (name === 'stats') loadStats();
  if (name === 'events') loadEvents();
  if (name === 'monthly') loadMonthly();
  if (name === 'fees') loadFees();
}
$$('.tabs > button, #menu button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---------- 漢堡選單 ----------
function closeMenu() { $('#menu').hidden = true; $('#menuBtn').setAttribute('aria-expanded', 'false'); }
$('#menuBtn').addEventListener('click', (ev) => {
  ev.stopPropagation();
  const open = $('#menu').hidden;
  $('#menu').hidden = !open;
  $('#menuBtn').setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', (ev) => { if (!ev.target.closest('.menu-wrap')) closeMenu(); });
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeMenu(); });

// ---------- 方向 ----------


// ---------- 上傳 ----------
// 縮圖到長邊 1280px、JPEG 品質 0.7 再上傳：實測 1280 辨識結果與原圖相同，1024 以下遠景車牌開始讀錯；stampDate 有值時把時間印在右下角
async function shrink(file, stampDate, max = 1280) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
  if (!bmp) return { dataUrl: await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); }) };
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  const g = c.getContext('2d');
  g.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  if (stampDate) stampTime(g, c.width, c.height, stampDate);
  return { dataUrl: c.toDataURL('image/jpeg', 0.7) };
}

function stampTime(g, w, h, d) {
  const text = `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const size = Math.max(16, Math.round(Math.min(w, h) * 0.045));
  g.font = `bold ${size}px ui-monospace, Menlo, Consolas, monospace`;
  g.textBaseline = 'bottom';
  const tw = g.measureText(text).width;
  const pad_ = Math.round(size * 0.35);
  const x = w - tw - pad_ * 3;
  const y = h - pad_ * 2;
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.fillRect(x - pad_, y - size - pad_ * 0.6, tw + pad_ * 2, size + pad_ * 1.4);
  g.fillStyle = '#ffd400';
  g.fillText(text, x, y);
}

async function handleFiles(fileList, fromCamera, direction, gapId = null) {
  const files = [...fileList];
  if (!files.length) return;
  // 先讀每張的拍攝時間，再依時間排序上傳
  const jobs = await Promise.all(files.map(async (file) => {
    // 即時拍照：用按下拍照的這一刻，並把時間印在照片上
    if (fromCamera) return { file, takenAt: new Date(), timeSource: 'camera', stamp: true, dir: direction, gapId };
    // 從相簿選：用照片裡隱藏的拍攝時間（EXIF）
    const exif = await readExifDate(file);
    if (exif) return { file, takenAt: exif.date, timeSource: 'exif', dir: direction, gapId };
    const takenAt = file.lastModified ? new Date(file.lastModified) : new Date();
    return { file, takenAt, timeSource: file.lastModified ? 'file' : 'upload', dir: direction, gapId };
  }));
  jobs.sort((a, b) => a.takenAt - b.takenAt);

  const items = jobs.map((j) => {
    const li = document.createElement('li');
    li.className = 'item';
    li.innerHTML = `<img alt=""><div class="meta"><div class="small">${esc(fmtTime(j.takenAt.toISOString()))}・${SRC_TEXT[j.timeSource]}</div><div>辨識中…</div></div>`;
    const img = $('img', li);
    img.src = URL.createObjectURL(j.file);
    img.dataset.src = img.src; // 上傳前先能放大看原圖
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
    const { dataUrl } = await shrink(job.file, job.stamp ? job.takenAt : null);
    const r = await api('/api/upload', {
      method: 'POST',
      body: JSON.stringify({ image: dataUrl, direction: job.dir, takenAt: job.takenAt.toISOString(), timeSource: job.timeSource, filename: job.file.name, gapId: job.gapId }),
    });
    let head = `<div class="small">${esc(fmtTime(r.takenAt))}・${SRC_TEXT[r.timeSource] || ''}</div>`;
    if (r.timeSource === 'file' || r.timeSource === 'upload') {
      head += `<div class="warnbox">⚠ 照片裡沒有拍攝時間，這是選取照片的時間，可能不準，請到「照片紀錄」修正</div>`;
    }
    if (!r.events.length) {
      meta.innerHTML = `${head}<div class="err">沒有辨識到車牌</div><div class="small">${esc(r.note)}</div>`;
      return;
    }
    const render = () => {
      meta.innerHTML = head + r.events.map(eventRow).join('');
      bindEventRows(meta);
    };
    render();
    // 上傳完成後改成顯示系統存下的照片（拍照的會有時間浮水印）
    const img = $('img', job.li);
    img.dataset.photo = r.photo;
    delete img.dataset.src;
    img.src = photoUrl(r.photo);
    if (job.gapId) { auditCount += r.events.length; renderGap(); }
    // 車子已在場內又拍了進場 → 跳通知問要不要改成出場
    for (const e of r.events) {
      if (e.resolved !== 'recheck' || job.gapId) continue;
      askRepeat(e, r.photo).then(async (toExit) => {
        if (!toExit) return;
        await api(`/api/events/${e.id}`, { method: 'PATCH', body: JSON.stringify({ direction: 'out' }) });
        Object.assign(e, { direction: 'out', resolved: 'out', repeat: '已改為出場' });
        render();
      }).catch((err) => alert(err.message));
    }
  } catch (err) {
    meta.innerHTML = `<div class="err">上傳失敗：${esc(err.message)}</div>`;
    const retry = document.createElement('button');
    retry.className = 'btn sm';
    retry.textContent = '重試';
    retry.onclick = () => { meta.innerHTML = '<div>辨識中…</div>'; uploadOne(job); };
    meta.append(retry);
  }
}

// 「車號已在場內」通知：一次跳一個，多張時依序排隊
let askChain = Promise.resolve();
function askRepeat(e, photo) {
  const ask = () => new Promise((resolve) => {
    const dlg = $('#repeatDlg');
    $('#repeatMsg').textContent = e.repeat || `${e.plate} 已在場內`;
    $('#repeatPlate').textContent = e.plate;
    $('#repeatImg').hidden = !photo;
    if (photo) $('#repeatImg').src = photoUrl(photo);
    const done = (v) => { dlg.close(); resolve(v); };
    $('#repeatToOut').onclick = () => done(true);
    $('#repeatKeep').onclick = () => done(false);
    dlg.oncancel = () => resolve(false);
    dlg.showModal();
    navigator.vibrate?.(200);
  });
  const p = askChain.then(ask);
  askChain = p.catch(() => {});
  return p;
}

$$('.camInput').forEach((inp) => inp.addEventListener('change', (e) => { handleFiles(e.target.files, true, inp.dataset.dir); e.target.value = ''; }));
$$('.pickInput').forEach((inp) => inp.addEventListener('change', (e) => { handleFiles(e.target.files, false, inp.dataset.dir); e.target.value = ''; }));

// 單筆事件：車牌（可改）、方向（可改）、時間、刪除
const RESOLVED = {
  in: ['進場', 'in'],
  out: ['出場', 'out'],
  recheck: ['重複・確認在場內', 'in'],
  repeat_out: ['重複出場', 'out'],
};
function eventRow(e) {
  const resolved = e.resolved || e.direction;
  const [label, cls] = RESOLVED[resolved] || RESOLVED.in;
  // 下拉選單顯示照片原本是按「進場」還是「出場」拍的
  const dir = e.direction === 'out' || (e.direction === 'auto' && (resolved === 'out' || resolved === 'repeat_out')) ? 'out' : 'in';
  const conf = e.confidence != null && e.confidence < 0.8 ? ' <span class="tag warn">請確認</span>' : '';
  const est = e.estimated_from
    ? `<div class="small"><span class="tag est">員工離開期間</span> 實際${cls === 'out' ? '出場' : '進場'}時間在 ${esc(fmtTime(e.estimated_from))}～${esc(fmtTime(e.taken_at))} 之間</div>`
    : '';
  return `<div class="ev" data-id="${e.id}">
    <div class="inline">
      <input class="plate-input" type="text" value="${esc(e.plate)}" aria-label="車牌">
      <span class="tag ${cls}">${label}</span>${conf}${monthlyTag(e.monthly)}
    </div>
    ${e.repeat ? `<div class="small">${esc(e.repeat)}</div>` : ''}
    ${est}
    <div class="inline small">
      <select aria-label="方向">
        <option value="in" ${dir === 'in' ? 'selected' : ''}>進場</option>
        <option value="out" ${dir === 'out' ? 'selected' : ''}>出場</option>
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
  updateDateLabels();
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
  $('#kAvg').textContent = s.avgDurationMin == null ? '—' : s.avgDurationMin < 60 ? `${s.avgDurationMin}分` : `${(s.avgDurationMin / 60).toFixed(1)}時`;
  $('#kMonthly').textContent = s.monthlyEntries;
  $('#kMonthlySub').textContent = `在場 ${s.monthlyInside}`;
  $('#kTemp').textContent = s.tempEntries;
  $('#kTempSub').textContent = `在場 ${s.tempInside}`;
  const warn = [];
  if (s.missingExit) warn.push(`${s.missingExit} 筆缺出場紀錄`);
  if (s.missingEntry) warn.push(`${s.missingEntry} 筆缺進場紀錄`);
  // 每小時圖表（用本機時區）
  const from = p.get('from'), to = p.get('to');
  const inR = (iso) => iso && (!from || iso >= from) && (!to || iso < to);

  // 重複拍的照片（在場內又拍進場、出場後又拍出場）不算進出場次數
  const repeats = data.sessions.reduce((n, x) => n + x.checks.filter((c) => inR(c.time)).length + x.repeat_exits.filter((c) => inR(c.time)).length, 0);
  $('#anomaly').textContent = `共 ${s.uniquePlates} 台車`
    + (repeats ? `；另有 ${repeats} 張重複拍的照片（不算進出場）` : '')
    + `；進場中月租 ${s.monthlyEntries} 台、臨停 ${s.tempEntries} 台；目前在場月租 ${s.monthlyInside}、臨停 ${s.tempInside}`
    + (s.estimatedEntries || s.estimatedExits ? `；員工離開期間推估：進場 ${s.estimatedEntries} 台、出場 ${s.estimatedExits} 台（時間不精確）` : '')
    + (warn.length ? `；${warn.join('、')}（可能漏拍或車牌認錯，請到「照片紀錄」檢查）` : '');
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
    const link = (iso, photo, estFrom) => {
      if (!iso) return '—';
      if (estFrom) return `<span class="tag est">推估</span> ${esc(fmtTime(estFrom))}<br>～${photo ? `<a href="#" data-photo="${esc(photo)}">${esc(fmtTime(iso).slice(6))}</a>` : esc(fmtTime(iso).slice(6))}`;
      return photo ? `<a href="#" data-photo="${esc(photo)}">${esc(fmtTime(iso))}</a>` : esc(fmtTime(iso));
    };
    // 在場內重複拍到的次數，最後一次可點開看照片
    const last = x.checks?.[x.checks.length - 1];
    const checks = last ? `<div class="small">重複拍 ${x.checks.length} 次・最後 <a href="#" data-photo="${esc(last.photo)}">${esc(fmtTime(last.time).slice(6))}</a></div>` : '';
    return `<tr>
      <td><span class="plate">${esc(x.plate)}</span><div>${monthlyTag(x.monthly) || '<span class="small">臨停</span>'}</div></td>
      <td>${link(x.entry_time, x.entry_photo, x.entry_estimated_from)}${checks}</td>
      <td>${link(x.exit_time, x.exit_photo, x.exit_estimated_from)}</td>
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
  updateDateLabels();
  const p = new URLSearchParams();
  const d = $('#evDate').value;
  if (d) { p.set('from', dayStartIso(d)); p.set('to', dayEndIso(d)); }
  if ($('#evQ').value.trim()) p.set('plate', $('#evQ').value.trim());
  const { events } = await api(`/api/events?${p}`);
  const list = $('#evList');
  list.innerHTML = events.map((e) => `<li class="item">
      ${e.photo ? `<img src="${esc(photoUrl(e.photo))}" data-photo="${esc(e.photo)}" alt="" loading="lazy">` : '<div class="nophoto">盤點時<br>沒拍到</div>'}
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
  const el = e.target.closest('[data-photo], [data-src]');
  if (!el) return;
  e.preventDefault();
  $('#photoDlg img').src = el.dataset.photo ? photoUrl(el.dataset.photo) : el.dataset.src;
  $('#photoDlg').showModal();
});
// 點照片本身或旁邊的暗處也能關閉
$('#photoDlg').addEventListener('click', (e) => {
  if (e.target.tagName !== 'BUTTON') $('#photoDlg').close();
});

// ---------- 月租名單 ----------
function monthlyTag(m) {
  if (!m) return '';
  const who = m.names?.length ? `・${m.names.map(esc).join('/')}` : '';
  return ` <span class="tag monthly" title="名單車號 ${esc(m.mask)}">月租${who}</span>`;
}

let mRows = []; // 編輯中的名單 { mask, name }
let mDirty = false;
const maskOk = (s) => /^[A-Z0-9]{2}\*{3}[A-Z0-9]{1,3}$/.test(s);

function renderMonthly() {
  $('#mCount').textContent = mRows.length;
  $('#mDirty').hidden = !mDirty;
  $('#mBody').innerHTML = mRows.map((r, i) => `<tr data-i="${i}">
      <td>${i + 1}</td>
      <td><input class="mask ${maskOk(r.mask) ? '' : 'bad'}" value="${esc(r.mask)}" placeholder="AQ***26" autocapitalize="characters"></td>
      <td><input class="name" value="${esc(r.name)}" placeholder="姓名"></td>
      <td><button class="btn sm" data-mdel="${i}" aria-label="刪除">✕</button></td>
    </tr>`).join('') || '<tr><td colspan="4" class="small">還沒有名單，請拍公告上的名單讀取</td></tr>';
  $$('#mBody tr[data-i]').forEach((tr) => {
    const r = mRows[Number(tr.dataset.i)];
    $('input.mask', tr).addEventListener('input', (e) => {
      r.mask = e.target.value.toUpperCase().replace(/[＊×]/g, '*').replace(/[^A-Z0-9*]/g, '');
      e.target.classList.toggle('bad', !maskOk(r.mask));
      setDirty();
    });
    $('input.name', tr).addEventListener('input', (e) => { r.name = e.target.value; setDirty(); });
  });
  $$('[data-mdel]').forEach((b) => b.addEventListener('click', () => { mRows.splice(Number(b.dataset.mdel), 1); mDirty = true; renderMonthly(); }));
}
function setDirty() { mDirty = true; $('#mDirty').hidden = false; }

async function loadMonthly() {
  if (mDirty) return renderMonthly(); // 有沒儲存的修改就不要覆蓋
  try {
    mRows = (await api('/api/monthly')).rows.map((r) => ({ mask: r.mask, name: r.name }));
  } catch (err) {
    $('#mStatus').textContent = err.message;
  }
  renderMonthly();
}

async function readListPhotos(files) {
  files = [...files];
  if (!files.length) return;
  let added = 0;
  const notes = [];
  for (const [i, file] of files.entries()) {
    $('#mStatus').textContent = `讀取名單中…（${i + 1}/${files.length}，每張約 20～40 秒）`;
    try {
      const { dataUrl } = await shrink(file, null, 2400); // 名單字小，用大一點的圖
      const r = await api('/api/monthly/read', { method: 'POST', body: JSON.stringify({ image: dataUrl }) });
      for (const row of r.rows) {
        // 同車號同姓名的重複列（公告上有時會重複）只留一筆
        if (mRows.some((x) => x.mask === row.mask && x.name === row.name)) continue;
        mRows.push({ mask: row.mask, name: row.name });
        added++;
      }
      if (r.note) notes.push(r.note);
    } catch (err) {
      notes.push(`第 ${i + 1} 張讀取失敗：${err.message}`);
    }
  }
  mDirty = added > 0 || mDirty;
  renderMonthly();
  $('#mStatus').innerHTML = `新增 ${added} 筆，請核對後按「儲存名單」。${notes.length ? `<div class="warnbox">${notes.map(esc).join('<br>')}</div>` : ''}`;
}
$('#mCam').addEventListener('change', (e) => { readListPhotos(e.target.files); e.target.value = ''; });
$('#mPick').addEventListener('change', (e) => { readListPhotos(e.target.files); e.target.value = ''; });
$('#mAdd').addEventListener('click', () => { mRows.push({ mask: '', name: '' }); setDirty(); renderMonthly(); $$('#mBody input.mask').pop()?.focus(); });
$('#mSave').addEventListener('click', async () => {
  const bad = mRows.filter((r) => !maskOk(r.mask));
  if (bad.length && !confirm(`有 ${bad.length} 筆車號格式不對（紅框），儲存時會被略過，確定儲存？`)) return;
  try {
    mRows = (await api('/api/monthly', { method: 'PUT', body: JSON.stringify({ rows: mRows }) })).rows.map((r) => ({ mask: r.mask, name: r.name }));
    mDirty = false;
    renderMonthly();
    $('#mStatus').textContent = `已儲存 ${mRows.length} 筆，之後進場的車會自動比對。`;
  } catch (err) {
    alert(err.message);
  }
});

// ---------- 員工暫時離開 → 回來盤點 ----------
// 狀態：沒有離開（gap = null）→ 離開中（沒有 end_at）→ 盤點中（有 end_at）→ 完成（顯示結果）
let gap = null;
let auditCount = 0;
let gapResult = null;

const since = (iso) => {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return min < 60 ? `${min} 分鐘` : `${Math.floor(min / 60)} 小時 ${min % 60} 分`;
};

function renderGap() {
  const bar = $('#gapBar');
  bar.className = 'card gapbar';
  if (gapResult) {
    const list = (a) => (a.length ? a.map(esc).join('、') : '無');
    bar.innerHTML = `<div class="title">✔ 盤點完成</div>
      <div>員工離開期間<b>進場</b> ${gapResult.entered.length} 台：${list(gapResult.entered)}</div>
      <div>員工離開期間<b>出場</b> ${gapResult.exited.length} 台：${list(gapResult.exited)}</div>
      <div class="small">這些車的時間標示為「推估」，介於離開和回來之間。盤點時漏拍的車會被當成已出場，可到「照片紀錄」刪掉那筆推估出場。</div>
      <button class="btn" id="gapOk">知道了</button>`;
    $('#gapOk').onclick = () => { gapResult = null; renderGap(); };
    return;
  }
  if (!gap) {
    bar.innerHTML = `<button class="btn" id="gapStart">⏸ 我要暫時離開</button>
      <div class="small">離開前按一下，回來後系統會引導你把場內的車拍一遍，自動找出離開期間進出的車。</div>`;
    $('#gapStart').onclick = () => gapAction('start');
    $('#normalCard').hidden = false;
    return;
  }
  if (!gap.end_at) {
    bar.classList.add('away');
    bar.innerHTML = `<div class="title">⏸ 離開中</div>
      <div>${esc(fmtTime(gap.start_at))} 離開，已經 ${since(gap.start_at)}</div>
      <button class="btn primary big" id="gapReturn">▶ 我回來了・開始盤點</button>
      <button class="btn link" id="gapCancel">按錯了，取消離開</button>`;
    $('#gapReturn').onclick = () => gapAction('return');
    $('#gapCancel').onclick = () => { if (confirm('取消這次離開？')) gapAction('cancel'); };
    $('#normalCard').hidden = false;
    return;
  }
  bar.classList.add('audit');
  bar.innerHTML = `<div class="title">📋 盤點中</div>
    <ol class="steps">
      <li>用 iPhone 的「相機」App，把<b>場內每一台車</b>的車牌連續拍完</li>
      <li>回到這裡按下面的按鈕，把剛拍的照片<b>一次全部選起來</b></li>
      <li>辨識完後按「盤點完成」</li>
    </ol>
    <button class="btn primary big" id="auditPickBtn">🖼 從相簿選取盤點照片</button>
    <div>已上傳 ${auditCount} 台</div>
    <button class="btn big in" id="gapFinish">✔ 盤點完成</button>
    <div class="small">盤點時拍到、原本不在場內的車 → 算離開期間進場；原本在場內、這次沒拍到的車 → 算離開期間出場。盤點時有新車進出，請照常用下面的進場／出場按鈕。</div>`;
  $('#auditPickBtn').onclick = () => $('#auditPick').click();
  $('#gapFinish').onclick = () => {
    if (confirm(`確定盤點完成？場內有拍到 ${auditCount} 台，沒拍到的在場車輛會被算成已出場。`)) gapAction('finish');
  };
}

async function gapAction(action) {
  try {
    const r = await api(`/api/gap/${action}`, { method: 'POST' });
    if (action === 'return') auditCount = 0;
    if (action === 'finish') {
      gapResult = r;
      gap = null;
    } else {
      gap = r.gap;
    }
    renderGap();
  } catch (err) {
    alert(err.message);
  }
}

$('#auditPick').addEventListener('change', (e) => { handleFiles(e.target.files, false, 'in', gap?.id); e.target.value = ''; });

async function loadGap() {
  try {
    gap = (await api('/api/gap')).gap;
    if (gap?.end_at) {
      // 重新整理後，算回這次盤點已拍幾台
      const { events } = await api(`/api/events?gap=${gap.id}`);
      auditCount = events.length;
    }
  } catch {}
  renderGap();
}
setInterval(() => { if (gap && !gap.end_at) renderGap(); }, 60000);

// ---------- 合計（臨停收費） ----------
// 合計密碼只放在記憶體：重新整理網頁或按「鎖上」就要重新輸入
let feePw = '';
function askFeePw(error = '') {
  const dlg = $('#feeDlg');
  $('#feePw').value = '';
  $('#feeErr').textContent = error;
  dlg.showModal();
  setTimeout(() => $('#feePw').focus(), 50);
  return new Promise((resolve) => {
    const done = (ok) => {
      $('#feeForm').onsubmit = null;
      $('#feeCancel').onclick = null;
      dlg.oncancel = null;
      dlg.close();
      resolve(ok);
    };
    $('#feeForm').onsubmit = async (ev) => {
      ev.preventDefault();
      const pw = $('#feePw').value.trim();
      if (!pw) return;
      try {
        await fetchFees(pw);
        feePw = pw;
        done(true);
      } catch (e) {
        $('#feeErr').textContent = e.message;
        $('#feePw').select();
      }
    };
    $('#feeCancel').onclick = () => done(false);
    dlg.oncancel = () => done(false);
  });
}

function feeParams() {
  const p = new URLSearchParams();
  const f = $('#feeFrom').value, t = $('#feeTo').value;
  if (f) p.set('from', dayStartIso(f));
  if (t) p.set('to', dayEndIso(t));
  p.set('rate', $('#feeRate').value || '15');
  p.set('free', $('#feeFree').value || '15');
  p.set('tzo', String(-new Date().getTimezoneOffset()));
  return p;
}
async function fetchFees(pw) {
  return api(`/api/fees?${feeParams()}`, { headers: { 'X-Fee-Password': pw } });
}

// 匯出 Excel：目前選的日期範圍內的原始進出資料
$('#feeXlsx').addEventListener('click', async () => {
  const btn = $('#feeXlsx');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '產生中…';
  try {
    const res = await fetch(`/api/report.xlsx?${feeParams()}`, { headers: { 'X-App-Password': password, 'X-Fee-Password': feePw } });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `錯誤 ${res.status}`);
    const blob = await res.blob();
    const f = $('#feeFrom').value, t = $('#feeTo').value;
    const name = `停車紀錄${f ? `_${f}` : ''}${t && t !== f ? `_${t}` : ''}.xlsx`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  } catch (e) {
    alert(`匯出失敗：${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

const money = (n) => `$${Number(n).toLocaleString('zh-TW')}`;
let feeLoading = 0;
async function loadFees() {
  updateDateLabels();
  if (!feePw) return;
  const my = ++feeLoading;
  let r;
  try {
    r = await fetchFees(feePw);
  } catch (e) {
    if (/合計密碼/.test(e.message)) { feePw = ''; if (await askFeePw(e.message)) return loadFees(); return showTab('upload'); }
    $('#fNote').textContent = e.message;
    return;
  }
  if (my !== feeLoading) return;
  $('#fExited').textContent = money(r.exited.amount);
  $('#fInside').textContent = money(r.inside.amount);
  $('#fTotal').textContent = money(r.total);
  $('#fAvgFee').textContent = r.exited.count ? money(r.exited.avgFee) : '–';
  $('#fAvgDur').textContent = r.exited.count ? `${(r.exited.avgMin / 60).toFixed(1)} 小時` : '–';
  const est = r.estimated.count ? `（不含盤點 ${r.estimated.count} 台）` : '';
  // 盤點推估的車：出場（或進場）時間不確定，不算進上面的收費，另外列出可能的範圍
  $('#fEst').hidden = !r.estimated.count;
  $('#fEst').innerHTML = `盤點推估 <b>${r.estimated.count} 台</b>：<b>${money(r.estimated.min)} ～ ${money(r.estimated.max)}</b><div class="small">員工離開超過 30 分鐘期間進出的車，確切時間不知道，沒有算進上面的收費與合計。</div>`;
  $('#fAvgFeeSub').textContent = `已出場臨停車${est}`;
  $('#fAvgDurSub').textContent = r.exited.count ? `約 ${fmtDur(r.exited.avgMin)}${est}` : '';
  const nowTxt = fmtTime(r.now).slice(6, 11);
  const note = [`已出場 ${r.exited.count} 台（其中 ${r.exited.free} 台免費）`, `在場 ${r.inside.count} 台算到 ${nowTxt}`];
  if (r.monthly) note.push(`月租 ${r.monthly} 台不收費`);
  if (r.missingEntry || r.missingExit) note.push(`缺進場 ${r.missingEntry} 台、缺出場 ${r.missingExit} 台算不出金額`);
  $('#fNote').textContent = note.join('；');

  renderUsage(r);

  const max = Math.max(1, ...r.dist.map((d) => d.count));
  $('#fDist').innerHTML = r.dist.length
    ? r.dist.map((d) => `<div class="r"><span>${d.fee ? money(d.fee) : '免費'}</span><div class="bar" style="width:${(d.count / max) * 100}%"></div><span class="n">${d.count} 台</span></div>`).join('')
    : '<span class="small">沒有已出場的臨停車</span>';
  $('#fBody').innerHTML = r.rows.map((x) => `<tr>
    <td><span class="plate">${esc(x.plate)}</span></td>
    <td>${fmtTime(x.entry_time)}</td>
    <td>${x.exit_time ? fmtTime(x.exit_time) : '<span class="tag in">在場內</span>'}</td>
    <td>${fmtDur(x.minutes)}</td>
    <td class="money">${x.estimated ? `<span class="tag est">盤點</span><div class="small">${money(x.feeMin)}～${money(x.feeMax)}</div>` : x.fee ? money(x.fee) : '免費'}</td>
  </tr>`).join('') || '<tr><td colspan="5" class="small">沒有資料</td></tr>';
}

// 一天可以賺多少 + 使用率 + 每天明細
function renderUsage(r) {
  const cap = Number($('#feeCap').value) || 0;
  const pct = (n) => (cap ? `${Math.round((n / cap) * 100)}%` : '');
  const days = r.days.filter((d) => d.entries > 0);
  const full = days.filter((d) => !d.today);
  const today = days.find((d) => d.today);

  // 平均每天：有完整的日子就用完整日平均；只有今天就用今天（含在場應收）
  let perDay = 0;
  if (full.length) {
    perDay = full.reduce((a, d) => a + d.revenue, 0) / full.length;
    $('#eDayLabel').textContent = `平均每天（${full.length} 天）`;
    $('#eNote').textContent = today ? `今天還沒結束，不算進平均；今天目前已收 ${money(today.revenue)}、在場應收 ${money(today.pending)}。` : '';
  } else if (today) {
    perDay = today.revenue + today.pending;
    $('#eDayLabel').textContent = '今天（還沒結束）';
    $('#eNote').textContent = `只有今天的資料：已收 ${money(today.revenue)} ＋ 在場車輛算到現在 ${money(today.pending)}。之後車還會繼續進出，打烊後的數字才準；累積幾天後這裡會改成平均。`;
  } else {
    $('#eDayLabel').textContent = '平均每天';
    $('#eNote').textContent = '這段期間沒有資料';
  }
  // 月租：格數 × 月租費，每天 = 每月 / 30
  const mCap = Number($('#mCap').value) || 0;
  const mFee = Number($('#mFee').value) || 0;
  const mMonth = mCap * mFee;
  $('#eTempDay').textContent = money(Math.round(perDay));
  $('#eTempMonth').textContent = money(Math.round(perDay * 30));
  $('#eMLabel').textContent = `月租 ${mCap} 格`;
  $('#eMDay').textContent = mFee ? money(Math.round(mMonth / 30)) : '未填';
  $('#eMMonth').textContent = mFee ? money(mMonth) : '未填';
  $('#eDay').textContent = money(Math.round(perDay + mMonth / 30));
  $('#eMonth').textContent = money(Math.round(perDay * 30 + mMonth));
  if (!mFee) $('#eNote').textContent = `${$('#eNote').textContent} 月租費還沒填，上面只算臨停。`.trim();

  // 使用率
  const top = days.reduce((a, d) => (!a || d.peak > a.peak ? d : a), null);
  $('#uPeak').textContent = top ? `${top.peak} 台` : '–';
  $('#uPeakSub').textContent = top ? [pct(top.peak) && `使用率 ${pct(top.peak)}`, top.peakAt && `${days.length > 1 ? top.date.slice(5) + ' ' : ''}${fmtTime(top.peakAt).slice(6, 11)}`].filter(Boolean).join('・') : '';
  const avg = days.length ? days.reduce((a, d) => a + d.avgInside, 0) / days.length : 0;
  $('#uAvg').textContent = days.length ? `${avg.toFixed(1)} 台` : '–';
  const hrs = today && !full.length ? `${pad(today.openFrom)}～${pad(today.openTo)} 時` : '有車的時段';
  $('#uAvgSub').textContent = [pct(avg) && `使用率 ${pct(avg)}`, hrs].filter(Boolean).join('・');
  const entriesPerDay = days.length ? days.reduce((a, d) => a + d.entries, 0) / days.length : 0;
  $('#uTurn').textContent = cap ? `${(entriesPerDay / cap).toFixed(1)} 次` : '–';
  $('#uTurnSub').textContent = cap ? `每格每天換 ${(entriesPerDay / cap).toFixed(1)} 台車` : '填車位數才算得出來';

  // 每小時平均在場（多天就取平均）
  const hourly = Array(24).fill(0);
  for (const d of days) d.hourly.forEach((v, i) => (hourly[i] += v / days.length));
  const scale = Math.max(1, cap, ...hourly);
  $('#uChart').innerHTML = hourly.map((v, h) => `<div class="h" data-h="${h}" title="${h}:00 平均 ${v.toFixed(1)} 台"><div class="b occ" style="height:${(v / scale) * 100}%"></div></div>`).join('')
    + (cap ? `<div class="capline" style="bottom:${(cap / scale) * 100}%"></div>` : '');
  $('#uLegend').innerHTML = `<span class="sw" style="background:var(--accent)"></span>平均在場台數${cap ? `　<span style="color:var(--err)">- - 滿車 ${cap} 格</span>` : ''}`;

  // 每天明細
  $('#dBody').innerHTML = days.slice().reverse().map((d) => `<tr>
    <td>${d.date.slice(5).replace('-', '/')}${d.today ? ' <span class="tag in">今天</span>' : ''}</td>
    <td>${d.tempEntries}</td>
    <td>${d.monthlyEntries}</td>
    <td class="money">${money(d.revenue)}${d.today && d.pending ? `<div class="small">＋在場 ${money(d.pending)}</div>` : ''}${d.estCars ? `<div class="small">盤點 ${d.estCars} 台 ${money(d.estMin)}～${money(d.estMax)} 未計</div>` : ''}</td>
    <td>${d.peak} 台${cap ? ` <span class="small">${pct(d.peak)}</span>` : ''}</td>
    <td>${d.avgInside} 台${cap ? ` <span class="small">${pct(d.avgInside)}</span>` : ''}</td>
  </tr>`).join('') || '<tr><td colspan="6" class="small">沒有資料</td></tr>';
}

function setFeeRange(kind) {
  const today = new Date();
  const d = (n) => { const x = new Date(today); x.setDate(x.getDate() + n); return localDate(x); };
  if (kind === 'today') { $('#feeFrom').value = d(0); $('#feeTo').value = d(0); }
  if (kind === 'yesterday') { $('#feeFrom').value = d(-1); $('#feeTo').value = d(-1); }
  if (kind === '7d') { $('#feeFrom').value = d(-6); $('#feeTo').value = d(0); }
  if (kind === 'month') { $('#feeFrom').value = localDate(new Date(today.getFullYear(), today.getMonth(), 1)); $('#feeTo').value = d(0); }
  loadFees();
}
$$('[data-frange]').forEach((b) => b.addEventListener('click', () => setFeeRange(b.dataset.frange)));
['#feeFrom', '#feeTo'].forEach((s) => $(s).addEventListener('change', loadFees));
$('#feeRate').value = store.get('feeRate', '15');
$('#feeFree').value = store.get('feeFree', '15');
$('#feeCap').value = store.get('feeCap', '92'); // 停車場共 92 格
$('#mCap').value = store.get('mCap', '35'); // 月租 35 格
$('#mFee').value = store.get('mFee', '');
['#feeCap', '#mCap', '#mFee'].forEach((s) => $(s).addEventListener('input', () => {
  store.set(s.slice(1), $(s).value);
  clearTimeout(feeTimer);
  feeTimer = setTimeout(loadFees, 400);
}));
let feeTimer;
['#feeRate', '#feeFree'].forEach((s) => $(s).addEventListener('input', () => {
  store.set('feeRate', $('#feeRate').value);
  store.set('feeFree', $('#feeFree').value);
  clearTimeout(feeTimer);
  feeTimer = setTimeout(loadFees, 400);
}));
$('#feeLock').addEventListener('click', () => { feePw = ''; showTab('upload'); });
setFeeRange('today');

// ---------- 啟動 ----------
loadGap();
api('/api/config').then((c) => { $('#mockBadge').hidden = !c.mock; });
setRange('today');
showTab(store.get('tab', 'upload'));

// 篩選列固定在分頁列正下方：量分頁列的高度給 CSS 用
{
  const tabs = $('.tabs');
  const setH = () => document.documentElement.style.setProperty('--tabs-h', `${tabs.offsetHeight}px`);
  setH();
  if (window.ResizeObserver) new ResizeObserver(setH).observe(tabs);
}
