// 臨停收費：停 freeMin 分鐘以內免費；超過就從進場起算，每 unitMin 分鐘收 rate 元（不滿一段算一段）
export const DEFAULT_RATE = 15;
export const DEFAULT_FREE_MIN = 15;
export const UNIT_MIN = 30;

export function feeFor(minutes, { rate = DEFAULT_RATE, freeMin = DEFAULT_FREE_MIN, unitMin = UNIT_MIN } = {}) {
  if (minutes == null || minutes <= freeMin) return 0;
  return Math.ceil(minutes / unitMin) * rate;
}

// sessions 要先帶 monthly 欄位；月租車不收費。
// 已出場：出場時間落在範圍內；在場內：算到 now 為止的應收（還沒收到）
export function summarizeFees(sessions, { from, to, now = Date.now(), rate, freeMin } = {}) {
  const inRange = (iso) => iso && (!from || iso >= from) && (!to || iso < to);
  const opts = { rate, freeMin };
  const mins = (a, b) => (b - Date.parse(a)) / 60000;

  const exited = [];
  const inside = [];
  let monthly = 0;
  let missingEntry = 0;
  let missingExit = 0;
  for (const s of sessions) {
    const touches = inRange(s.entry_time) || inRange(s.exit_time);
    if (!touches) continue;
    if (s.monthly) { monthly++; continue; }
    if (s.status === 'missing_entry') { missingEntry++; continue; }
    if (s.status === 'missing_exit') { missingExit++; continue; }
    if (s.status === 'done' && inRange(s.exit_time)) {
      const m = mins(s.entry_time, Date.parse(s.exit_time));
      exited.push({ plate: s.plate, entry_time: s.entry_time, exit_time: s.exit_time, minutes: Math.round(m), fee: feeFor(m, opts) });
    } else if (s.status === 'inside') {
      const m = mins(s.entry_time, now);
      inside.push({ plate: s.plate, entry_time: s.entry_time, exit_time: null, minutes: Math.round(m), fee: feeFor(m, opts) });
    }
  }
  const sum = (list) => list.reduce((a, r) => a + r.fee, 0);
  const dist = {};
  for (const r of exited) dist[r.fee] = (dist[r.fee] || 0) + 1;
  return {
    exited: { count: exited.length, amount: sum(exited), free: exited.filter((r) => r.fee === 0).length },
    inside: { count: inside.length, amount: sum(inside) },
    total: sum(exited) + sum(inside),
    monthly,
    missingEntry,
    missingExit,
    dist: Object.entries(dist).map(([fee, count]) => ({ fee: Number(fee), count })).sort((a, b) => a.fee - b.fee),
    rows: [...inside, ...exited].sort((a, b) => (b.exit_time || '9').localeCompare(a.exit_time || '9') || b.entry_time.localeCompare(a.entry_time)),
  };
}
