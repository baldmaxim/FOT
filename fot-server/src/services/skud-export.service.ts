import ExcelJS from 'exceljs';
import { formatDateToISO } from '../utils/date.utils.js';
import { defangCsvCell } from '../utils/file-validation.utils.js';
import type { IDisciplineViolation } from '../types/skud.types.js';

const MONTH_NAMES = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

export type DisciplineViolationType = IDisciplineViolation['type'];

export interface DisciplineExportViolation extends IDisciplineViolation {
  dateFormatted: string;
}

export interface DisciplineExportEmployeeSummary {
  employee_id: number;
  name: string;
  position: string;
  department: string;
  departmentId: string | null;
  late: number;
  underwork: number;
  early: number;
  absence: number;
  total: number;
  worked_hours: number;
  norm_hours: number;
  violations: DisciplineExportViolation[];
}

interface EmployeeSkudExportEvent {
  id: number | string;
  event_date: string;
  event_time: string;
  access_point: string | null;
  direction: 'entry' | 'exit' | null;
}

interface EmployeeSkudDayGroup {
  date: string;
  events: EmployeeSkudExportEvent[];
  firstEntry: string | null;
  lastExit: string | null;
  totalSeconds: number;
}

const thinBorder: Partial<ExcelJS.Borders> = {
  top: { style: 'thin' },
  left: { style: 'thin' },
  bottom: { style: 'thin' },
  right: { style: 'thin' },
};

function timeToSeconds(time: string): number {
  const [hours, minutes, seconds = 0] = time.split(':').map(Number);
  return hours * 3600 + minutes * 60 + seconds;
}

function nowSeconds(): number {
  const now = new Date();
  return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
}

function isToday(dateStr: string): boolean {
  return dateStr === formatDateToISO(new Date());
}

