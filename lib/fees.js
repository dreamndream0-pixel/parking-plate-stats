// 臨停收費：停 freeMin 分鐘以內免費；超過就從進場起算，每 unitMin 分鐘收 rate 元（不滿一段算一段）
export const DEFAULT_RATE = 15;
export const DEFAULT_FREE_MIN = 15;
export const UNIT_MIN = 30;

export function feeFor(minutes, { rate = DEFAULT_RATE, freeMin = DEFAULT_FREE_MIN, unitMin = UNIT_MIN } = {}) {
  if (minutes == null || minutes <= freeMin) return 0;
  return Math.ceil(minutes / unitMin) * rate;
}

// 每天的收入與使用率。
// tzOffsetMin：當地時區比 UTC 快幾分鐘（台灣 480），用來切「一天」與「每小時」。
// 使用率包含月租車（佔車位就算）；收入只算臨停，算在出場那天，還在場內的算「應收」放在今天。
// 在場時段：已出場＝進場→出場；在場內＝進場→現在；缺出場＝進場→最後一次拍到；缺進場的不算。
export function dailyReport(sessions, { from, to, now = Date.now(), tzOffsetMin = 480, rate, freeMin } = {}) {
  const DAY = 86400e3;
  const off = tzOffsetMin * 60e3;
  const opts = { rate, freeMin };
  const localDayStart = (ms) => Math.floor((ms + off) / DAY) * DAY - off;
  const ymd = (ms) => new Date(ms + off).toISOString().slice(0, 10);

  const spans = [];
  for (const s of sessions) {
    if (!s.entry_time) continue;
    const a = Date.parse(s.entry_time);
    const b = s.exit_time ? Date.parse(s.exit_time) : s.status === 'inside' ? now : Date.parse(s.last_seen || s.entry_time);
    if (b > a) spans.push({ a, b, s });
  }

  const start = from ? Date.parse(from) : spans.length ? localDayStart(Math.min(...spans.map((x) => x.a))) : localDayStart(now);
  const end = Math.min(to ? Date.parse(to) : localDayStart(now) + DAY, localDayStart(now) + DAY);
  const days = [];
  for (let d0 = localDayStart(start); d0 < end; d0 += DAY) {
    const d1 = d0 + DAY;
    const isToday = d0 === localDayStart(now);
    const hourly = Array(24).fill(0); // 這小時平均有幾台車在場（佔用分鐘 / 60）
    const pts = [];
    let entries = 0, monthlyEntries = 0, revenue = 0, pending = 0, paidCars = 0;
    for (const { a, b, s } of spans) {
      if (b <= d0 || a >= d1) continue;
      const lo = Math.max(a, d0), hi = Math.min(b, d1);
      for (let h = 0; h < 24; h++) {
        const h0 = d0 + h * 3600e3, h1 = h0 + 3600e3;
        const ov = Math.min(hi, h1) - Math.max(lo, h0);
        if (ov > 0) hourly[h] += ov / 3600e3;
      }
      pts.push([lo, 1], [hi, -1]);
      if (a >= d0) { entries++; if (s.monthly) monthlyEntries++; }
      if (s.monthly) continue;
      const fee = feeFor((b - a) / 60000, opts);
      if (s.status === 'done' && b < d1) { revenue += fee; if (fee) paidCars++; }
      else if (s.status === 'inside' && isToday) pending += fee;
    }
    // 尖峰：同一時間最多幾台
    pts.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    let cur = 0, peak = 0, peakAt = null;
    for (const [t, dlt] of pts) { cur += dlt; if (cur > peak) { peak = cur; peakAt = new Date(t).toISOString(); } }
    // 平均在場：只算有車的時段（第一台進場的小時 ～ 最後一台離開的小時），避免半夜空場把平均拉低
    const active = hourly.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0);
    let carHours = 0, hours = 0;
    if (active.length) {
      for (let h = active[0]; h <= active[active.length - 1]; h++) {
        carHours += hourly[h];
        // 今天現在這個小時還沒過完，只算已經過去的部分
        const h0 = d0 + h * 3600e3;
        hours += Math.max(0, Math.min(1, (now - h0) / 3600e3));
      }
    }
    const avgInside = hours ? carHours / hours : 0;
    days.push({
      date: ymd(d0),
      today: isToday,
      entries,
      monthlyEntries,
      tempEntries: entries - monthlyEntries,
      paidCars,
      revenue,
      pending,
      peak,
      peakAt,
      avgInside: Math.round(avgInside * 10) / 10,
      openFrom: active.length ? active[0] : null,
      openTo: active.length ? active[active.length - 1] + 1 : null,
      hourly: hourly.map((v) => Math.round(v * 10) / 10),
    });
  }
  return days;
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
    exited: {
      count: exited.length,
      amount: sum(exited),
      free: exited.filter((r) => r.fee === 0).length,
      // 已出場臨停車：平均每台收多少、平均停多久（分鐘）
      avgFee: exited.length ? Math.round(sum(exited) / exited.length) : 0,
      avgMin: exited.length ? Math.round(exited.reduce((a, r) => a + r.minutes, 0) / exited.length) : 0,
    },
    inside: { count: inside.length, amount: sum(inside) },
    total: sum(exited) + sum(inside),
    monthly,
    missingEntry,
    missingExit,
    dist: Object.entries(dist).map(([fee, count]) => ({ fee: Number(fee), count })).sort((a, b) => a.fee - b.fee),
    rows: [...inside, ...exited].sort((a, b) => (b.exit_time || '9').localeCompare(a.exit_time || '9') || b.entry_time.localeCompare(a.entry_time)),
  };
}
