/**
 * «Управление кадрами → Экспорт»: xlsx ровно текущей таблицы. Один лист, без мета-строк,
 * колонки — видимые на экране в порядке экрана, строки — в порядке сортировки экрана,
 * № — после сортировки. «№», «ФИО» и «Признак» выгружаются всегда.
 */
import ExcelJS from 'exceljs';
import { defangCsvCell } from '../utils/file-validation.utils.js';
import { DATE_NUM_FMT, isoDateToExcelDate } from './employees-export-excel.service.js';

/** Столбцы, которые на экране скрываются шестерёнкой, — в порядке экрана. */
export const STAFF_VIEW_OPTIONAL_COLUMNS = [
  'department',
  'site',
  'position',
  'hire_date',
  'birth_date',
  'schedule',
  'main_object',
  'comment',
] as const;

export type StaffViewOptionalColumn = typeof STAFF_VIEW_OPTIONAL_COLUMNS[number];

/** Без параметра columns (старый клиент) — прежний набор: всё, кроме «Участка». */
export const STAFF_VIEW_DEFAULT_COLUMNS: readonly StaffViewOptionalColumn[] =
  STAFF_VIEW_OPTIONAL_COLUMNS.filter(column => column !== 'site');

const MAX_COLUMNS_PARAM_LENGTH = 200;

export type StaffViewColumnsParseResult = { ok: true; columns: StaffViewOptionalColumn[] } | { ok: false };

/**
 * columns — ключи через запятую. Нет параметра — прежний набор; '' — только «№», «ФИО», «Признак»;
 * повтор параметра, лишняя длина или неизвестный ключ — ошибка. Порядок — всегда порядок экрана.
 */
export function parseStaffViewColumns(raw: unknown): StaffViewColumnsParseResult {
  if (raw === undefined) return { ok: true, columns: [...STAFF_VIEW_DEFAULT_COLUMNS] };
  if (typeof raw !== 'string' || raw.length > MAX_COLUMNS_PARAM_LENGTH) return { ok: false };
  const keys = raw.split(',').map(key => key.trim()).filter(Boolean);
  if (!keys.every(key => (STAFF_VIEW_OPTIONAL_COLUMNS as readonly string[]).includes(key))) return { ok: false };
  return { ok: true, columns: STAFF_VIEW_OPTIONAL_COLUMNS.filter(column => keys.includes(column)) };
}

export interface IStaffViewExportRow {
  fullName: string;
  department: string;
  site: string;
  position: string;
  /** YYYY-MM-DD или null. */
  hireDate: string | null;
  birthDate: string | null;
  schedule: string;
  object: string;
  comment: string;
  sign: string;
}

type StaffViewColumnKey = 'num' | 'name' | StaffViewOptionalColumn | 'sign';

interface IStaffViewColumn {
  key: StaffViewColumnKey;
  name: string;
  width: number;
}

const COLUMNS: Record<StaffViewColumnKey, IStaffViewColumn> = {
  num: { key: 'num', name: '№', width: 7 },
  name: { key: 'name', name: 'ФИО', width: 38 },
  department: { key: 'department', name: 'Отдел', width: 36 },
  site: { key: 'site', name: 'Участок', width: 28 },
  position: { key: 'position', name: 'Должность', width: 32 },
  hire_date: { key: 'hire_date', name: 'Дата трудоустройства', width: 15 },
  birth_date: { key: 'birth_date', name: 'Дата рождения', width: 15 },
  schedule: { key: 'schedule', name: 'График', width: 24 },
  main_object: { key: 'main_object', name: 'Объект', width: 30 },
  comment: { key: 'comment', name: 'Комментарий', width: 48 },
  sign: { key: 'sign', name: 'Признак', width: 12 },
};

/** Колонки файла: фиксированные + выбранные, в порядке экрана. */
export function staffViewColumns(selected: readonly StaffViewOptionalColumn[]): IStaffViewColumn[] {
  const optional = STAFF_VIEW_OPTIONAL_COLUMNS.filter(column => selected.includes(column));
  return [COLUMNS.num, COLUMNS.name, ...optional.map(column => COLUMNS[column]), COLUMNS.sign];
}

const cellValue = (key: StaffViewColumnKey, row: IStaffViewExportRow, index: number): ExcelJS.CellValue => {
  switch (key) {
    case 'num': return index + 1;
    case 'name': return defangCsvCell(row.fullName);
    case 'department': return defangCsvCell(row.department);
    case 'site': return defangCsvCell(row.site);
    case 'position': return defangCsvCell(row.position);
    case 'hire_date': return isoDateToExcelDate(row.hireDate);
    case 'birth_date': return isoDateToExcelDate(row.birthDate);
    case 'schedule': return defangCsvCell(row.schedule);
    case 'main_object': return defangCsvCell(row.object);
    case 'comment': return defangCsvCell(row.comment);
    case 'sign': return defangCsvCell(row.sign);
  }
};

export function buildStaffViewWorkbook(
  rows: readonly IStaffViewExportRow[],
  selected: readonly StaffViewOptionalColumn[],
): ExcelJS.Workbook {
  const columns = staffViewColumns(selected);
  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet('Сотрудники');
  columns.forEach((column, index) => {
    ws.getColumn(index + 1).width = column.width;
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  ws.addTable({
    name: 'Staff_View',
    ref: 'A1',
    headerRow: true,
    totalsRow: false,
    style: { theme: 'TableStyleMedium2', showRowStripes: true },
    columns: columns.map(column => ({ name: column.name, filterButton: true })),
    rows: rows.map((row, index) => columns.map(column => cellValue(column.key, row, index))),
  });

  const columnNumber = (key: StaffViewColumnKey): number => columns.findIndex(column => column.key === key) + 1;
  const dateColumns = [columnNumber('hire_date'), columnNumber('birth_date')].filter(number => number > 0);
  const commentColumn = columnNumber('comment');
  for (let rowNumber = 2; rowNumber <= rows.length + 1; rowNumber += 1) {
    const row = ws.getRow(rowNumber);
    for (const number of dateColumns) row.getCell(number).numFmt = DATE_NUM_FMT;
    if (commentColumn > 0) row.getCell(commentColumn).alignment = { wrapText: true, vertical: 'top' };
  }
  return workbook;
}
