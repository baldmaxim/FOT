/**
 * Книга xlsx для панели «Детализация» (Табель → по сотруднику).
 *
 * Раскладка повторяет экран: строка дня (дата, день недели, вход, выход, часы/статус),
 * под ней — проходы СКУД, «Перерыв» и незачтённые события. События собраны в группу
 * Excel (outlineLevel 1), поэтому день можно свернуть кнопкой слева — как раскрытие
 * дня в панели.
 */
import ExcelJS from 'exceljs';
import { defangCsvCell } from '../utils/file-validation.utils.js';
import { formatFailureType } from '../utils/skud-failure-types.js';
import { formatSecondsLabel, type IDetailExportData } from './skud-timesheet-detail-export.service.js';

const HEADER_FILL = 'FF2563EB';
const DAY_FILL = 'FFE2E8F0';
const FAILURE_FILL = 'FFFEF2F2';
const ENTRY_FONT = 'FF16A34A';
const EXIT_FONT = 'FFDC2626';
const MUTED_FONT = 'FF64748B';
const HEADER_ROWS = 4;

const thinBorder: Partial<ExcelJS.Borders> = {
  top: { style: 'thin' },
  left: { style: 'thin' },
  bottom: { style: 'thin' },
  right: { style: 'thin' },
};

function formatDateShort(dateStr: string): string {
  const [year, month, day] = dateStr.split('-');
  return `${day}.${month}.${year}`;
}

function formatWeekday(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('ru-RU', { weekday: 'long' });
}

const formatTime = (time: string): string => time.slice(0, 5);

