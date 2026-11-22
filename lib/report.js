// 收入報表（匯出 Excel 用）：每台車分類 + 每天統計
// 規則：
//  - 臨停：進場、出場都有拍到照片 → 照實際時間收費
//  - 盤點後有出場：晚上進場、早上盤點才拍到，之後有拍到出場 → 從盤點拍照時間算到出場
//  - 晚上離開：員工下班後才走、不知道幾點 → 不算收入
//  - 員工：早上 7:30～9:59 進場、同一天 15:30～18:00 出場 → 免費
//  - 月租、缺進場、缺出場、在場內、沒有照片 → 不算收入
// 每台車算在進場那天（盤點車算在盤點那天；缺進場的算在出場那天）。
import { feeFor } from './fees.js';

export const CATS = ['臨停', '盤點後有出場', '員工', '晚上離開', '月租', '缺進場', '缺出場', '在場內', '沒有照片'];
const COUNTED = new Set(['臨停', '盤點後有出場']);
const EMP_IN = [450, 600]; // 7:30～9:59
const EMP_OUT = [930, 1080]; // 15:30～18:00

export function classifySessions(sessions, { from, to, now = Date.now(), tzOffsetMin = 480, rate, freeMin } = {}) {
  const off = tzOffsetMin * 60e3;
  const loc = (t) => new Date(Date.parse(t) + off);
  const day = (t) => loc(t).toISOString().slice(0, 10);
  const hm = (t) => { const d = loc(t); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
  const opts = { rate, freeMin };
  const rows = [];
  for (const s of sessions) {
    const anchor = s.entry_time || s.exit_time;
    if (!anchor || (from && anchor < from) || (to && anchor >= to)) continue;
    const r = { plate: s.plate, day: day(anchor), entry: s.entry_time, exit: s.exit_time, minutes: null, fee: 0, note: '' };
    const mins = s.entry_time && s.exit_time ? (Date.parse(s.exit_time) - Date.parse(s.entry_time)) / 60000 : null;
    if (s.monthly) { r.cat = '月租'; r.minutes = mins; r.note = s.monthly.mask || ''; }
    else if (s.status === 'missing_entry') r.cat = '缺進場';
    else if (s.status === 'missing_exit') r.cat = '缺出場';
    else if (s.status === 'inside') {
      r.cat = '在場內';
      r.minutes = (now - Date.parse(s.entry_time)) / 60000;
      r.fee = feeFor(r.minutes, opts);
      r.note = '還沒出場，金額算到匯出當下，不算進收入';
    } else if (s.exit_estimated_from) {
      r.cat = '晚上離開';
      r.note = '員工不在時離開，不知道幾點走，不算收入';
    } else if (!s.entry_photo || !s.exit_photo) {
      r.cat = '沒有照片';
      r.minutes = mins;
    } else {
      r.minutes = mins;
      r.fee = feeFor(mins, opts);
      const emp = day(s.entry_time) === day(s.exit_time)
        && hm(s.entry_time) >= EMP_IN[0] && hm(s.entry_time) < EMP_IN[1]
        && hm(s.exit_time) >= EMP_OUT[0] && hm(s.exit_time) <= EMP_OUT[1];
      if (emp) { r.cat = '員工'; r.note = '早上進、傍晚出，當員工免費（原應收金額供參考）'; }
      else if (s.entry_estimated_from) { r.cat = '盤點後有出場'; r.note = '晚上進場，從早上盤點拍照時間算起'; }
      else r.cat = '臨停';
    }
    r.counted = COUNTED.has(r.cat);
    if (r.minutes != null) r.minutes = Math.round(r.minutes);
    rows.push(r);
  }
  rows.sort((a, b) => (a.entry || a.exit).localeCompare(b.entry || b.exit));
  return rows;
}

export function dailyTotals(rows) {
  const days = {};
  for (const r of rows) {
    const d = (days[r.day] ||= { date: r.day, count: {}, fee: {}, revenue: 0, paidCars: 0, freeCars: 0, minSum: 0 });
    d.count[r.cat] = (d.count[r.cat] || 0) + 1;
    d.fee[r.cat] = (d.fee[r.cat] || 0) + r.fee;
    if (r.counted) {
      d.revenue += r.fee;
      d.minSum += r.minutes;
      r.fee ? d.paidCars++ : d.freeCars++;
    }
  }
  return Object.values(days).sort((a, b) => a.date.localeCompare(b.date)).map((d) => {
    const n = d.paidCars + d.freeCars;
    return { ...d, cars: n, avgFee: n ? Math.round(d.revenue / n) : 0, avgMin: n ? Math.round(d.minSum / n) : 0 };
  });
}

// 產生 Excel（兩張工作表：每日統計、停車明細）
export async function buildReportXlsx(rows, { rate, freeMin, tzOffsetMin = 480, generatedAt = new Date() } = {}) {
  const { default: ExcelJS } = await import('exceljs');
  const off = tzOffsetMin * 60e3;
  // Excel 的日期沒有時區：直接存「當地時間」
  const xd = (iso) => (iso ? new Date(Date.parse(iso) + off) : null);
  const wb = new ExcelJS.Workbook();
  wb.created = generatedAt;
  const head = (ws) => {
    const r = ws.getRow(1);
    r.font = { bold: true };
    r.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    r.height = 32;
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  };
  const money = '#,##0';

  const days = dailyTotals(rows);
  const ws1 = wb.addWorksheet('每日統計');
  ws1.columns = [
    { header: '日期', key: 'date', width: 12 },
    { header: '星期', key: 'wk', width: 6 },
    { header: '當天收入', key: 'revenue', width: 11, style: { numFmt: money } },
    { header: '計費台數', key: 'cars', width: 9 },
    { header: '臨停台數', key: 'temp', width: 9 },
    { header: '臨停收入', key: 'tempFee', width: 10, style: { numFmt: money } },
    { header: '盤點後有出場台數', key: 'audit', width: 10 },
    { header: '盤點後有出場收入', key: 'auditFee', width: 10, style: { numFmt: money } },
    { header: '其中免費台數（15 分內）', key: 'freeCars', width: 11 },
    { header: '平均每台', key: 'avgFee', width: 9, style: { numFmt: money } },
    { header: '平均停留（分）', key: 'avgMin', width: 9 },
    { header: '員工車（免費）', key: 'emp', width: 9 },
    { header: '員工車原應收', key: 'empFee', width: 10, style: { numFmt: money } },
    { header: '例外：晚上離開（不算）', key: 'night', width: 11 },
    { header: '缺進場（不算）', key: 'missIn', width: 9 },
    { header: '缺出場（不算）', key: 'missOut', width: 9 },
    { header: '月租', key: 'monthly', width: 7 },
    { header: '在場內（不算）', key: 'inside', width: 9 },
    { header: '沒有照片（不算）', key: 'noPhoto', width: 9 },
  ];
  head(ws1);
  for (const d of days) {
    const c = (k) => d.count[k] || 0;
    const f = (k) => d.fee[k] || 0;
    ws1.addRow({
      date: d.date, wk: '日一二三四五六'[new Date(d.date).getUTCDay()], revenue: d.revenue, cars: d.cars,
      temp: c('臨停'), tempFee: f('臨停'), audit: c('盤點後有出場'), auditFee: f('盤點後有出場'), freeCars: d.freeCars,
      avgFee: d.avgFee, avgMin: d.avgMin, emp: c('員工'), empFee: f('員工'), night: c('晚上離開'),
      missIn: c('缺進場'), missOut: c('缺出場'), monthly: c('月租'), inside: c('在場內'), noPhoto: c('沒有照片'),
    });
  }
  if (days.length) {
    const last = days.length + 1;
    const sum = ws1.addRow({ date: '合計', wk: '' });
    const avg = ws1.addRow({ date: '每天平均', wk: '' });
    for (let col = 3; col <= ws1.columnCount; col++) {
      const L = ws1.getColumn(col).letter;
      sum.getCell(col).value = { formula: `SUM(${L}2:${L}${last})` };
      avg.getCell(col).value = { formula: `ROUND(AVERAGE(${L}2:${L}${last}),0)` };
    }
    // 平均每台、平均停留在「合計」列改成加權平均
    sum.getCell('avgFee').value = { formula: `IF(D${last + 1}=0,0,ROUND(C${last + 1}/D${last + 1},0))` };
    sum.getCell('avgMin').value = null;
    sum.font = { bold: true };
    avg.font = { bold: true };
  }
  ws1.addRow([]);
  for (const line of [
    `收費：每半小時 ${rate} 元，${freeMin} 分鐘內免費；月租車不收費。`,
    '當天收入＝臨停（進出都有照片）＋盤點後有出場（從早上盤點拍照時間算到出場）。',
    '員工車：早上 7:30～9:59 進場、同一天 15:30～18:00 出場，當免費。',
    '晚上離開（員工不在時才走、不知道幾點）、缺進場、缺出場、在場內、沒有照片：都不算進收入。',
    '每台車算在進場那天；盤點車算在盤點那天；缺進場的算在出場那天。今天還沒結束，數字會再增加。',
  ]) ws1.addRow([line]).font = { color: { argb: 'FF666666' } };

  const ws2 = wb.addWorksheet('停車明細');
  ws2.columns = [
    { header: '日期', key: 'day', width: 12 },
    { header: '車牌', key: 'plate', width: 12 },
    { header: '類別', key: 'cat', width: 14 },
    { header: '算進收入', key: 'counted', width: 9 },
    { header: '進場時間', key: 'entry', width: 18, style: { numFmt: 'yyyy/mm/dd hh:mm' } },
    { header: '出場時間', key: 'exit', width: 18, style: { numFmt: 'yyyy/mm/dd hh:mm' } },
    { header: '停留（分）', key: 'minutes', width: 9 },
    { header: '金額', key: 'fee', width: 9, style: { numFmt: money } },
    { header: '備註', key: 'note', width: 44 },
  ];
  head(ws2);
  for (const r of rows) {
    ws2.addRow({ ...r, counted: r.counted ? '是' : '否', entry: xd(r.entry), exit: xd(r.exit), fee: r.fee || (r.minutes != null ? 0 : null) });
  }
  ws2.autoFilter = { from: 'A1', to: 'I1' };
  return Buffer.from(await wb.xlsx.writeBuffer());
}
