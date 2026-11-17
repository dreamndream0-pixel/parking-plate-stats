// 把每張照片的「事件」依車牌、依時間排序，配對成一筆筆停車紀錄（進場 → 出場）。
// 每次查詢都重新計算，所以照片不照順序上傳、事後改車牌或改方向，結果都會自動正確。
//
// event: { id, plate, direction: 'in' | 'out' | 'auto', taken_at (ISO), photo }
// 'auto'：車子目前不在場內 → 當進場；已在場內 → 當出場。

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
    for (const e of list) {
      const dir = e.direction === 'auto' ? (open ? 'out' : 'in') : e.direction;
      if (dir === 'in') {
        if (open) {
          // 又拍到進場但前一次沒拍到出場 → 前一筆標記為缺出場
          open.status = 'missing_exit';
          sessions.push(open);
        }
        open = {
          plate,
          entry_time: e.taken_at,
          entry_event_id: e.id,
          entry_photo: e.photo,
          exit_time: null,
          exit_event_id: null,
          exit_photo: null,
          status: 'inside',
        };
      } else {
        if (open) {
          open.exit_time = e.taken_at;
          open.exit_event_id = e.id;
          open.exit_photo = e.photo;
          open.status = 'done';
          sessions.push(open);
          open = null;
        } else {
          // 只拍到出場、沒有進場紀錄
          sessions.push({
            plate,
            entry_time: null,
            entry_event_id: null,
            entry_photo: null,
            exit_time: e.taken_at,
            exit_event_id: e.id,
            exit_photo: e.photo,
            status: 'missing_entry',
          });
        }
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