export function buildTimesheetDetailWorkbook(data: IDetailExportData): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet('Детализация');

  ws.columns = [
    { key: 'time', width: 13 },
    { key: 'event', width: 22 },
    { key: 'point', width: 32 },
    { key: 'entry', width: 10 },
    { key: 'exit', width: 10 },
    { key: 'hours', width: 14 },
    { key: 'note', width: 38 },
  ];
  // summaryBelow: false — строка дня стоит НАД своими событиями.
  ws.properties.outlineProperties = { summaryBelow: false, summaryRight: false };
  ws.properties.outlineLevelRow = 1;
  // Без dyDescent ExcelJS 4.4.0 теряет свойства строк при записи.
  ws.properties.dyDescent = 0.25;

  const titleRow = ws.addRow([`${defangCsvCell(data.employeeName)} — Детализация`]);
  ws.mergeCells(titleRow.number, 1, titleRow.number, 7);
  titleRow.getCell(1).font = { bold: true, size: 14 };
  titleRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
  titleRow.height = 28;

  const periodRow = ws.addRow([
    `Период: ${formatDateShort(data.startDate)} — ${formatDateShort(data.endDate)}`,
  ]);
  ws.mergeCells(periodRow.number, 1, periodRow.number, 7);
  periodRow.getCell(1).font = { size: 11, color: { argb: MUTED_FONT } };
  periodRow.getCell(1).alignment = { horizontal: 'center' };

  ws.addRow([]);

  const headerRow = ws.addRow(['Время', 'Событие', 'Точка прохода', 'Вход', 'Выход', 'Часы', 'Примечание']);
  headerRow.height = 24;
  for (let col = 1; col <= 7; col += 1) {
    const cell = headerRow.getCell(col);
    cell.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = thinBorder;
  }
  ws.views = [{ state: 'frozen', ySplit: HEADER_ROWS }];

  for (const day of data.days) {
    const weekdayParts = [formatWeekday(day.date)];
    if (day.isToday) weekdayParts.push('(сегодня)');
    if (day.isPreHoliday) weekdayParts.push('• предпраздничный (−1ч)');

    const dayRow = ws.addRow([
      formatDateShort(day.date),
      weekdayParts.join(' '),
      '',
      day.firstEntry ? formatTime(day.firstEntry) : '',
      day.lastExit ? formatTime(day.lastExit) : '',
      day.hoursLabel,
      day.travelNote ? defangCsvCell(day.travelNote) : '',
    ]);
    dayRow.height = 22;
    dayRow.outlineLevel = 0;
    for (let col = 1; col <= 7; col += 1) {
      const cell = dayRow.getCell(col);
      cell.font = { bold: col <= 2 || col === 6, size: 11 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: DAY_FILL } };
      cell.alignment = { horizontal: col === 3 || col === 7 ? 'left' : 'center', vertical: 'middle' };
      cell.border = thinBorder;
    }
    dayRow.getCell(4).font = { bold: true, size: 11, color: { argb: ENTRY_FONT } };
    dayRow.getCell(5).font = { bold: true, size: 11, color: { argb: EXIT_FONT } };
    if (day.travelNote) {
      dayRow.getCell(7).font = { size: 10, italic: true, color: { argb: EXIT_FONT } };
    }

    if (day.items.length === 0) {
      const emptyRow = ws.addRow(['', 'Нет событий СКУД']);
      emptyRow.outlineLevel = 1;
      emptyRow.getCell(2).font = { italic: true, size: 10, color: { argb: MUTED_FONT } };
      continue;
    }

    for (const item of day.items) {
      if (item.kind === 'break') {
        const breakRow = ws.addRow(['', 'Перерыв', '', '', '', formatSecondsLabel(item.breakSeconds)]);
        breakRow.outlineLevel = 1;
        breakRow.getCell(2).font = { italic: true, size: 10, color: { argb: MUTED_FONT } };
        breakRow.getCell(6).font = { italic: true, size: 10, color: { argb: MUTED_FONT } };
        breakRow.getCell(6).alignment = { horizontal: 'center' };
        continue;
      }

      if (item.kind === 'failure') {
        const failure = item.failure;
        const failureRow = ws.addRow([
          formatTime(failure.event_time),
          defangCsvCell(formatFailureType(failure.failure_type)),
          defangCsvCell(failure.access_point || '—'),
          '',
          '',
          'не учтено',
          failure.reason ? defangCsvCell(failure.reason) : '',
        ]);
        failureRow.outlineLevel = 1;
        for (let col = 1; col <= 7; col += 1) {
          const cell = failureRow.getCell(col);
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FAILURE_FILL } };
          cell.font = { size: 10, color: { argb: EXIT_FONT } };
          cell.alignment = { horizontal: col === 3 || col === 7 ? 'left' : 'center', vertical: 'middle' };
        }
        continue;
      }

      const { event, pairDurationSeconds, isInternal } = item;
      const eventRow = ws.addRow([
        formatTime(event.event_time),
        event.direction === 'entry' ? 'Вход' : event.direction === 'exit' ? 'Выход' : 'Событие',
        defangCsvCell(event.access_point || '—'),
        '',
        '',
        pairDurationSeconds !== null && pairDurationSeconds > 0 ? formatSecondsLabel(pairDurationSeconds) : '',
        isInternal ? 'внутренний проход, не в расчёте' : '',
      ]);
      eventRow.outlineLevel = 1;
      for (let col = 1; col <= 7; col += 1) {
        eventRow.getCell(col).alignment = {
          horizontal: col === 3 || col === 7 ? 'left' : 'center',
          vertical: 'middle',
        };
      }
      if (isInternal) {
        eventRow.getCell(2).font = { italic: true, color: { argb: MUTED_FONT } };
        eventRow.getCell(3).font = { italic: true, color: { argb: MUTED_FONT } };
        eventRow.getCell(7).font = { italic: true, size: 10, color: { argb: MUTED_FONT } };
      } else {
        eventRow.getCell(2).font = {
          bold: true,
          color: { argb: event.direction === 'entry' ? ENTRY_FONT : EXIT_FONT },
        };
      }
    }
  }

  if (data.days.length === 0) {
    const emptyRow = ws.addRow(['Нет данных за этот период']);
    ws.mergeCells(emptyRow.number, 1, emptyRow.number, 7);
    emptyRow.getCell(1).font = { italic: true, color: { argb: MUTED_FONT } };
    emptyRow.getCell(1).alignment = { horizontal: 'center' };
  }

  return workbook;
}
