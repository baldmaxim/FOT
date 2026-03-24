type ViolationType = 'late' | 'underwork' | 'early' | 'absence';

interface IViolationMapped {
  date: string;
  type: ViolationType;
  first_entry: string | null;
  last_exit: string | null;
  total_hours: number | null;
  deviation: string;
  dateFormatted: string;
}

interface IEmployeeSummary {
  name: string;
  position: string;
  department: string;
  late: number;
  underwork: number;
  early: number;
  absence: number;
  total: number;
  violations: IViolationMapped[];
}

export const exportDisciplineExcel = async (
  filtered: IEmployeeSummary[],
  allEmployees: IEmployeeSummary[],
  monthLabel: string,
) => {
  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const source = filtered.length > 0 ? filtered : allEmployees;

  const thinBorder: any = {
    top: { style: 'thin' }, left: { style: 'thin' },
    bottom: { style: 'thin' }, right: { style: 'thin' },
  };
  const detailStyles: Record<string, { font: string; bg: string }> = {
    late: { font: 'FFDC2626', bg: 'FFFFF7ED' },
    underwork: { font: 'FF7C3AED', bg: 'FFF5F3FF' },
    early: { font: 'FF2563EB', bg: 'FFEFF6FF' },
    absence: { font: 'FFDC2626', bg: 'FFFEF2F2' },
  };

  const buildRating = (type: ViolationType, sheetName: string, countLabel: string) => {
    const ws = wb.addWorksheet(sheetName);
    ws.columns = [
      { header: '№', key: 'num', width: 5 },
      { header: 'ФИО', key: 'name', width: 35 },
      { header: 'Должность', key: 'position', width: 22 },
      { header: 'Отдел', key: 'department', width: 28 },
      { header: countLabel, key: 'count', width: 22 },
      { header: 'Детали', key: 'details', width: 60 },
    ];

    const headerRow = ws.getRow(1);
    headerRow.height = 28;
    for (let col = 1; col <= 6; col++) {
      const cell = headerRow.getCell(col);
      cell.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    }

    const sorted = source.filter(e => e[type] > 0).sort((a, b) => b[type] - a[type]);
    const ds = detailStyles[type] || detailStyles.late;

    sorted.forEach((e, i) => {
      const details = e.violations
        .filter(v => v.type === type)
        .map(v => {
          const entry = v.first_entry ? v.first_entry.slice(0, 5) : '—';
          const exit = v.last_exit ? v.last_exit.slice(0, 5) : '—';
          if (type === 'late') {
            return `${v.dateFormatted} — приход в ${entry} (опоздание ${v.deviation.replace('+', '')})`;
          }
          if (type === 'early') {
            const dev = v.deviation.replace('-', '');
            const [eh, em] = (v.first_entry || '09:00').split(':').map(Number);
            const expMin = eh * 60 + em + 9 * 60;
            const expH = String(Math.floor(expMin / 60)).padStart(2, '0');
            const expM = String(expMin % 60).padStart(2, '0');
            return `${v.dateFormatted} — ${entry}→${exit}, норма ${expH}:${expM} (${dev} раньше)`;
          }
          if (type === 'absence') {
            const dev = v.deviation.replace('Отсутствие ', '');
            const worked = v.total_hours !== null ? `${Math.floor(v.total_hours)}ч ${Math.round((v.total_hours % 1) * 60)}м` : '—';
            return `${v.dateFormatted} — ${entry}→${exit}, присутствие ${worked} (отсутствие ${dev})`;
          }
          return `${v.dateFormatted} — ${entry}→${exit}, недоработка ${v.deviation}`;
        })
        .join('\n');

      const row = ws.addRow({ num: i + 1, name: e.name, position: e.position, department: e.department, count: e[type], details });
      row.getCell('num').alignment = { horizontal: 'center', vertical: 'middle' };
      row.getCell('name').alignment = { vertical: 'middle' };
      row.getCell('position').alignment = { vertical: 'middle', wrapText: true };
      row.getCell('department').alignment = { vertical: 'middle', wrapText: true };
      row.getCell('count').alignment = { horizontal: 'center', vertical: 'middle' };
      row.getCell('count').font = { bold: true, size: 11 };
      row.getCell('details').alignment = { vertical: 'top', wrapText: true };
      row.getCell('details').font = { bold: true, size: 10, color: { argb: ds.font } };
      row.getCell('details').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ds.bg } };

      if (i % 2 === 1) {
        ['num', 'name', 'position', 'department', 'count'].forEach(key => {
          const cell = row.getCell(key);
          if (!cell.fill || !(cell.fill as { fgColor?: unknown }).fgColor) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
          }
        });
      }
    });

    ws.eachRow(row => { row.eachCell(cell => { cell.border = thinBorder; }); });
  };

  buildRating('late', 'Рейтинг опозданий', 'Кол-во опозданий');
  buildRating('underwork', 'Рейтинг недоработок', 'Кол-во недоработок');
  buildRating('early', 'Рейтинг ранних уходов', 'Кол-во ранних уходов');
  buildRating('absence', 'Отсутствия более 3ч', 'Кол-во отсутствий');

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Аналитика_дисциплины_${monthLabel.replace(/\s+/g, '_')}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
};
