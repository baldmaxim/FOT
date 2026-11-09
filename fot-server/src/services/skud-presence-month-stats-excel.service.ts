/**
 * СКУД: книга xlsx «Сотрудники на объектах — статистика за месяц».
 *
 * Лист месяца: объекты × дни, под объектом свёрнутые (outline 1) строки компаний,
 * «Среднее в день», «Максимум», внизу «Всего» — уникальные люди за день.
 * Лист «Список»: строка на (дата, объект, компания) с автофильтром — для своей сводной.
 *
 * Без pageSetup.fitToPage: вместе с outlineProperties ExcelJS 4.4.0 пишет <sheetPr>
 * в неверном порядке (pageSetUpPr перед outlinePr) — Excel предлагает «восстановить» книгу.
 */
import ExcelJS from 'exceljs';
import { defangCsvCell } from '../utils/file-validation.utils.js';
import {
  sumCounts,
  type IPresenceMonthStats,
  type IPresenceMonthStatsRow,
} from './skud-presence-month-stats.service.js';

export interface IPresenceMonthStatsMeta {
  /** «Сентябрь 2026» */
  monthLabel: string;
  objectsLabel: string;
}

const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const HEADER_ROW = 4;

const COLORS = {
  header: 'FF1F4E79',
  headerWeekend: 'FFC0504D',
  weekend: 'FFFCE4E4',
  object: 'FFEEF3F8',
  objectWeekend: 'FFF4DCDC',
  total: 'FFDCE6F1',
  border: 'FFD9DEE5',
  zero: 'FFBFBFBF',
  company: 'FF404040',
  note: 'FF595959',
  white: 'FFFFFFFF',
};

const thin: Partial<ExcelJS.Border> = { style: 'thin', color: { argb: COLORS.border } };
const border: Partial<ExcelJS.Borders> = { top: thin, left: thin, bottom: thin, right: thin };
const solid = (argb: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

const utcDate = (iso: string): Date => new Date(`${iso}T00:00:00Z`);
const weekday = (iso: string): string => WEEKDAYS[utcDate(iso).getUTCDay()];
const isWeekend = (iso: string): boolean => [0, 6].includes(utcDate(iso).getUTCDay());

/** Среднее по дням, когда на строке кто-то был; null — таких дней нет. */
export function averageOfActiveDays(counts: number[]): number | null {
  const active = counts.filter(value => value > 0);
  return active.length > 0 ? sumCounts(active) / active.length : null;
}

export function buildPresenceMonthStatsWorkbook(
  stats: IPresenceMonthStats,
  meta: IPresenceMonthStatsMeta,
): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  buildMatrixSheet(workbook, stats, meta);
  buildListSheet(workbook, stats);
  return workbook;
}

