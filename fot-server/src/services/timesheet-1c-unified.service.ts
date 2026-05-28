import ExcelJS from 'exceljs';
import { query } from '../config/postgres.js';
import { defangCsvCell } from '../utils/file-validation.utils.js';
import type { IDepartmentTimesheetData } from './timesheet-export.service.js';
import {
  buildEmployeeRowsForOneC,
  buildObjectRowsForOneC,
  listObjectExportTargets,
  writeTimesheetWorkbookBuffer,
  type IOneCDisplayDayValue,
  type IOneCExportRow,
} from './timesheet-excel.service.js';

const MONTH_NAMES_FULL = ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

const MAX_DAY_COLUMNS = 31;

const COL_NUM = 1;
const COL_FIO = 2;
const COL_DAY_START = 3;
const COL_TOTAL = COL_DAY_START + MAX_DAY_COLUMNS;
const COL_DEPARTMENT = COL_TOTAL + 1;
const COL_OBJECT_ADDRESS = COL_DEPARTMENT + 1;

const HEADER_ROW = 2;
const DATA_START_ROW = 3;

const thinBorder: Partial<ExcelJS.Borders> = {
  top: { style: 'thin' },
  left: { style: 'thin' },
  bottom: { style: 'thin' },
  right: { style: 'thin' },
};

const headerFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC0C0C0' } };
const underworkFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF59D' } };
const weekendFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E0E0' } };

interface IUnifiedRow {
  departmentNameSort: string;
  fullNameSort: string;
  objectNameSort: string;
  oneCRow: IOneCExportRow;
  departmentName: string;
  objectAddress: string;
}

const cloneFill = (fill: ExcelJS.Fill): ExcelJS.Fill => JSON.parse(JSON.stringify(fill)) as ExcelJS.Fill;

const collectObjectIds = (departmentsData: IDepartmentTimesheetData[]): string[] => {
  const ids = new Set<string>();
  for (const data of departmentsData) {
    for (const entry of data.objectEntries) {
      if (entry.object_id) ids.add(entry.object_id);
    }
  }
  return [...ids];
};

const fetchObjectAddressMap = async (objectIds: string[]): Promise<Map<string, string>> => {
  const map = new Map<string, string>();
  if (objectIds.length === 0) return map;
  const rows = await query<{ id: string; alt_name: string | null; name: string }>(
    'SELECT id, alt_name, name FROM skud_objects WHERE id = ANY($1::uuid[])',
    [objectIds],
  );
  for (const row of rows) {
    const altName = row.alt_name?.trim();
    map.set(row.id, altName && altName.length > 0 ? altName : row.name);
  }
  return map;
};

const isOneCRowEmpty = (row: IOneCExportRow): boolean => {
  if (row.totalHours > 0) return false;
  for (const value of row.dayValues.values()) {
    if (value.label) return false;
    if (value.hours > 0) return false;
  }
  return true;
};

const buildRowsForDepartment = (
  data: IDepartmentTimesheetData,
  objectAddressMap: Map<string, string>,
): IUnifiedRow[] => {
  const rows: IUnifiedRow[] = [];
  const targets = listObjectExportTargets(data);
  const seenFullNames = new Set<string>();

  for (const target of targets) {
    const objectRows = buildObjectRowsForOneC(data, target);
    const objectAddress = target.object_id
      ? (objectAddressMap.get(target.object_id) ?? target.object_name)
      : '';
    for (const oneCRow of objectRows) {
      seenFullNames.add(oneCRow.fullName);
      rows.push({
        departmentNameSort: data.departmentName,
        fullNameSort: oneCRow.fullName,
        objectNameSort: target.object_name,
        oneCRow,
        departmentName: data.departmentName,
        objectAddress,
      });
    }
  }

  // Сотрудники без выходов на объекты — отпуск/больничный/прогул и пр.
  // Если у сотрудника есть строки по объектам, его «общая» статус-строка не нужна.
  for (const employeeRow of buildEmployeeRowsForOneC(data)) {
    if (seenFullNames.has(employeeRow.fullName)) continue;
    if (isOneCRowEmpty(employeeRow)) continue;
    rows.push({
      departmentNameSort: data.departmentName,
      fullNameSort: employeeRow.fullName,
      objectNameSort: '',
      oneCRow: employeeRow,
      departmentName: data.departmentName,
      objectAddress: '',
    });
  }

  return rows;
};

const writeDayCell = (cell: ExcelJS.Cell, dayValue: IOneCDisplayDayValue | undefined): void => {
  cell.border = thinBorder;
  cell.alignment = { horizontal: 'center', vertical: 'middle' };
  if (!dayValue) return;
  if (dayValue.isWeekend && !dayValue.label && !dayValue.hours) {
    cell.fill = cloneFill(weekendFill);
    return;
  }
  if (dayValue.label) {
    cell.value = dayValue.label;
    return;
  }
  if (dayValue.hours > 0) {
    cell.value = dayValue.hours;
    if (dayValue.isUnderwork) {
      cell.fill = cloneFill(underworkFill);
    }
  }
};

