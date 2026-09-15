/**
 * «Управление кадрами → Экспорт»: xlsx ровно текущей таблицы. Один лист, без мета-строк,
 * 10 колонок в порядке экрана, строки — в порядке сортировки экрана, № — после сортировки.
 */
import ExcelJS from 'exceljs';
import { defangCsvCell } from '../utils/file-validation.utils.js';
import { DATE_NUM_FMT, isoDateToExcelDate } from './employees-export-excel.service.js';

export const STAFF_VIEW_COLUMNS: ReadonlyArray<{ name: string; width: number }> = [
  { name: '№', width: 7 },
  { name: 'ФИО', width: 38 },
  { name: 'Отдел', width: 36 },
  { name: 'Должность', width: 32 },
  { name: 'Дата трудоустройства', width: 15 },
  { name: 'Дата рождения', width: 15 },
  { name: 'График', width: 24 },
  { name: 'Объект', width: 30 },
  { name: 'Комментарий', width: 48 },
  { name: 'Признак', width: 12 },
];

const HIRE_DATE_COL = 5;
const BIRTH_DATE_COL = 6;

export interface IStaffViewExportRow {
  fullName: string;
  department: string;
  position: string;
  /** YYYY-MM-DD или null. */
  hireDate: string | null;
  birthDate: string | null;
  schedule: string;
  object: string;
  comment: string;
  sign: string;
}

export function buildStaffViewWorkbook(rows: readonly IStaffViewExportRow[]): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet('Сотрудники');
  STAFF_VIEW_COLUMNS.forEach((column, index) => {
    ws.getColumn(index + 1).width = column.width;
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  ws.addTable({
    name: 'Staff_View',
    ref: 'A1',
    headerRow: true,
    totalsRow: false,
    style: { theme: 'TableStyleMedium2', showRowStripes: true },
    columns: STAFF_VIEW_COLUMNS.map(column => ({ name: column.name, filterButton: true })),
    rows: rows.map((row, index) => [
      index + 1,
      defangCsvCell(row.fullName),
      defangCsvCell(row.department),
      defangCsvCell(row.position),
      isoDateToExcelDate(row.hireDate),
      isoDateToExcelDate(row.birthDate),
      defangCsvCell(row.schedule),
      defangCsvCell(row.object),
      defangCsvCell(row.comment),
      defangCsvCell(row.sign),
    ]),
  });

  for (let rowNumber = 2; rowNumber <= rows.length + 1; rowNumber += 1) {
    const row = ws.getRow(rowNumber);
    row.getCell(HIRE_DATE_COL).numFmt = DATE_NUM_FMT;
    row.getCell(BIRTH_DATE_COL).numFmt = DATE_NUM_FMT;
    row.getCell(9).alignment = { wrapText: true, vertical: 'top' };
  }
  return workbook;
}