function buildMatrixSheet(
  workbook: ExcelJS.Workbook,
  stats: IPresenceMonthStats,
  meta: IPresenceMonthStatsMeta,
): void {
  const { dates } = stats;
  const ws = workbook.addWorksheet(meta.monthLabel, {
    views: [{ state: 'frozen', xSplit: 1, ySplit: HEADER_ROW }],
    pageSetup: { orientation: 'landscape', paperSize: 9 },
  });
  ws.properties.outlineProperties = { summaryBelow: false, summaryRight: false };
  ws.properties.outlineLevelRow = 1;
  // Без dyDescent ExcelJS 4.4.0 теряет свойства строк при записи.
  ws.properties.dyDescent = 0.25;

  const firstDayCol = 2;
  const avgCol = firstDayCol + dates.length;
  const maxCol = avgCol + 1;
  ws.columns = [
    { width: 38 },
    ...dates.map(() => ({ width: 6.5 })),
    { width: 10 },
    // Ровно 9 ExcelJS считает шириной «по умолчанию» и не пишет в <cols>.
    { width: 9.5 },
  ];

  const lowerLabel = `${meta.monthLabel.charAt(0).toLowerCase()}${meta.monthLabel.slice(1)}`;
  ws.getCell(1, 1).value = `Сотрудники на объектах — ${lowerLabel}`;
  ws.getCell(1, 1).font = { bold: true, size: 14 };
  ws.getCell(2, 1).value = 'Число людей, входивших за день на точки объекта (СКУД). '
    + 'Человек на нескольких объектах за день учтён на каждом, в строке «Всего» — один раз. '
    + '«Среднее в день» — по дням, когда на объекте кто-то был. '
    + 'Компания — по назначению сотрудника на тот день. «+» слева раскрывает компании.';
  ws.getCell(2, 1).font = { italic: true, size: 10, color: { argb: COLORS.note } };
  ws.getCell(3, 1).value = defangCsvCell(`Объекты: ${meta.objectsLabel}`);
  ws.getCell(3, 1).font = { italic: true, size: 10, color: { argb: COLORS.note } };

  const header = ws.getRow(HEADER_ROW);
  header.height = 32;
  header.getCell(1).value = 'Объект / компания';
  dates.forEach((date, index) => {
    header.getCell(firstDayCol + index).value = `${date.slice(8, 10)}.${date.slice(5, 7)}\n${weekday(date)}`;
  });
  header.getCell(avgCol).value = 'Среднее\nв день';
  header.getCell(maxCol).value = 'Макси-\nмум';
  for (let col = 1; col <= maxCol; col += 1) {
    const cell = header.getCell(col);
    const dayIndex = col - firstDayCol;
    const weekend = dayIndex >= 0 && dayIndex < dates.length && isWeekend(dates[dayIndex]);
    cell.font = { bold: true, size: 10, color: { argb: COLORS.white } };
    cell.fill = solid(weekend ? COLORS.headerWeekend : COLORS.header);
    cell.alignment = { horizontal: col === 1 ? 'left' : 'center', vertical: 'middle', wrapText: true };
    cell.border = border;
  }

  const writeRow = (row: IPresenceMonthStatsRow, kind: 'object' | 'company' | 'total'): ExcelJS.Row => {
    const sheetRow = ws.addRow([]);
    sheetRow.getCell(1).value = defangCsvCell(row.name);
    row.counts.forEach((value, index) => { sheetRow.getCell(firstDayCol + index).value = value; });
    sheetRow.getCell(avgCol).value = averageOfActiveDays(row.counts);
    sheetRow.getCell(maxCol).value = Math.max(0, ...row.counts);

    for (let col = 1; col <= maxCol; col += 1) {
      const cell = sheetRow.getCell(col);
      const dayIndex = col - firstDayCol;
      const isDay = dayIndex >= 0 && dayIndex < dates.length;
      const weekend = isDay && isWeekend(dates[dayIndex]);
      let fill: string | null = null;
      if (kind === 'total') fill = COLORS.total;
      else if (kind === 'object') fill = weekend ? COLORS.objectWeekend : COLORS.object;
      else if (weekend) fill = COLORS.weekend;
      if (fill) cell.fill = solid(fill);
      cell.border = border;
      const zero = isDay && row.counts[dayIndex] === 0;
      const color = zero ? COLORS.zero : kind === 'company' ? COLORS.company : null;
      cell.font = { bold: kind !== 'company', size: 10, ...(color ? { color: { argb: color } } : {}) };
      if (col === 1) {
        cell.alignment = { horizontal: 'left', vertical: 'middle', indent: kind === 'company' ? 2 : 0 };
      } else {
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.numFmt = '0';
      }
    }
    if (kind === 'company') {
      sheetRow.outlineLevel = 1;
      sheetRow.hidden = true;
    }
    return sheetRow;
  };

  for (const object of stats.objects) {
    writeRow(object, 'object');
    for (const company of object.companies) writeRow(company, 'company');
  }
  const totalRow = writeRow(
    { key: 'total', name: 'Всего на объектах (уникальных людей)', counts: stats.total },
    'total',
  );
  const medium: Partial<ExcelJS.Border> = { style: 'medium', color: { argb: COLORS.header } };
  for (let col = 1; col <= maxCol; col += 1) {
    totalRow.getCell(col).border = { ...border, top: medium };
  }
}

function buildListSheet(workbook: ExcelJS.Workbook, stats: IPresenceMonthStats): void {
  const ws = workbook.addWorksheet('Список', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Дата', key: 'date', width: 12 },
    { header: 'День недели', key: 'weekday', width: 12 },
    { header: 'Объект', key: 'object', width: 34 },
    { header: 'Компания', key: 'company', width: 40 },
    { header: 'Сотрудников', key: 'count', width: 13 },
  ];
  ws.getRow(1).eachCell(cell => {
    cell.font = { bold: true, color: { argb: COLORS.white } };
    cell.fill = solid(COLORS.header);
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = border;
  });

  let rows = 0;
  stats.dates.forEach((date, index) => {
    for (const object of stats.objects) {
      for (const company of object.companies) {
        const count = company.counts[index];
        if (count <= 0) continue;
        const row = ws.addRow({
          date: utcDate(date),
          weekday: weekday(date),
          object: defangCsvCell(object.name),
          company: defangCsvCell(company.name),
          count,
        });
        row.getCell('date').numFmt = 'dd.mm.yyyy';
        for (const key of ['date', 'weekday', 'count']) {
          row.getCell(key).alignment = { horizontal: 'center' };
        }
        rows += 1;
      }
    }
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1 + rows, column: 5 } };
}