export async function buildUnified1CWorkbook(
  month: number,
  year: number,
  departmentsData: IDepartmentTimesheetData[],
): Promise<ExcelJS.Workbook> {
  const objectAddressMap = await fetchObjectAddressMap(collectObjectIds(departmentsData));

  const rows: IUnifiedRow[] = [];
  for (const data of departmentsData) {
    rows.push(...buildRowsForDepartment(data, objectAddressMap));
  }
  rows.sort((a, b) => {
    const byDept = a.departmentNameSort.localeCompare(b.departmentNameSort, 'ru');
    if (byDept !== 0) return byDept;
    const byFio = a.fullNameSort.localeCompare(b.fullNameSort, 'ru');
    if (byFio !== 0) return byFio;
    return a.objectNameSort.localeCompare(b.objectNameSort, 'ru');
  });

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Табель 1С');
  worksheet.properties.dyDescent = 0.25;

  const monthTitle = `Табель за ${MONTH_NAMES_FULL[month]} ${year}`;
  const titleRow = worksheet.getRow(1);
  titleRow.getCell(1).value = monthTitle;
  worksheet.mergeCells(1, 1, 1, COL_OBJECT_ADDRESS);
  titleRow.getCell(1).font = { bold: true, size: 12 };
  titleRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
  titleRow.height = 20;

  const headerRow = worksheet.getRow(HEADER_ROW);
  headerRow.getCell(COL_NUM).value = '№';
  headerRow.getCell(COL_FIO).value = 'ФИО';
  for (let day = 1; day <= MAX_DAY_COLUMNS; day++) {
    headerRow.getCell(COL_DAY_START + day - 1).value = day;
  }
  headerRow.getCell(COL_TOTAL).value = 'Итого';
  headerRow.getCell(COL_DEPARTMENT).value = 'Отдел';
  headerRow.getCell(COL_OBJECT_ADDRESS).value = 'Адрес объекта';
  for (let col = 1; col <= COL_OBJECT_ADDRESS; col++) {
    const cell = headerRow.getCell(col);
    cell.font = { bold: true };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.fill = cloneFill(headerFill);
    cell.border = thinBorder;
  }
  headerRow.height = 24;

  worksheet.getColumn(COL_NUM).width = 5;
  worksheet.getColumn(COL_FIO).width = 32;
  for (let day = 1; day <= MAX_DAY_COLUMNS; day++) {
    worksheet.getColumn(COL_DAY_START + day - 1).width = 4;
  }
  worksheet.getColumn(COL_TOTAL).width = 7;
  worksheet.getColumn(COL_DEPARTMENT).width = 26;
  worksheet.getColumn(COL_OBJECT_ADDRESS).width = 32;

  rows.forEach((row, index) => {
    const rowNumber = DATA_START_ROW + index;
    const sheetRow = worksheet.getRow(rowNumber);
    sheetRow.getCell(COL_NUM).value = index + 1;
    sheetRow.getCell(COL_FIO).value = defangCsvCell(row.oneCRow.fullName);
    sheetRow.getCell(COL_NUM).alignment = { horizontal: 'center', vertical: 'middle' };
    sheetRow.getCell(COL_FIO).alignment = { horizontal: 'left', vertical: 'middle' };
    sheetRow.getCell(COL_NUM).border = thinBorder;
    sheetRow.getCell(COL_FIO).border = thinBorder;

    for (let day = 1; day <= MAX_DAY_COLUMNS; day++) {
      const cell = sheetRow.getCell(COL_DAY_START + day - 1);
      writeDayCell(cell, row.oneCRow.dayValues.get(day));
    }

    const totalCell = sheetRow.getCell(COL_TOTAL);
    totalCell.border = thinBorder;
    totalCell.alignment = { horizontal: 'center', vertical: 'middle' };
    if (row.oneCRow.totalHours > 0) {
      totalCell.value = row.oneCRow.totalHours;
    }

    const deptCell = sheetRow.getCell(COL_DEPARTMENT);
    deptCell.value = row.departmentName;
    deptCell.border = thinBorder;
    deptCell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };

    const addressCell = sheetRow.getCell(COL_OBJECT_ADDRESS);
    addressCell.value = row.objectAddress;
    addressCell.border = thinBorder;
    addressCell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
  });

  worksheet.views = [{ state: 'frozen', xSplit: COL_FIO, ySplit: HEADER_ROW }];

  worksheet.pageSetup.paperSize = 9;
  worksheet.pageSetup.orientation = 'landscape';
  worksheet.pageSetup.fitToPage = true;
  worksheet.pageSetup.fitToWidth = 1;
  worksheet.pageSetup.fitToHeight = 0;

  return workbook;
}

export { writeTimesheetWorkbookBuffer };