function formatDateRu(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00`);
  return date.toLocaleDateString('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return '';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours === 0) return `${minutes}м`;
  if (minutes === 0) return `${hours}ч`;
  return `${hours}ч ${minutes}м`;
}

function formatDateShort(dateStr: string): string {
  const [year, month, day] = dateStr.split('-');
  return `${day}.${month}.${year}`;
}

function formatWorkedHours(hours: number | null): string {
  if (hours === null) return '—';
  const h = Math.floor(hours);
  const m = Math.round((hours % 1) * 60);
  return m > 0 ? `${h}ч ${m}м` : `${h}ч`;
}

function calculateWorkedSeconds(events: EmployeeSkudExportEvent[], internalPoints: Set<string>, date: string): number {
  const filtered = events.filter(event => !event.access_point || !internalPoints.has(event.access_point));
  const sorted = [...filtered].sort((a, b) => a.event_time.localeCompare(b.event_time));

  let totalSeconds = 0;
  let entryTime: number | null = null;
  let entryPoint: string | null = null;

  for (const event of sorted) {
    if (event.direction === 'entry') {
      // Строгая политика «только полные циклы»: открытый вход затирается только при
      // совпадении точки (повторный пробив того же турникета); вход по другой точке
      // открытый вход НЕ сбрасывает. Паритет с buildRawFallbackSummary и
      // recalculate_skud_daily_summary (миграция 163).
      if (entryTime === null || event.access_point === entryPoint) {
        entryTime = timeToSeconds(event.event_time);
        entryPoint = event.access_point;
      }
      continue;
    }

    if (event.direction === 'exit' && entryTime !== null) {
      totalSeconds += timeToSeconds(event.event_time) - entryTime;
      entryTime = null;
      entryPoint = null;
    }
  }

  if (entryTime !== null && isToday(date)) {
    totalSeconds += Math.max(0, nowSeconds() - entryTime);
  }

  return totalSeconds;
}

function groupEmployeeEventsByDay(events: EmployeeSkudExportEvent[], internalPoints: Set<string>): EmployeeSkudDayGroup[] {
  const grouped = new Map<string, EmployeeSkudExportEvent[]>();

  for (const event of events) {
    const dayEvents = grouped.get(event.event_date) || [];
    dayEvents.push(event);
    grouped.set(event.event_date, dayEvents);
  }

  const groups: EmployeeSkudDayGroup[] = [];

  for (const [date, dayEvents] of grouped.entries()) {
    const sorted = [...dayEvents].sort((a, b) => a.event_time.localeCompare(b.event_time));
    const externalEvents = sorted.filter(event => !event.access_point || !internalPoints.has(event.access_point));
    const entries = externalEvents.filter(event => event.direction === 'entry');
    const exits = externalEvents.filter(event => event.direction === 'exit');
    const lastExternalEvent = externalEvents.length > 0 ? externalEvents[externalEvents.length - 1] : null;
    const stillOnSite = lastExternalEvent?.direction === 'entry' && isToday(date);

    groups.push({
      date,
      events: sorted,
      firstEntry: entries.length > 0 ? entries[0].event_time : null,
      lastExit: stillOnSite ? null : (exits.length > 0 ? exits[exits.length - 1].event_time : null),
      totalSeconds: calculateWorkedSeconds(sorted, internalPoints, date),
    });
  }

  groups.sort((a, b) => a.date.localeCompare(b.date));
  return groups;
}

function buildDisciplineDetail(violation: DisciplineExportViolation): string {
  const entry = violation.first_entry ? violation.first_entry.slice(0, 5) : '—';
  const exit = violation.last_exit ? violation.last_exit.slice(0, 5) : '—';

  if (violation.type === 'late') {
    return `${violation.dateFormatted} — приход в ${entry} (опоздание ${violation.deviation.replace('+', '')})`;
  }

  if (violation.type === 'early') {
    const deviation = violation.deviation.replace('-', '');
    const [entryHours, entryMinutes] = (violation.first_entry || '09:00').split(':').map(Number);
    const expectedLeaveMinutes = entryHours * 60 + entryMinutes + 9 * 60;
    const expectedHours = String(Math.floor(expectedLeaveMinutes / 60)).padStart(2, '0');
    const expectedMinutes = String(expectedLeaveMinutes % 60).padStart(2, '0');
    return `${violation.dateFormatted} — ${entry}→${exit}, норма ${expectedHours}:${expectedMinutes} (${deviation} раньше)`;
  }

  if (violation.type === 'absence') {
    const worked = formatWorkedHours(violation.total_hours);
    const deviation = violation.deviation.replace('Отсутствие ', '');
    return `${violation.dateFormatted} — ${entry}→${exit}, присутствие ${worked} (отсутствие ${deviation})`;
  }

  return `${violation.dateFormatted} — ${entry}→${exit}, недоработка ${violation.deviation}`;
}

export function sanitizeExportFileName(value: string): string {
  return value.replace(/[\/\\?%*:|"<>]/g, '_');
}

export function formatMonthRangeLabel(startMonth: string, endMonth: string): string {
  const [startYear, startMonthNumber] = startMonth.split('-').map(Number);
  const [endYear, endMonthNumber] = endMonth.split('-').map(Number);
  const startLabel = `${MONTH_NAMES[startMonthNumber - 1]} ${startYear}`;
  const endLabel = `${MONTH_NAMES[endMonthNumber - 1]} ${endYear}`;
  return startMonth === endMonth ? startLabel : `${startLabel} - ${endLabel}`;
}

export function buildEmployeeSkudWorkbook(params: {
  employeeName: string;
  startDate: string;
  endDate: string;
  events: EmployeeSkudExportEvent[];
  internalPoints: Set<string>;
}): ExcelJS.Workbook {
  const { employeeName, startDate, endDate, events, internalPoints } = params;
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('СКУД');
  const groups = groupEmployeeEventsByDay(events, internalPoints);

  worksheet.columns = [
    { key: 'time', width: 14 },
    { key: 'direction', width: 16 },
    { key: 'point', width: 30 },
  ];

  const titleRow = worksheet.addRow([`${defangCsvCell(employeeName)} — СКУД`]);
  worksheet.mergeCells(titleRow.number, 1, titleRow.number, 3);
  titleRow.getCell(1).font = { bold: true, size: 14 };
  titleRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
  titleRow.height = 28;

  const periodStart = formatDateShort(startDate);
  const periodEnd = formatDateShort(endDate);
  const periodRow = worksheet.addRow([`Период: ${periodStart} — ${periodEnd}`]);
  worksheet.mergeCells(periodRow.number, 1, periodRow.number, 3);
  periodRow.getCell(1).font = { size: 11, color: { argb: 'FF666666' } };
  periodRow.getCell(1).alignment = { horizontal: 'center' };

  worksheet.addRow([]);

  const headerRow = worksheet.addRow(['Время', 'Событие', 'Точка прохода']);
  headerRow.height = 24;
  for (let col = 1; col <= 3; col += 1) {
    const cell = headerRow.getCell(col);
    cell.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = thinBorder;
  }

  for (const group of groups) {
    const dayRow = worksheet.addRow([formatDateRu(group.date)]);
    worksheet.mergeCells(dayRow.number, 1, dayRow.number, 3);
    dayRow.getCell(1).font = { bold: true, size: 11 };
    dayRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
    dayRow.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };
    dayRow.getCell(1).border = thinBorder;
    dayRow.height = 22;

    for (const event of group.events) {
      const directionLabel = event.direction === 'entry' ? 'Вход' : event.direction === 'exit' ? 'Выход' : 'Событие';
      const row = worksheet.addRow([event.event_time.slice(0, 5), directionLabel, defangCsvCell(event.access_point || '—')]);

      row.getCell(1).alignment = { horizontal: 'center' };
      row.getCell(2).alignment = { horizontal: 'center' };
      row.getCell(3).alignment = { horizontal: 'left' };

      if (event.direction === 'entry') {
        row.getCell(2).font = { color: { argb: 'FF16A34A' }, bold: true };
        row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0FDF4' } };
      } else if (event.direction === 'exit') {
        row.getCell(2).font = { color: { argb: 'FFDC2626' }, bold: true };
        row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF2F2' } };
      }

      for (let col = 1; col <= 3; col += 1) {
        row.getCell(col).border = thinBorder;
      }
    }

    const parts: string[] = [];
    if (group.firstEntry) parts.push(`Вход: ${group.firstEntry.slice(0, 5)}`);
    if (group.lastExit) parts.push(`Выход: ${group.lastExit.slice(0, 5)}`);
    const duration = formatDuration(group.totalSeconds);
    if (duration) parts.push(`Отработано: ${duration}`);

    if (parts.length > 0) {
      const summaryRow = worksheet.addRow([parts.join('  |  ')]);
      worksheet.mergeCells(summaryRow.number, 1, summaryRow.number, 3);
      summaryRow.getCell(1).font = { italic: true, size: 10, color: { argb: 'FF475569' } };
      summaryRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
      summaryRow.getCell(1).alignment = { horizontal: 'right' };
      summaryRow.getCell(1).border = thinBorder;
    }
  }

  return workbook;
}

function formatExportHours(hours: number): string {
  if (!hours || hours <= 0) return '0ч';
  const hrs = Math.floor(hours);
  const mins = Math.round((hours - hrs) * 60);
  return mins > 0 ? `${hrs}ч ${mins}м` : `${hrs}ч`;
}

export function buildDisciplineWorkbook(params: {
  employees: DisciplineExportEmployeeSummary[];
}): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  const { employees } = params;

  // Лист «Сводка» — повторяет таблицу на странице (отдел, ФИО, статистика, часы).
  const summarySheet = workbook.addWorksheet('Сводка');
  summarySheet.columns = [
    { header: '№', key: 'num', width: 5 },
    { header: 'Отдел', key: 'department', width: 28 },
    { header: 'ФИО', key: 'name', width: 35 },
    { header: 'Должность', key: 'position', width: 22 },
    { header: 'Опоздания', key: 'late', width: 12 },
    { header: 'Недоработки', key: 'underwork', width: 13 },
    { header: 'Ранние уходы', key: 'early', width: 13 },
    { header: 'Отсутствия', key: 'absence', width: 12 },
    { header: 'Часов отработано', key: 'worked', width: 17 },
    { header: 'Часов по графику', key: 'norm', width: 17 },
  ];
  const summaryHeader = summarySheet.getRow(1);
  summaryHeader.height = 28;
  for (let col = 1; col <= 10; col += 1) {
    const cell = summaryHeader.getCell(col);
    cell.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = thinBorder;
  }
  employees.forEach((employee, index) => {
    const row = summarySheet.addRow({
      num: index + 1,
      department: defangCsvCell(employee.department),
      name: defangCsvCell(employee.name),
      position: defangCsvCell(employee.position),
      late: employee.late || '—',
      underwork: employee.underwork || '—',
      early: employee.early || '—',
      absence: employee.absence || '—',
      worked: formatExportHours(employee.worked_hours),
      norm: formatExportHours(employee.norm_hours),
    });
    row.getCell('num').alignment = { horizontal: 'center', vertical: 'middle' };
    (['late', 'underwork', 'early', 'absence', 'worked', 'norm'] as const).forEach(key => {
      row.getCell(key).alignment = { horizontal: 'center', vertical: 'middle' };
    });
    if (index % 2 === 1) {
      row.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
      });
    }
    row.eachCell(cell => {
      cell.border = thinBorder;
    });
  });

  const detailStyles: Record<DisciplineViolationType, { font: string; bg: string }> = {
    late: { font: 'FFDC2626', bg: 'FFFFF7ED' },
    underwork: { font: 'FF7C3AED', bg: 'FFF5F3FF' },
    early: { font: 'FF2563EB', bg: 'FFEFF6FF' },
    absence: { font: 'FFDC2626', bg: 'FFFEF2F2' },
  };

  const buildRatingSheet = (
    type: DisciplineViolationType,
    sheetName: string,
    countLabel: string,
  ) => {
    const worksheet = workbook.addWorksheet(sheetName);
    worksheet.columns = [
      { header: '№', key: 'num', width: 5 },
      { header: 'ФИО', key: 'name', width: 35 },
      { header: 'Должность', key: 'position', width: 22 },
      { header: 'Отдел', key: 'department', width: 28 },
      { header: countLabel, key: 'count', width: 22 },
      { header: 'Детали', key: 'details', width: 60 },
    ];

    const headerRow = worksheet.getRow(1);
    headerRow.height = 28;
    for (let col = 1; col <= 6; col += 1) {
      const cell = headerRow.getCell(col);
      cell.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = thinBorder;
    }

    const sorted = employees
      .filter(employee => employee[type] > 0)
      .sort((left, right) => right[type] - left[type]);
    const style = detailStyles[type];

    sorted.forEach((employee, index) => {
      const details = employee.violations
        .filter(violation => violation.type === type)
        .map(buildDisciplineDetail)
        .join('\n');

      const row = worksheet.addRow({
        num: index + 1,
        name: defangCsvCell(employee.name),
        position: defangCsvCell(employee.position),
        department: defangCsvCell(employee.department),
        count: employee[type],
        details: defangCsvCell(details),
      });

      row.getCell('num').alignment = { horizontal: 'center', vertical: 'middle' };
      row.getCell('name').alignment = { vertical: 'middle' };
      row.getCell('position').alignment = { vertical: 'middle', wrapText: true };
      row.getCell('department').alignment = { vertical: 'middle', wrapText: true };
      row.getCell('count').alignment = { horizontal: 'center', vertical: 'middle' };
      row.getCell('count').font = { bold: true, size: 11 };
      row.getCell('details').alignment = { vertical: 'top', wrapText: true };
      row.getCell('details').font = { bold: true, size: 10, color: { argb: style.font } };
      row.getCell('details').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: style.bg } };

      if (index % 2 === 1) {
        ['num', 'name', 'position', 'department', 'count'].forEach(key => {
          const cell = row.getCell(key);
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
        });
      }

      row.eachCell(cell => {
        cell.border = thinBorder;
      });
    });
  };

  buildRatingSheet('late', 'Рейтинг опозданий', 'Кол-во опозданий');
  buildRatingSheet('underwork', 'Рейтинг недоработок', 'Кол-во недоработок');
  buildRatingSheet('early', 'Рейтинг ранних уходов', 'Кол-во ранних уходов');
  buildRatingSheet('absence', 'Отсутствия более 3ч', 'Кол-во отсутствий');

  return workbook;
}
