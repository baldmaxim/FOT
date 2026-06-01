import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { getFullDayThresholdHoursForDate, getDayNormHours } from './schedule.service.js';
import type { IDepartmentTimesheetData } from './timesheet-export.service.js';
import type { IResolvedSchedule } from '../types/index.js';
import { defangCsvCell } from '../utils/file-validation.utils.js';

const STATUS_LABELS: Record<string, string> = {
  work: '', sick: 'Б', vacation: 'От', absent: 'Н',
  dayoff: 'В', remote: 'УУ', unpaid: 'С', educational_leave: 'У', manual: '',
};

const thinBorder: Partial<ExcelJS.Borders> = {
  top: { style: 'thin' }, left: { style: 'thin' },
  bottom: { style: 'thin' }, right: { style: 'thin' },
};

const applyA4PrintSetup = (ws: ExcelJS.Worksheet, _titleRows: number): void => {
  ws.pageSetup.paperSize = 9;
  ws.pageSetup.orientation = 'landscape';
  ws.pageSetup.fitToPage = true;
  ws.pageSetup.fitToWidth = 1;
  ws.pageSetup.fitToHeight = 1;
};

/**
 * ExcelJS 4.4.0 рендерит дочерние элементы <sheetPr> в порядке
 * pageSetUpPr → outlinePr, но OOXML (CT_SheetPr) требует outlinePr → pageSetUpPr.
 * Excel строго валидирует по XSD и считает такой файл битым («часть sheet1.xml
 * с ошибкой XML»). Этот хелпер берёт выхлоп writeBuffer, распаковывает zip,
 * меняет порядок внутри <sheetPr> и запаковывает обратно.
 */
export async function writeTimesheetWorkbookBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  const raw = Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer);
  const zip = await JSZip.loadAsync(raw);
  const reorder = (xml: string): string => xml.replace(
    /<sheetPr(\s[^>]*)?>(<pageSetUpPr[^/]*\/>)(<outlinePr[^/]*\/>)<\/sheetPr>/,
    '<sheetPr$1>$3$2</sheetPr>',
  );
  const sheetPaths = Object.keys(zip.files).filter(p => /^xl\/worksheets\/sheet\d+\.xml$/.test(p));
  for (const p of sheetPaths) {
    const content = await zip.file(p)!.async('string');
    zip.file(p, reorder(content));
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
// Цвета как в образце "Тердерный отдел.xls"
const headerFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC0C0C0' } };
const docRowFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDE8DF' } };
const correctedFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFB3E5FC' } };
const underworkFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF59D' } };
// Серый фон для пустых выходных дней календаря (тот же оттенок, что у статуса dayoff).
const weekendFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E0E0' } };
const statusFills: Record<string, ExcelJS.Fill> = {
  sick:              { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFCDD2' } },
  vacation:          { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFBBDEFB' } },
  educational_leave: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFCE93D8' } },
  dayoff:            { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E0E0' } },
  unpaid:            { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF9C4' } },
  absent:            { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF8A80' } },
  remote:            { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC8E6C9' } },
};

const formatHHMM = (decimalHours: number): string => {
  const totalMinutes = Math.round(decimalHours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
};

const CORRECTION_MARK = '*';

const formatExportCellValue = (value: string, corrected?: boolean): string => {
  if (!corrected) return value;
  if (!value.trim()) return CORRECTION_MARK;
  return `${value}${CORRECTION_MARK}`;
};

const pad2 = (n: number) => String(n).padStart(2, '0');

// Column indices
const COL_NUM = 1;
const COL_FIO = 2;
const COL_TAB = 3;
const COL_SOURCE = 4;
const COL_DAY_START = 5;
const ONE_C_DATA_START_ROW = 4;
const ONE_C_DAY_START_COLUMN = 3;
const ONE_C_TOTAL_COLUMN = 34;
const ONE_C_MAX_DAY_COLUMNS = 31;
const ONE_C_TEMPLATE_STYLE_ROW = 4;
const ONE_C_TEMPLATE_DEFAULT_ROW_COUNT = 60;
const ONE_C_TEMPLATE_PATH = path.resolve(__dirname, '../../templates/timesheet-1c-template.xlsx');

export interface IObjectExportTarget {
  object_key: string;
  object_id: string | null;
  object_name: string;
}

const getExportDateSet = (data: IDepartmentTimesheetData): Set<string> => new Set(
  data.exportDays.map(day => `${data.year}-${pad2(data.mon)}-${pad2(day)}`),
);

const hasPositiveHours = (value: number): boolean => value > 0.001;

const isUnderworkHours = (hours: number, thresholdHours: number): boolean => (
  hasPositiveHours(hours) && hours + 0.001 < thresholdHours
);

const getThresholdHoursForDate = (
  data: IDepartmentTimesheetData,
  employeeId: number,
  dateStr: string,
  fallbackSchedule = data.schedulesMap.get(employeeId),
): number => {
  const schedule = data.dailySchedulesMap.get(employeeId)?.get(dateStr) || fallbackSchedule;
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return schedule
    ? getFullDayThresholdHoursForDate(schedule, date, data.calendarMonth)
    : 8;
};

const groupObjectEntriesForExport = (data: IDepartmentTimesheetData): Map<number, Array<{
  object_key: string;
  object_name: string;
  dayMap: Map<string, { hours: number; corrected: boolean }>;
  hasCorrection: boolean;
}>> => {
  const exportDateSet = getExportDateSet(data);
  const grouped = new Map<number, Map<string, {
    object_key: string;
    object_name: string;
    dayMap: Map<string, { hours: number; corrected: boolean }>;
    hasCorrection: boolean;
  }>>();

  for (const entry of data.objectEntries) {
    if (!exportDateSet.has(entry.work_date)) continue;
    if (!grouped.has(entry.employee_id)) {
      grouped.set(entry.employee_id, new Map());
    }
    const byObject = grouped.get(entry.employee_id)!;
    const current = byObject.get(entry.object_key) || {
      object_key: entry.object_key,
      object_name: entry.object_name,
      dayMap: new Map<string, { hours: number; corrected: boolean }>(),
      hasCorrection: false,
    };

    const visibleHours = data.showActualHours
      ? entry.hours_worked
      : (typeof entry.display_hours_worked === 'number' ? entry.display_hours_worked : entry.hours_worked);
    current.dayMap.set(entry.work_date, {
      hours: visibleHours,
      corrected: entry.is_correction,
    });
    current.hasCorrection = current.hasCorrection || entry.is_correction;
    byObject.set(entry.object_key, current);
  }

  const result = new Map<number, Array<{
    object_key: string;
    object_name: string;
    dayMap: Map<string, { hours: number; corrected: boolean }>;
    hasCorrection: boolean;
  }>>();

  for (const [employeeId, byObject] of grouped) {
    const values = [...byObject.values()];
    const distinctObjects = new Set(values.map(item => item.object_key));
    const shouldShowRows = distinctObjects.size > 1 || values.some(item => item.hasCorrection);
    if (!shouldShowRows) continue;

    result.set(employeeId, values.sort((left, right) => left.object_name.localeCompare(right.object_name, 'ru')));
  }

  return result;
};

export const listObjectExportTargets = (data: IDepartmentTimesheetData): IObjectExportTarget[] => {
  const exportDateSet = getExportDateSet(data);
  const byKey = new Map<string, IObjectExportTarget>();

  for (const entry of data.objectEntries) {
    if (!exportDateSet.has(entry.work_date)) continue;
    if (!hasPositiveHours(entry.hours_worked)) continue;
    if (byKey.has(entry.object_key)) continue;
    byKey.set(entry.object_key, {
      object_key: entry.object_key,
      object_id: entry.object_id,
      object_name: entry.object_name,
    });
  }

  return [...byKey.values()].sort((left, right) => left.object_name.localeCompare(right.object_name, 'ru'));
};

export interface IOneCDisplayDayValue {
  hours: number;
  label?: string;
  isUnderwork: boolean;
  /** Пустой выходной день календаря — ячейка без текста, серая заливка. */
  isWeekend?: boolean;
}

export interface IOneCExportRow {
  fullName: string;
  dayValues: Map<number, IOneCDisplayDayValue>;
  totalHours: number;
}

let oneCTemplateBufferPromise: Promise<Buffer> | null = null;

const cloneExcelValue = <T>(value: T): T => (
  value == null ? value : JSON.parse(JSON.stringify(value)) as T
);

const loadOneCTemplateBuffer = async (): Promise<Buffer> => {
  if (!oneCTemplateBufferPromise) {
    oneCTemplateBufferPromise = readFile(ONE_C_TEMPLATE_PATH) as unknown as Promise<Buffer>;
  }
  return Buffer.from(await oneCTemplateBufferPromise);
};

const createOneCTemplateWorkbook = async (sheetName: string): Promise<ExcelJS.Workbook> => {
  const workbook = new ExcelJS.Workbook();
  const templateBuffer = await loadOneCTemplateBuffer();
  await workbook.xlsx.load(templateBuffer as any);
  const worksheet = workbook.getWorksheet(1);
  if (worksheet) {
    worksheet.name = sanitizeSheetName(sheetName) || 'Лист1';
  }
  return workbook;
};

// Студенческие графики (имя содержит «(студент…») — особый случай: при выполнении нормы
// в 1С уходит фиксированная ставка Т-13 (8 ч / 7 ч на предпраздник), а не реальная длина смены.
// Для остальных графиков выгружаем округлённую дневную норму графика (например, 11 ч на 6+0).
const ONE_C_STUDENT_FULL_DAY_HOURS = 8;
const ONE_C_STUDENT_PRE_HOLIDAY_FULL_DAY_HOURS = 7;
const STUDENT_SCHEDULE_NAME_PATTERN = /\(студент/i;

const isStudentSchedule = (schedule?: IResolvedSchedule | null): boolean =>
  Boolean(schedule?.name && STUDENT_SCHEDULE_NAME_PATTERN.test(schedule.name));

const getEffectiveScheduleForDate = (
  data: IDepartmentTimesheetData,
  employeeId: number,
  dateStr: string,
  fallback?: IResolvedSchedule,
): IResolvedSchedule | undefined => (
  data.dailySchedulesMap.get(employeeId)?.get(dateStr)
    || fallback
    || data.schedulesMap.get(employeeId)
);

/**
 * Целые часы для 1С на конкретный день:
 *  - факт ≥ личной нормы дня:
 *      • студенческий график → 8 ч (7 ч на предпраздник);
 *      • остальные → round(dayNormHours) — реальная норма дня (учитывает предпраздник через getDayNormHours).
 *  - факт < нормы → факт, округлённый арифметически до ближайшего целого часа.
 * Допуск 0.001 ч ≈ 4 секунды компенсирует потери точности при хранении total_hours без total_minutes.
 */
const compute1CDayHours = (
  factHours: number,
  dayNormHours: number,
  isPreHoliday: boolean,
  isStudent: boolean,
): number => {
  if (!hasPositiveHours(factHours)) return 0;
  if (dayNormHours > 0 && factHours + 0.001 >= dayNormHours) {
    if (isStudent) {
      return isPreHoliday
        ? ONE_C_STUDENT_PRE_HOLIDAY_FULL_DAY_HOURS
        : ONE_C_STUDENT_FULL_DAY_HOURS;
    }
    return Math.round(dayNormHours);
  }
  return Math.max(0, Math.round(factHours));
};

const isPreHolidayDate = (data: IDepartmentTimesheetData, dateStr: string): boolean => (
  Boolean(data.calendarMonth?.pre_holidays?.includes(dateStr))
);

/**
 * Календарный выходной для серой заливки: суббота/воскресенье ИЛИ праздник
 * производственного календаря (holidays + mandatory_holidays). Не зависит от
 * индивидуального графика сотрудника.
 */
const isCalendarWeekend = (
  dateObj: Date,
  dateStr: string,
  calendar: IDepartmentTimesheetData['calendarMonth'],
): boolean => {
  const dow = dateObj.getDay();
  if (dow === 0 || dow === 6) return true;
  return Boolean(
    calendar?.holidays?.includes(dateStr) ||
    calendar?.mandatory_holidays?.includes(dateStr),
  );
};

const getDayNormForEmployeeOnDate = (
  data: IDepartmentTimesheetData,
  employeeId: number,
  dateStr: string,
  fallbackSchedule = data.schedulesMap.get(employeeId),
): number => {
  const schedule = data.dailySchedulesMap.get(employeeId)?.get(dateStr) || fallbackSchedule;
  if (!schedule) return 0;
  const [year, month, day] = dateStr.split('-').map(Number);
  return getDayNormHours(schedule, new Date(year, month - 1, day), data.calendarMonth);
};

const ensureOneCBodyRows = (worksheet: ExcelJS.Worksheet, lastRow: number): void => {
  const templateRow = worksheet.getRow(ONE_C_TEMPLATE_STYLE_ROW);
  const templateStyles = Array.from({ length: ONE_C_TOTAL_COLUMN }, (_, index) => (
    cloneExcelValue(templateRow.getCell(index + 1).style)
  ));
  const templateHeight = templateRow.height ?? 15.6;

  while (worksheet.rowCount < lastRow) {
    worksheet.addRow([]);
  }

  for (let rowNumber = ONE_C_DATA_START_ROW; rowNumber <= lastRow; rowNumber++) {
    const row = worksheet.getRow(rowNumber);
    row.height = templateHeight;
    for (let column = 1; column <= ONE_C_TOTAL_COLUMN; column++) {
      const cell = row.getCell(column);
      cell.style = cloneExcelValue(templateStyles[column - 1]) || {};
      cell.value = null;
    }
  }
};

export const buildEmployeeRowsForOneC = (data: IDepartmentTimesheetData): IOneCExportRow[] => {
  return data.employees.map(employee => {
    const schedule = data.schedulesMap.get(employee.id);
    const employeeDays = data.dataMap.get(employee.id);
    const dayValues = new Map<number, IOneCDisplayDayValue>();
    let totalHours = 0;

    for (const day of data.exportDays) {
      const dateStr = `${data.year}-${pad2(data.mon)}-${pad2(day)}`;
      const dateObj = new Date(data.year, data.mon - 1, day);
      const markWeekend = (): void => {
        if (isCalendarWeekend(dateObj, dateStr, data.calendarMonth)) {
          dayValues.set(day, { hours: 0, isUnderwork: false, isWeekend: true });
        }
      };
      const entry = employeeDays?.get(dateStr);
      if (!entry) { markWeekend(); continue; }
      const label = STATUS_LABELS[entry.status];
      if (label) {
        dayValues.set(day, { hours: 0, label, isUnderwork: false });
        continue;
      }
      if (!hasPositiveHours(entry.hours)) { markWeekend(); continue; }
      const dayNormHours = getDayNormForEmployeeOnDate(data, employee.id, dateStr, schedule);
      const effectiveSchedule = getEffectiveScheduleForDate(data, employee.id, dateStr, schedule);
      const roundedHours = compute1CDayHours(
        entry.hours,
        dayNormHours,
        isPreHolidayDate(data, dateStr),
        isStudentSchedule(effectiveSchedule),
      );
      if (!roundedHours) { markWeekend(); continue; }
      const thresholdHours = getThresholdHoursForDate(data, employee.id, dateStr, schedule);
      dayValues.set(day, {
        hours: roundedHours,
        isUnderwork: isUnderworkHours(roundedHours, thresholdHours),
      });
      totalHours += roundedHours;
    }

    return {
      fullName: employee.full_name,
      dayValues,
      totalHours,
    };
  });
};

export const buildObjectRowsForOneC = (
  data: IDepartmentTimesheetData,
  target: IObjectExportTarget,
): IOneCExportRow[] => {
  const exportDateSet = getExportDateSet(data);
  const grouped = new Map<number, Map<string, number>>();

  for (const entry of data.objectEntries) {
    if (entry.object_key !== target.object_key) continue;
    if (!exportDateSet.has(entry.work_date)) continue;
    if (!grouped.has(entry.employee_id)) {
      grouped.set(entry.employee_id, new Map());
    }
    const dayMap = grouped.get(entry.employee_id)!;
    const currentHours = dayMap.get(entry.work_date) ?? 0;
    const visibleHours = data.showActualHours
      ? entry.hours_worked
      : (entry.display_hours_worked ?? entry.hours_worked);
    dayMap.set(entry.work_date, currentHours + visibleHours);
  }

  return data.employees
    .filter(employee => grouped.has(employee.id))
    .map(employee => {
      const schedule = data.schedulesMap.get(employee.id);
      const employeeDays = grouped.get(employee.id) || new Map();
      const dayValues = new Map<number, IOneCDisplayDayValue>();
      let totalHours = 0;

      for (const day of data.exportDays) {
        const dateStr = `${data.year}-${pad2(data.mon)}-${pad2(day)}`;
        const hours = employeeDays.get(dateStr) ?? 0;
        if (hasPositiveHours(hours)) {
          const dayNormHours = getDayNormForEmployeeOnDate(data, employee.id, dateStr, schedule);
          const effectiveSchedule = getEffectiveScheduleForDate(data, employee.id, dateStr, schedule);
          const roundedHours = compute1CDayHours(
            hours,
            dayNormHours,
            isPreHolidayDate(data, dateStr),
            isStudentSchedule(effectiveSchedule),
          );
          if (!roundedHours) continue;
          const thresholdHours = getThresholdHoursForDate(data, employee.id, dateStr, schedule);
          dayValues.set(day, {
            hours: roundedHours,
            isUnderwork: isUnderworkHours(roundedHours, thresholdHours),
          });
          totalHours += roundedHours;
        }
        // При экспорте по объектам показываем только часы на конкретном объекте.
        // Статусы не показываем — это общие статусы, не специфичные для этого объекта.
        // Выходные дни по календарю оставляем серыми.
        if (!dayValues.has(day) && isCalendarWeekend(new Date(data.year, data.mon - 1, day), dateStr, data.calendarMonth)) {
          dayValues.set(day, { hours: 0, isUnderwork: false, isWeekend: true });
        }
      }

      return {
        fullName: employee.full_name,
        dayValues,
        totalHours,
      };
    });
};

const writeOneCRow = (
  worksheet: ExcelJS.Worksheet,
  rowNumber: number,
  index: number,
  rowData: IOneCExportRow,
): void => {
  worksheet.getCell(rowNumber, COL_NUM).value = index + 1;
  worksheet.getCell(rowNumber, COL_FIO).value = defangCsvCell(rowData.fullName);

  for (const [day, dayValue] of rowData.dayValues) {
    if (day < 1 || day > ONE_C_MAX_DAY_COLUMNS) continue;
    const cell = worksheet.getCell(rowNumber, ONE_C_DAY_START_COLUMN + day - 1);
    if (dayValue.isWeekend && !dayValue.label && !dayValue.hours) {
      cell.value = null;
      cell.fill = cloneExcelValue(weekendFill);
      continue;
    }
    cell.value = dayValue.label ?? dayValue.hours;
    if (!dayValue.label && dayValue.isUnderwork) {
      cell.fill = cloneExcelValue(underworkFill);
    }
  }

  if (rowData.totalHours > 0) {
    worksheet.getCell(rowNumber, ONE_C_TOTAL_COLUMN).value = rowData.totalHours;
  }
};

const fillOneCWorksheet = (
  worksheet: ExcelJS.Worksheet,
  rows: IOneCExportRow[],
): void => {
  const lastRow = Math.max(
    ONE_C_TEMPLATE_DEFAULT_ROW_COUNT,
    ONE_C_DATA_START_ROW + rows.length - 1,
  );
  ensureOneCBodyRows(worksheet, lastRow);

  rows.forEach((rowData, index) => {
    writeOneCRow(worksheet, ONE_C_DATA_START_ROW + index, index, rowData);
  });
};

export interface IUnifiedOneCRow {
  oneCRow: IOneCExportRow;
  departmentName: string;
  objectAddress: string;
  managerName?: string;
}

const UNIFIED_COL_DEPARTMENT = ONE_C_TOTAL_COLUMN + 1; // 35
const UNIFIED_COL_OBJECT_ADDRESS = ONE_C_TOTAL_COLUMN + 2; // 36
const UNIFIED_COL_MANAGER = ONE_C_TOTAL_COLUMN + 3; // 37
const UNIFIED_HEADER_ROW = ONE_C_DATA_START_ROW - 1; // 3 — шапка шаблона

/**
 * Единый файл для 1С: тот же шаблон, что и одиночный «Как в 1С» (шапка в строке 3,
 * данные с строки 4, дни 1..31, итог в колонке 34), плюс справа колонки «Отдел» (35) и
 * «Адрес объекта» (36) — без них строки разных отделов/объектов неразличимы.
 */
export async function buildUnified1CWorkbookFromTemplate(
  sheetName: string,
  rows: IUnifiedOneCRow[],
): Promise<ExcelJS.Workbook> {
  const workbook = await createOneCTemplateWorkbook(sheetName);
  const worksheet = workbook.getWorksheet(1);
  if (!worksheet) {
    throw new Error('1C template worksheet is missing');
  }

  const lastRow = Math.max(
    ONE_C_TEMPLATE_DEFAULT_ROW_COUNT,
    ONE_C_DATA_START_ROW + rows.length - 1,
  );
  ensureOneCBodyRows(worksheet, lastRow);

  // Шапка доп. колонок (строка 3) — стиль как у шапки «ч/часы».
  const headerStyle = worksheet.getCell(UNIFIED_HEADER_ROW, ONE_C_TOTAL_COLUMN).style;
  const deptHeader = worksheet.getCell(UNIFIED_HEADER_ROW, UNIFIED_COL_DEPARTMENT);
  deptHeader.style = cloneExcelValue(headerStyle) || {};
  deptHeader.value = 'Отдел';
  deptHeader.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  const addressHeader = worksheet.getCell(UNIFIED_HEADER_ROW, UNIFIED_COL_OBJECT_ADDRESS);
  addressHeader.style = cloneExcelValue(headerStyle) || {};
  addressHeader.value = 'Адрес объекта';
  addressHeader.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };

  // Образец стиля тела — ячейка ФИО строки-образца (левое выравнивание текста).
  const bodyStyle = worksheet.getRow(ONE_C_TEMPLATE_STYLE_ROW).getCell(COL_FIO).style;

  // Шапка доп. колонок — стиль как у шапки
  const managerHeader = worksheet.getCell(UNIFIED_HEADER_ROW, UNIFIED_COL_MANAGER);
  managerHeader.style = cloneExcelValue(headerStyle) || {};
  managerHeader.value = 'Руководитель';
  managerHeader.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };

  rows.forEach((row, index) => {
    const rowNumber = ONE_C_DATA_START_ROW + index;
    writeOneCRow(worksheet, rowNumber, index, row.oneCRow);

    const deptCell = worksheet.getCell(rowNumber, UNIFIED_COL_DEPARTMENT);
    deptCell.style = cloneExcelValue(bodyStyle) || {};
    deptCell.value = row.departmentName;
    deptCell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };

    const addressCell = worksheet.getCell(rowNumber, UNIFIED_COL_OBJECT_ADDRESS);
    addressCell.style = cloneExcelValue(bodyStyle) || {};
    addressCell.value = row.objectAddress;
    addressCell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };

    const managerCell = worksheet.getCell(rowNumber, UNIFIED_COL_MANAGER);
    managerCell.style = cloneExcelValue(bodyStyle) || {};
    managerCell.value = row.managerName ?? '';
    managerCell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
  });

  worksheet.getColumn(UNIFIED_COL_DEPARTMENT).width = 26;
  worksheet.getColumn(UNIFIED_COL_OBJECT_ADDRESS).width = 32;
  worksheet.getColumn(UNIFIED_COL_MANAGER).width = 26;

  applyA4PrintSetup(worksheet, 3);
  return workbook;
}

export async function build1CTimesheetWorkbook(
  sheetName: string,
  data: IDepartmentTimesheetData,
): Promise<ExcelJS.Workbook> {
  const workbook = await createOneCTemplateWorkbook(sheetName);
  const worksheet = workbook.getWorksheet(1);
  if (!worksheet) {
    throw new Error('1C template worksheet is missing');
  }
  fillOneCWorksheet(worksheet, buildEmployeeRowsForOneC(data));
  applyA4PrintSetup(worksheet, 3);
  return workbook;
}

export async function build1CObjectTimesheetWorkbook(
  sheetName: string,
  data: IDepartmentTimesheetData,
  target: IObjectExportTarget,
): Promise<ExcelJS.Workbook> {
  const workbook = await createOneCTemplateWorkbook(sheetName);
  const worksheet = workbook.getWorksheet(1);
  if (!worksheet) {
    throw new Error('1C template worksheet is missing');
  }
  fillOneCWorksheet(worksheet, buildObjectRowsForOneC(data, target));
  applyA4PrintSetup(worksheet, 3);
  return workbook;
}

export function buildTimesheetSheet(
  wb: ExcelJS.Workbook,
  sheetName: string,
  data: IDepartmentTimesheetData,
): void {
  const {
    employees,
    schedulesMap,
    calendarMonth,
    dataMap,
    year,
    mon,
    daysInMonth,
    exportDays,
    departmentName,
  } = data;
  const exportDaysCount = exportDays.length;

  const colDays = COL_DAY_START + exportDaysCount;   // first "Дней" col
  const colHours = colDays + 2;                        // first "Часов" col
  const totalCols = colHours + 1;                      // last col

  const ws = wb.addWorksheet(sheetName);
  // Баг ExcelJS 4.4.0: worksheet.properties.dyDescent по дефолту = 55 (должно быть 0.25).
  // Excel считает x14ac:dyDescent="55" невалидным и отказывается открывать файл.
  ws.properties.dyDescent = 0.25;
  ws.properties.outlineLevelRow = 1;
  ws.properties.outlineProperties = {
    summaryBelow: false,
    summaryRight: false,
  };
  const objectRowsByEmployee = groupObjectEntriesForExport(data);

  // Column widths
  ws.getColumn(COL_NUM).width = 6;
  ws.getColumn(COL_FIO).width = 30;
  ws.getColumn(COL_TAB).width = 12;
  ws.getColumn(COL_SOURCE).width = 22;
  for (let d = 0; d < exportDaysCount; d++) ws.getColumn(COL_DAY_START + d).width = 7;
  ws.getColumn(colDays).width = 5;
  ws.getColumn(colDays + 1).width = 5;
  ws.getColumn(colHours).width = 7;
  ws.getColumn(colHours + 1).width = 7;

  const centerAlign: Partial<ExcelJS.Alignment> = { horizontal: 'center', vertical: 'middle', wrapText: true };

  // --- Row 1: Подразделение ---
  ws.mergeCells(1, 1, 1, totalCols);
  const r1 = ws.getCell(1, 1);
  r1.value = `Подразделение: ${departmentName}`;
  r1.font = { bold: true, size: 12 };
  r1.alignment = { horizontal: 'left', vertical: 'middle' };
  ws.getRow(1).height = 20;

  // --- Row 2: Title ---
  ws.mergeCells(2, 1, 2, totalCols);
  const r2 = ws.getCell(2, 1);
  const firstExportDay = exportDays[0] ?? 1;
  const lastExportDay = exportDays[exportDays.length - 1] ?? daysInMonth;
  const startDateStr = `${pad2(firstExportDay)}.${pad2(mon)}.${String(year).slice(2)}`;
  const endDateStr = `${pad2(lastExportDay)}.${pad2(mon)}.${String(year).slice(2)}`;
  r2.value = `Табель учета отработанного времени (предварительная форма). За период с ${startDateStr} по ${endDateStr}`;
  r2.font = { bold: true, size: 10 };
  r2.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  ws.getRow(2).height = 30;

  // --- Row 3: note ---
  ws.mergeCells(3, 1, 3, totalCols);
  const r3 = ws.getCell(3, 1);
  r3.value = `${CORRECTION_MARK} — корректировка`;
  r3.font = { size: 9, italic: true, color: { argb: 'FF546E7A' } };
  r3.alignment = { horizontal: 'left', vertical: 'middle' };
  ws.getRow(3).height = 18;

  // --- Row 4-5: Headers ---
  // Row 4: merged labels
  ws.mergeCells(4, COL_NUM, 5, COL_NUM);
  const hNum = ws.getCell(4, COL_NUM);
  hNum.value = '№ П/П';
  hNum.font = { bold: true, size: 8 };
  hNum.alignment = centerAlign;
  hNum.fill = headerFill;

  ws.mergeCells(4, COL_FIO, 5, COL_FIO);
  const hFio = ws.getCell(4, COL_FIO);
  hFio.value = 'ФИО';
  hFio.font = { bold: true, size: 8 };
  hFio.alignment = centerAlign;
  hFio.fill = headerFill;

  ws.mergeCells(4, COL_TAB, 5, COL_TAB);
  const hTab = ws.getCell(4, COL_TAB);
  hTab.value = 'Табельный\nномер';
  hTab.font = { bold: true, size: 8 };
  hTab.alignment = centerAlign;
  hTab.fill = headerFill;

  ws.mergeCells(4, COL_SOURCE, 5, COL_SOURCE);
  const hSrc = ws.getCell(4, COL_SOURCE);
  hSrc.value = 'Строка';
  hSrc.font = { bold: true, size: 8 };
  hSrc.alignment = centerAlign;
  hSrc.fill = headerFill;

  // Days header merged across row 4
  ws.mergeCells(4, COL_DAY_START, 4, COL_DAY_START + exportDaysCount - 1);
  const hDays = ws.getCell(4, COL_DAY_START);
  hDays.value = 'Отметки о явках и неявках на работу по числам месяца';
  hDays.font = { bold: true, size: 8 };
  hDays.alignment = centerAlign;
  hDays.fill = headerFill;

  // "Отработано" merged across Дней + Часов (4 cols) in row 4
  ws.mergeCells(4, colDays, 4, totalCols);
  const hWorked = ws.getCell(4, colDays);
  hWorked.value = 'Отработано';
  hWorked.font = { bold: true, size: 8 };
  hWorked.alignment = centerAlign;
  hWorked.fill = headerFill;

  // Row 5: day numbers + Дней/Часов
  for (let d = 0; d < exportDaysCount; d++) {
    const cell = ws.getCell(5, COL_DAY_START + d);
    cell.value = exportDays[d];
    cell.font = { bold: true, size: 8 };
    cell.alignment = centerAlign;
    cell.fill = headerFill;
  }

  ws.mergeCells(5, colDays, 5, colDays + 1);
  const hDaysLabel = ws.getCell(5, colDays);
  hDaysLabel.value = 'Дней';
  hDaysLabel.font = { bold: true, size: 8 };
  hDaysLabel.alignment = centerAlign;
  hDaysLabel.fill = headerFill;

  ws.mergeCells(5, colHours, 5, totalCols);
  const hHoursLabel = ws.getCell(5, colHours);
  hHoursLabel.value = 'Часов';
  hHoursLabel.font = { bold: true, size: 8 };
  hHoursLabel.alignment = centerAlign;
  hHoursLabel.fill = headerFill;

  // --- Row 6: column group numbers ---
  const row6 = ws.getRow(6);
  row6.getCell(COL_NUM).value = 1;
  row6.getCell(COL_FIO).value = 2;
  row6.getCell(COL_TAB).value = 3;
  row6.getCell(COL_SOURCE).value = 4;
  ws.mergeCells(6, COL_DAY_START, 6, COL_DAY_START + exportDaysCount - 1);
  row6.getCell(COL_DAY_START).value = 5;
  ws.mergeCells(6, colDays, 6, totalCols);
  row6.getCell(colDays).value = 6;
  for (let c = 1; c <= totalCols; c++) {
    const cell = row6.getCell(c);
    cell.font = { size: 7, color: { argb: 'FF999999' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  }

  // --- Employee data: fact row + hidden object details ---
  const DATA_START_ROW = 7;

  let grandDocDays = 0;
  let grandDocHours = 0;
  let currentRow = DATA_START_ROW;

  employees.forEach((emp, idx) => {
    const sched = schedulesMap.get(emp.id);
    const empData = dataMap.get(emp.id);
    const objectRows = objectRowsByEmployee.get(emp.id) || [];

    const rowDefinitions = [
      { kind: 'summary' as const, label: 'Факт' },
      ...objectRows.map(item => ({ kind: 'object' as const, label: `↳ ${item.object_name}`, item })),
    ];

    const blockStartRow = currentRow;
    const blockEndRow = currentRow + rowDefinitions.length - 1;

    rowDefinitions.forEach((definition, rowIndex) => {
      const rowNumber = blockStartRow + rowIndex;
      const row = ws.getRow(rowNumber);
      const sourceCell = ws.getCell(rowNumber, COL_SOURCE);
      const isSummaryRow = definition.kind === 'summary';
      const isObjectRow = definition.kind === 'object';

      if (isSummaryRow) {
        ws.getCell(rowNumber, COL_NUM).value = idx + 1;
        ws.getCell(rowNumber, COL_NUM).alignment = centerAlign;
        ws.getCell(rowNumber, COL_FIO).value = defangCsvCell(emp.full_name);
        ws.getCell(rowNumber, COL_FIO).alignment = { vertical: 'middle', wrapText: true };
        ws.getCell(rowNumber, COL_TAB).value = emp.sigur_employee_id ?? '';
        ws.getCell(rowNumber, COL_TAB).alignment = centerAlign;
      }

      if (isObjectRow) {
        row.outlineLevel = 1;
        row.hidden = true;
      }

      sourceCell.value = definition.label;
      sourceCell.alignment = isObjectRow
        ? { horizontal: 'left', vertical: 'middle', wrapText: true }
        : centerAlign;
      sourceCell.font = { size: 8, italic: isObjectRow };
      sourceCell.fill = docRowFill;

      let rowDaysCount = 0;
      let rowHoursSum = 0;

      exportDays.forEach((day, dayIndex) => {
        const dateStr = `${year}-${pad2(mon)}-${pad2(day)}`;
        const dateObj = new Date(year, mon - 1, day);
        const col = COL_DAY_START + dayIndex;
        const cell = ws.getCell(rowNumber, col);
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.font = { size: 8 };

        const thresholdHours = getThresholdHoursForDate(data, emp.id, dateStr, sched);
        // Данные дня имеют приоритет над выходным: работа/согласование в выходной
        // должны показываться. Серую заливку даём только пустым выходным.
        const isWeekend = isCalendarWeekend(dateObj, dateStr, calendarMonth);

        if (isSummaryRow) {
          cell.fill = docRowFill;
          const entry = empData?.get(dateStr);
          if (!entry) {
            cell.value = '';
            if (isWeekend) cell.fill = weekendFill;
            return;
          }

          const label = STATUS_LABELS[entry.status];
          if (label) {
            cell.value = formatExportCellValue(label, entry.corrected);
            if (statusFills[entry.status]) cell.fill = statusFills[entry.status];
          } else if (entry.hours > 0) {
            cell.value = formatExportCellValue(formatHHMM(entry.hours), entry.corrected);
            rowDaysCount++;
            rowHoursSum += entry.hours;
            if (isUnderworkHours(entry.hours, thresholdHours)) cell.fill = underworkFill;
            else if (entry.corrected) cell.fill = correctedFill;
          } else {
            cell.value = formatExportCellValue('', entry.corrected);
            if (isWeekend && !entry.corrected) cell.fill = weekendFill;
          }
          return;
        }

        if (isObjectRow) {
          cell.fill = docRowFill;
          const objectEntry = definition.item.dayMap.get(dateStr);
          if (!objectEntry || objectEntry.hours <= 0) {
            cell.value = '';
            if (isWeekend) cell.fill = weekendFill;
            return;
          }

          cell.value = formatExportCellValue(formatHHMM(objectEntry.hours), objectEntry.corrected);
          if (isUnderworkHours(objectEntry.hours, thresholdHours)) cell.fill = underworkFill;
          else if (objectEntry.corrected) cell.fill = correctedFill;
          rowDaysCount++;
          rowHoursSum += objectEntry.hours;
        }
      });

      ws.mergeCells(rowNumber, colDays, rowNumber, colDays + 1);
      const daysCell = ws.getCell(rowNumber, colDays);
      daysCell.value = rowDaysCount;
      daysCell.alignment = centerAlign;
      daysCell.fill = docRowFill;

      ws.mergeCells(rowNumber, colHours, rowNumber, totalCols);
      const hoursCell = ws.getCell(rowNumber, colHours);
      hoursCell.value = rowHoursSum > 0 ? formatHHMM(rowHoursSum) : '0:00';
      hoursCell.alignment = centerAlign;
      hoursCell.fill = docRowFill;

      if (isSummaryRow) {
        grandDocDays += rowDaysCount;
        grandDocHours += rowHoursSum;
      }
    });

    currentRow = blockEndRow + 1;
  });

  // --- ИТОГО row ---
  const itogoDocRow = currentRow;

  ws.mergeCells(itogoDocRow, COL_NUM, itogoDocRow, COL_SOURCE);
  const itogoCell = ws.getCell(itogoDocRow, COL_NUM);
  itogoCell.value = 'ИТОГО';
  itogoCell.font = { bold: true, size: 10 };
  itogoCell.alignment = centerAlign;

  // Дней итого
  ws.mergeCells(itogoDocRow, colDays, itogoDocRow, colDays + 1);
  ws.getCell(itogoDocRow, colDays).value = grandDocDays;
  ws.getCell(itogoDocRow, colDays).alignment = centerAlign;
  ws.getCell(itogoDocRow, colDays).font = { bold: true };

  // Часов итого
  ws.mergeCells(itogoDocRow, colHours, itogoDocRow, totalCols);
  ws.getCell(itogoDocRow, colHours).value = formatHHMM(grandDocHours);
  ws.getCell(itogoDocRow, colHours).alignment = centerAlign;
  ws.getCell(itogoDocRow, colHours).font = { bold: true };

  // --- Borders ---
  const lastDataRow = itogoDocRow;
  for (let r = 4; r <= lastDataRow; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= totalCols; c++) {
      row.getCell(c).border = thinBorder;
    }
  }

  applyA4PrintSetup(ws, 6);
}

export function buildObjectTimesheetSheet(
  wb: ExcelJS.Workbook,
  sheetName: string,
  data: IDepartmentTimesheetData,
  target: IObjectExportTarget,
): void {
  const {
    employees,
    schedulesMap,
    calendarMonth,
    objectEntries,
    year,
    mon,
    daysInMonth,
    exportDays,
    departmentName,
  } = data;
  const exportDateSet = getExportDateSet(data);
  const exportDaysCount = exportDays.length;
  const colDays = COL_DAY_START + exportDaysCount;
  const colHours = colDays + 2;
  const totalCols = colHours + 1;

  const objectEntriesByEmployeeDate = new Map<number, Map<string, { hours: number; corrected: boolean }>>();
  for (const entry of objectEntries) {
    if (entry.object_key !== target.object_key) continue;
    if (!exportDateSet.has(entry.work_date)) continue;
    if (!objectEntriesByEmployeeDate.has(entry.employee_id)) {
      objectEntriesByEmployeeDate.set(entry.employee_id, new Map());
    }
    objectEntriesByEmployeeDate.get(entry.employee_id)!.set(entry.work_date, {
      hours: entry.display_hours_worked ?? entry.hours_worked,
      corrected: entry.is_correction,
    });
  }

  const filteredEmployees = employees
    .filter(employee => objectEntriesByEmployeeDate.has(employee.id))
    .sort((left, right) => left.full_name.localeCompare(right.full_name, 'ru'));

  const ws = wb.addWorksheet(sheetName);
  ws.properties.dyDescent = 0.25;
  const centerAlign: Partial<ExcelJS.Alignment> = { horizontal: 'center', vertical: 'middle', wrapText: true };

  ws.getColumn(COL_NUM).width = 6;
  ws.getColumn(COL_FIO).width = 30;
  ws.getColumn(COL_TAB).width = 12;
  ws.getColumn(COL_SOURCE).width = 18;
  for (let d = 0; d < exportDaysCount; d++) ws.getColumn(COL_DAY_START + d).width = 7;
  ws.getColumn(colDays).width = 5;
  ws.getColumn(colDays + 1).width = 5;
  ws.getColumn(colHours).width = 7;
  ws.getColumn(colHours + 1).width = 7;

  ws.mergeCells(1, 1, 1, totalCols);
  const r1 = ws.getCell(1, 1);
  r1.value = `Подразделение: ${departmentName}`;
  r1.font = { bold: true, size: 12 };
  r1.alignment = { horizontal: 'left', vertical: 'middle' };
  ws.getRow(1).height = 20;

  ws.mergeCells(2, 1, 2, totalCols);
  const r2 = ws.getCell(2, 1);
  r2.value = `Объект: ${target.object_name}`;
  r2.font = { bold: true, size: 11 };
  r2.alignment = { horizontal: 'left', vertical: 'middle' };
  ws.getRow(2).height = 20;

  ws.mergeCells(3, 1, 3, totalCols);
  const r3 = ws.getCell(3, 1);
  const firstExportDay = exportDays[0] ?? 1;
  const lastExportDay = exportDays[exportDays.length - 1] ?? daysInMonth;
  const startDateStr = `${pad2(firstExportDay)}.${pad2(mon)}.${String(year).slice(2)}`;
  const endDateStr = `${pad2(lastExportDay)}.${pad2(mon)}.${String(year).slice(2)}`;
  r3.value = `Табель учета отработанного времени по объекту. За период с ${startDateStr} по ${endDateStr}`;
  r3.font = { bold: true, size: 10 };
  r3.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  ws.getRow(3).height = 30;

  ws.mergeCells(4, 1, 4, totalCols);
  const r4 = ws.getCell(4, 1);
  r4.value = `${CORRECTION_MARK} — корректировка`;
  r4.font = { size: 9, italic: true, color: { argb: 'FF546E7A' } };
  r4.alignment = { horizontal: 'left', vertical: 'middle' };
  ws.getRow(4).height = 18;

  ws.mergeCells(5, COL_NUM, 6, COL_NUM);
  const hNum = ws.getCell(5, COL_NUM);
  hNum.value = '№ П/П';
  hNum.font = { bold: true, size: 8 };
  hNum.alignment = centerAlign;
  hNum.fill = headerFill;

  ws.mergeCells(5, COL_FIO, 6, COL_FIO);
  const hFio = ws.getCell(5, COL_FIO);
  hFio.value = 'ФИО';
  hFio.font = { bold: true, size: 8 };
  hFio.alignment = centerAlign;
  hFio.fill = headerFill;

  ws.mergeCells(5, COL_TAB, 6, COL_TAB);
  const hTab = ws.getCell(5, COL_TAB);
  hTab.value = 'Табельный\nномер';
  hTab.font = { bold: true, size: 8 };
  hTab.alignment = centerAlign;
  hTab.fill = headerFill;

  ws.mergeCells(5, COL_SOURCE, 6, COL_SOURCE);
  const hSrc = ws.getCell(5, COL_SOURCE);
  hSrc.value = 'Строка';
  hSrc.font = { bold: true, size: 8 };
  hSrc.alignment = centerAlign;
  hSrc.fill = headerFill;

  ws.mergeCells(5, COL_DAY_START, 5, COL_DAY_START + exportDaysCount - 1);
  const hDays = ws.getCell(5, COL_DAY_START);
  hDays.value = 'Отметки о явках на объект по числам месяца';
  hDays.font = { bold: true, size: 8 };
  hDays.alignment = centerAlign;
  hDays.fill = headerFill;

  ws.mergeCells(5, colDays, 5, totalCols);
  const hWorked = ws.getCell(5, colDays);
  hWorked.value = 'Отработано';
  hWorked.font = { bold: true, size: 8 };
  hWorked.alignment = centerAlign;
  hWorked.fill = headerFill;

  for (let d = 0; d < exportDaysCount; d++) {
    const cell = ws.getCell(6, COL_DAY_START + d);
    cell.value = exportDays[d];
    cell.font = { bold: true, size: 8 };
    cell.alignment = centerAlign;
    cell.fill = headerFill;
  }

  ws.mergeCells(6, colDays, 6, colDays + 1);
  const hDaysLabel = ws.getCell(6, colDays);
  hDaysLabel.value = 'Дней';
  hDaysLabel.font = { bold: true, size: 8 };
  hDaysLabel.alignment = centerAlign;
  hDaysLabel.fill = headerFill;

  ws.mergeCells(6, colHours, 6, totalCols);
  const hHoursLabel = ws.getCell(6, colHours);
  hHoursLabel.value = 'Часов';
  hHoursLabel.font = { bold: true, size: 8 };
  hHoursLabel.alignment = centerAlign;
  hHoursLabel.fill = headerFill;

  const row7 = ws.getRow(7);
  row7.getCell(COL_NUM).value = 1;
  row7.getCell(COL_FIO).value = 2;
  row7.getCell(COL_TAB).value = 3;
  row7.getCell(COL_SOURCE).value = 4;
  ws.mergeCells(7, COL_DAY_START, 7, COL_DAY_START + exportDaysCount - 1);
  row7.getCell(COL_DAY_START).value = 5;
  ws.mergeCells(7, colDays, 7, totalCols);
  row7.getCell(colDays).value = 6;
  for (let c = 1; c <= totalCols; c++) {
    const cell = row7.getCell(c);
    cell.font = { size: 7, color: { argb: 'FF999999' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  }

  let grandDocDays = 0;
  let grandDocHours = 0;
  let currentRow = 8;

  filteredEmployees.forEach((employee, index) => {
    const rowNumber = currentRow++;
    const row = ws.getRow(rowNumber);
    const employeeDayMap = objectEntriesByEmployeeDate.get(employee.id) || new Map();
    const schedule = schedulesMap.get(employee.id);

    row.getCell(COL_NUM).value = index + 1;
    row.getCell(COL_NUM).alignment = centerAlign;
    row.getCell(COL_FIO).value = defangCsvCell(employee.full_name);
    row.getCell(COL_FIO).alignment = { vertical: 'middle', wrapText: true };
    row.getCell(COL_TAB).value = employee.sigur_employee_id ?? '';
    row.getCell(COL_TAB).alignment = centerAlign;
    row.getCell(COL_SOURCE).value = 'Факт';
    row.getCell(COL_SOURCE).alignment = centerAlign;
    row.getCell(COL_SOURCE).font = { size: 8 };
    row.getCell(COL_SOURCE).fill = docRowFill;

    let rowDaysCount = 0;
    let rowHoursSum = 0;

    exportDays.forEach((day, dayIndex) => {
      const dateStr = `${year}-${pad2(mon)}-${pad2(day)}`;
      const dateObj = new Date(year, mon - 1, day);
      const thresholdHours = getThresholdHoursForDate(data, employee.id, dateStr, schedule);
      const col = COL_DAY_START + dayIndex;
      const cell = ws.getCell(rowNumber, col);
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.font = { size: 8 };

      const isWeekend = isCalendarWeekend(dateObj, dateStr, calendarMonth);
      const entry = employeeDayMap.get(dateStr);
      cell.fill = docRowFill;
      if (!entry || !hasPositiveHours(entry.hours)) {
        cell.value = '';
        if (isWeekend) cell.fill = weekendFill;
        return;
      }

      cell.value = formatExportCellValue(formatHHMM(entry.hours), entry.corrected);
      if (isUnderworkHours(entry.hours, thresholdHours)) cell.fill = underworkFill;
      else if (entry.corrected) cell.fill = correctedFill;
      rowDaysCount++;
      rowHoursSum += entry.hours;
    });

    ws.mergeCells(rowNumber, colDays, rowNumber, colDays + 1);
    const daysCell = ws.getCell(rowNumber, colDays);
    daysCell.value = rowDaysCount;
    daysCell.alignment = centerAlign;
    daysCell.fill = docRowFill;

    ws.mergeCells(rowNumber, colHours, rowNumber, totalCols);
    const hoursCell = ws.getCell(rowNumber, colHours);
    hoursCell.value = rowHoursSum > 0 ? formatHHMM(rowHoursSum) : '0:00';
    hoursCell.alignment = centerAlign;
    hoursCell.fill = docRowFill;

    grandDocDays += rowDaysCount;
    grandDocHours += rowHoursSum;
  });

  const itogoDocRow = currentRow;
  ws.mergeCells(itogoDocRow, COL_NUM, itogoDocRow, COL_SOURCE);
  const itogoCell = ws.getCell(itogoDocRow, COL_NUM);
  itogoCell.value = 'ИТОГО';
  itogoCell.font = { bold: true, size: 10 };
  itogoCell.alignment = centerAlign;

  ws.mergeCells(itogoDocRow, colDays, itogoDocRow, colDays + 1);
  ws.getCell(itogoDocRow, colDays).value = grandDocDays;
  ws.getCell(itogoDocRow, colDays).alignment = centerAlign;
  ws.getCell(itogoDocRow, colDays).font = { bold: true };

  ws.mergeCells(itogoDocRow, colHours, itogoDocRow, totalCols);
  ws.getCell(itogoDocRow, colHours).value = formatHHMM(grandDocHours);
  ws.getCell(itogoDocRow, colHours).alignment = centerAlign;
  ws.getCell(itogoDocRow, colHours).font = { bold: true };

  for (let r = 5; r <= itogoDocRow; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= totalCols; c++) {
      row.getCell(c).border = thinBorder;
    }
  }

  applyA4PrintSetup(ws, 7);
}

/** Sanitize sheet name for Excel (max 31 chars, no special chars) */
export function sanitizeSheetName(name: string): string {
  return name.replace(/[\/\\?*\[\]:]/g, '_').slice(0, 31);
}
