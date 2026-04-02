interface IDayGroup {
  date: string;
  events: { event_time: string; direction: string | null; access_point: string | null }[];
  firstEntry: string | null;
  lastExit: string | null;
  totalSeconds: number;
}

const formatDateRu = (dateStr: string): string => {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
};

const formatDuration = (seconds: number): string => {
  if (seconds <= 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}м`;
  if (m === 0) return `${h}ч`;
  return `${h}ч ${m}м`;
};

export const exportEmployeeSkudExcel = async (
  employeeName: string,
  groups: IDayGroup[],
  startDate: string,
  endDate: string,
) => {
  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('СКУД');

  ws.columns = [
    { key: 'time', width: 14 },
    { key: 'direction', width: 16 },
    { key: 'point', width: 30 },
  ];

  const thinBorder: Partial<import('exceljs').Borders> = {
    top: { style: 'thin' }, left: { style: 'thin' },
    bottom: { style: 'thin' }, right: { style: 'thin' },
  };

  // Title row
  const titleRow = ws.addRow([`${employeeName} — СКУД`]);
  ws.mergeCells(titleRow.number, 1, titleRow.number, 3);
  titleRow.getCell(1).font = { bold: true, size: 14 };
  titleRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
  titleRow.height = 28;

  // Period row
  const periodStart = new Date(startDate + 'T00:00:00').toLocaleDateString('ru-RU');
  const periodEnd = new Date(endDate + 'T00:00:00').toLocaleDateString('ru-RU');
  const periodRow = ws.addRow([`Период: ${periodStart} — ${periodEnd}`]);
  ws.mergeCells(periodRow.number, 1, periodRow.number, 3);
  periodRow.getCell(1).font = { size: 11, color: { argb: 'FF666666' } };
  periodRow.getCell(1).alignment = { horizontal: 'center' };

  ws.addRow([]); // empty row

  // Header row
  const headerRow = ws.addRow(['Время', 'Событие', 'Точка прохода']);
  headerRow.height = 24;
  for (let col = 1; col <= 3; col++) {
    const cell = headerRow.getCell(col);
    cell.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = thinBorder;
  }

  // Sort groups chronologically (oldest first)
  const sorted = [...groups].sort((a, b) => a.date.localeCompare(b.date));

  for (const group of sorted) {
    // Day header
    const dayRow = ws.addRow([formatDateRu(group.date)]);
    ws.mergeCells(dayRow.number, 1, dayRow.number, 3);
    dayRow.getCell(1).font = { bold: true, size: 11 };
    dayRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
    dayRow.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };
    dayRow.getCell(1).border = thinBorder;
    dayRow.height = 22;

    // Events sorted by time
    const events = [...group.events].sort((a, b) => a.event_time.localeCompare(b.event_time));

    for (const ev of events) {
      const dirLabel = ev.direction === 'entry' ? 'Вход' : 'Выход';
      const row = ws.addRow([ev.event_time.slice(0, 5), dirLabel, ev.access_point || '—']);

      row.getCell(1).alignment = { horizontal: 'center' };
      row.getCell(2).alignment = { horizontal: 'center' };
      row.getCell(3).alignment = { horizontal: 'left' };

      // Green for entry, red for exit
      if (ev.direction === 'entry') {
        row.getCell(2).font = { color: { argb: 'FF16A34A' }, bold: true };
        row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0FDF4' } };
      } else {
        row.getCell(2).font = { color: { argb: 'FFDC2626' }, bold: true };
        row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF2F2' } };
      }

      for (let col = 1; col <= 3; col++) {
        row.getCell(col).border = thinBorder;
      }
    }

    // Day summary
    const parts: string[] = [];
    if (group.firstEntry) parts.push(`Вход: ${group.firstEntry.slice(0, 5)}`);
    if (group.lastExit) parts.push(`Выход: ${group.lastExit.slice(0, 5)}`);
    const dur = formatDuration(group.totalSeconds);
    if (dur) parts.push(`Отработано: ${dur}`);

    if (parts.length > 0) {
      const summaryRow = ws.addRow([parts.join('  |  ')]);
      ws.mergeCells(summaryRow.number, 1, summaryRow.number, 3);
      summaryRow.getCell(1).font = { italic: true, size: 10, color: { argb: 'FF475569' } };
      summaryRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
      summaryRow.getCell(1).alignment = { horizontal: 'right' };
      summaryRow.getCell(1).border = thinBorder;
    }
  }

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.style.display = 'none';
  const safeName = employeeName.replace(/\s+/g, '_');
  const fmtDate = (d: string) => d.split('-').reverse().join('-');
  a.download = `СКУД_${safeName}_${fmtDate(startDate)}_${fmtDate(endDate)}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};
