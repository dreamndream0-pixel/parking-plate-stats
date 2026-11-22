import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rawRows, buildRawXlsx } from '../lib/report.js';

const sessions = [
  { plate: 'B', entry_time: '2026-11-18T03:00:00Z', exit_time: '2026-11-18T04:30:00Z', monthly: { mask: 'x' } },
  { plate: 'A', entry_time: '2026-11-18T01:00:00Z', exit_time: null },
  { plate: 'C', entry_time: null, exit_time: '2026-11-18T05:00:00Z' },
  { plate: 'OLD', entry_time: '2026-11-10T01:00:00Z', exit_time: '2026-11-10T02:00:00Z' },
];

test('只匯出原始進出資料', async () => {
  const rows = rawRows(sessions, { from: '2026-11-17T16:00:00Z', to: '2026-11-18T16:00:00Z' });
  assert.deepEqual(rows, [
    { plate: 'A', entry: '2026-11-18T01:00:00Z', exit: null, minutes: null },
    { plate: 'B', entry: '2026-11-18T03:00:00Z', exit: '2026-11-18T04:30:00Z', minutes: 90 },
    { plate: 'C', entry: null, exit: '2026-11-18T05:00:00Z', minutes: null },
  ]);
  const buf = await buildRawXlsx(rows);
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.getWorksheet('停車紀錄');
  assert.deepEqual(ws.getRow(1).values.slice(1), ['車牌', '進場時間', '出場時間', '停留（分鐘）']);
  assert.equal(ws.rowCount, 4);
  assert.equal(ws.columnCount, 4);
  // 台灣時間 11:00
  assert.equal(ws.getRow(3).getCell(2).value.toISOString(), '2026-11-18T11:00:00.000Z');
});
