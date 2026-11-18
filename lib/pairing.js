// 把每張照片的「事件」依車牌、依時間排序，配對成一筆筆停車紀錄（進場 → 出場）。
// 每次查詢都重新計算，所以照片不照順序上傳、事後改車牌或改方向，結果都會自動正確。
//
// event: { id, plate, direction: 'in' | 'out' | 'auto', taken_at (ISO), photo }
// 'auto'：舊資料用；車子目前不在場內 → 當進場；已在場內 → 當出場。
//
// 重複拍照：
// - 車子已在場內又拍到「進場」→ 不另開一筆，算「確認還在場內」（recheck），照片照樣保留。
// - 車子剛出場又拍到「出場」→ 算「重複出場」（repeat_out），掛在剛結束的那筆。
// - 但「在場內」超過 STALE_HOURS 沒再看到，又拍到進場 → 視為上次漏拍出場，另開新的一筆。
//
// 員工離開的空檔：event.estimated_from 有值時，實際時間介於 estimated_from 和 taken_at 之間。

export const STALE_HOURS = 12;

function newSession(plate) {
  return {
    plate,
    entry_time: null,
    entry_event_id: null,
    entry_photo: null,
    exit_time: null,
    exit_event_id: null,
    exit_photo: null,
    entry_estimated_from: null, // 有值：進場時間是空檔推估（介於這個時間和 entry_time 之間）
    exit_estimated_from: null, // 有值：出場時間是空檔推估
    checks: [], // 在場內重複拍到的「進場」照片：{ id, time, photo }
    repeat_exits: [], // 出場後又拍到的「出場」照片
    last_seen: null,
    status: 'inside',
  };
}

export function pairSessions(events) {
  const byPlate = new Map();
  for (const e of events) {
    if (!e.plate) continue;
    if (!byPlate.has(e.plate)) byPlate.set(e.plate, []);
    byPlate.get(e.plate).push(e);
  }

  const sessions = [];
  for (const [plate, list] of byPlate) {
    list.sort((a, b) => a.taken_at.localeCompare(b.taken_at) || a.id - b.id);
    let open = null; // 目前在場內的那筆
    let lastClosed = null; // 剛出場的那筆（用來接重複的出場照片）
    for (const e of list) {
      const dir = e.direction === 'auto' ? (open ? 'out' : 'in') : e.direction;
      const shot = { id: e.id, time: e.taken_at, photo: e.photo };
      if (dir === 'in') {
        if (open && Date.parse(e.taken_at) - Date.parse(open.last_seen) > STALE_HOURS * 3600e3) {
          // 太久沒看到了，這次應該是新的一次進場，上一次漏拍出場
          open.status = 'missing_exit';
          sessions.push(open);
          open = null;
        }
        if (open) {
          // 已在場內又拍到進場 → 確認還在場內，不算新的一次進場
          open.checks.push(shot);
          open.last_seen = e.taken_at;
          continue;
        }
        open = newSession(plate);
        open.entry_time = e.taken_at;
        open.entry_event_id = e.id;
        open.entry_photo = e.photo;
        open.entry_estimated_from = e.estimated_from || null;
        open.last_seen = e.taken_at;
        lastClosed = null;
      } else if (open) {
        open.exit_time = e.taken_at;
        open.exit_event_id = e.id;
        open.exit_photo = e.photo;
        open.exit_estimated_from = e.estimated_from || null;
        open.last_seen = e.taken_at;
        open.status = 'done';
        sessions.push(open);
        lastClosed = open;
        open = null;
      } else if (lastClosed) {
        // 已經出場了又拍到出場 → 重複出場照片
        lastClosed.repeat_exits.push(shot);
      } else {
        // 只拍到出場、沒有進場紀錄
        const s = newSession(plate);
        s.exit_time = e.taken_at;
        s.exit_event_id = e.id;
        s.exit_photo = e.photo;
        s.exit_estimated_from = e.estimated_from || null;
        s.last_seen = e.taken_at;
        s.status = 'missing_entry';
        sessions.push(s);
        lastClosed = s;
      }
    }
    if (open) sessions.push(open);
  }

  for (const s of sessions) {
    s.duration_min =
      s.entry_time && s.exit_time
        ? Math.round((Date.parse(s.exit_time) - Date.parse(s.entry_time)) / 60000)
        : null;
  }
  sessions.sort((a, b) => (b.entry_time || b.exit_time).localeCompare(a.entry_time || a.exit_time));
  return sessions;
}

// 每個事件實際被算成進場還是出場（給列表顯示用）
export function resolveDirections(events) {
  const result = new Map();
  for (const s of pairSessions(events)) {
    if (s.entry_event_id != null) result.set(s.entry_event_id, 'in');
    if (s.exit_event_id != null) result.set(s.exit_event_id, 'out');
    for (const c of s.checks) result.set(c.id, 'recheck');
    for (const c of s.repeat_exits) result.set(c.id, 'repeat_out');
  }
  return result;
}

// 台灣車牌正規化：全形轉半形、大寫、去空白、統一用 '-'
export function normalizePlate(raw) {
  if (!raw) return '';
  let s = String(raw)
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toUpperCase()
    .replace(/[\s·.．_—–]/g, '-')
    .replace(/[^A-Z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  // 沒有分隔線時，嘗試在英文/數字交界補上
  if (!s.includes('-')) {
    const m = s.match(/^([A-Z]+)(\d+)$/) || s.match(/^(\d+)([A-Z]+)$/) || s.match(/^([A-Z]+\d?)(\d{4})$/);
    if (m) s = `${m[1]}-${m[2]}`;
  }
  return s;
}
