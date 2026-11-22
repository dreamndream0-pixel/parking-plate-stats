import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySessions, dailyTotals, buildReportXlsx } from '../lib/report.js';

// 時間都是 UTC；台灣 = +8
const S = (o) => ({ status: 'done', monthly: null, entry_photo: 'a.jpg', exit_photo: 'b.jpg', ...o });
const sessions = [
  S({ plate: 'T1', entry_time: '2026-11-18T03:00:00Z', exit_time: '2026-11-18T04:00:00Z' }), // 11:00–12:00 臨停 $20
  S({ plate: 'E1', entry_time: '2026-11-18T00:10:00Z', exit_time: '2026-11-18T09:00:00Z' }), // 08:10–17:00 員工
  S({ plate: 'A1', entry_time: '2026-11-18T00:30:00Z', entry_estimated_from: '2026-11-17T11:00:00Z', exit_time: '2026-11-18T02:00:00Z' }), // 盤點 08:30 → 10:00，$30
  S({ plate: 'N1', entry_time: '2026-11-18T05:00:00Z', exit_time: '2026-11-18T23:00:00Z', exit_estimated_from: '2026-11-18T11:00:00Z', exit_photo: '' }), // 晚上離開
  S({ plate: 'M1', entry_time: '2026-11-18T03:00:00Z', exit_time: '2026-11-18T05:00:00Z', monthly: { mask: 'M1***' } }),
  S({ plate: 'X1', status: 'missing_entry', entry_time: null, exit_time: '2026-11-18T06:00:00Z' }),
  S({ plate: 'I1', status: 'inside', entry_time: '2026-11-18T07:00:00Z', exit_time: null }),
  S({ plate: 'F1', entry_time: '2026-11-18T06:00:00Z', exit_time: '2026-11-18T06:10:00Z' }), // 10 分鐘免費
];

test('分類與每天收入', () => {
  const rows = classifySessions(sessions, { rate: 10, freeMin: 15, now: Date.parse('2026-11-18T08:00:00Z') });
  const cat = Object.fromEntries(rows.map((r) => [r.plate, r.cat]));
  assert.deepEqual(cat, { T1: '臨停', E1: '員工', A1: '盤點後有出場', N1: '晚上離開', M1: '月租', X1: '缺進場', I1: '在場內', F1: '臨停' });
  const [d] = dailyTotals(rows);
  assert.equal(d.date, '2026-11-18');
  assert.equal(d.revenue, 20 + 30); // 只算臨停＋盤點後有出場
  assert.equal(d.cars, 3);
  assert.equal(d.freeCars, 1);
  assert.equal(d.count['員工'], 1);
});

test('產生 Excel', async () => {
  const rows = classifySessions(sessions, { rate: 10, freeMin: 15, now: Date.parse('2026-11-18T08:00:00Z') });
  const buf = await buildReportXlsx(rows, { rate: 10, freeMin: 15 });
  assert.equal(buf.subarray(0, 2).toString(), 'PK'); // xlsx 是 zip
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['每日統計', '停車明細']);
  assert.equal(wb.getWorksheet('每日統計').getRow(2).getCell(3).value, 50);
  assert.equal(wb.getWorksheet('停車明細').rowCount, sessions.length + 1);
});
