// 匯出 Excel：只放原始進出資料（車牌、進場、出場、停留），不分類、不計費、不註記
export function rawRows(sessions, { from, to } = {}) {
  const inRange = (t) => t && (!from || t >= from) && (!to || t < to);
  return sessions
    .filter((s) => inRange(s.entry_time) || inRange(s.exit_time))
    .map((s) => ({
      plate: s.plate,
      entry: s.entry_time || null,
      exit: s.exit_time || null,
      minutes: s.entry_time && s.exit_time ? Math.round((Date.parse(s.exit_time) - Date.parse(s.entry_time)) / 60000) : null,
    }))
    .sort((a, b) => (a.entry || a.exit).localeCompare(b.entry || b.exit));
}

export async function buildRawXlsx(rows, { tzOffsetMin = 480 } = {}) {
  const { default: ExcelJS } = await import('exceljs');
  const off = tzOffsetMin * 60e3;
  // Excel 的日期沒有時區：直接存「當地時間」
  const xd = (iso) => (iso ? new Date(Date.parse(iso) + off) : null);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('停車紀錄');
  ws.columns = [
    { header: '車牌', key: 'plate', width: 12 },
    { header: '進場時間', key: 'entry', width: 18, style: { numFmt: 'yyyy/mm/dd hh:mm:ss' } },
    { header: '出場時間', key: 'exit', width: 18, style: { numFmt: 'yyyy/mm/dd hh:mm:ss' } },
    { header: '停留（分鐘）', key: 'minutes', width: 12 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of rows) ws.addRow({ ...r, entry: xd(r.entry), exit: xd(r.exit) });
  ws.autoFilter = { from: 'A1', to: 'D1' };
  return Buffer.from(await wb.xlsx.writeBuffer());
}
