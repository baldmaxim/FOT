import ExcelJS from 'exceljs';
import { isWorkingDay } from './schedule.service.js';
import type { IDepartmentTimesheetData } from './timesheet-export.service.js';

const STATUS_LABELS: Record<string, string> = {
  work: '', sick: 'Б', vacation: 'ОТ', absent: 'Н',
  business_trip: 'К', dayoff: 'В', remote: 'УУ', unpaid: 'НО', manual: '',
};

const thinBorder: Partial<ExcelJS.Borders> = {
  top: { style: 'thin' }, left: { style: 'thin' },
  bottom: { style: 'thin' }, right: { style: 'thin' },
};
// Цвета как в образце "Тердерный отдел.xls"
const headerFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC0C0C0' } };
const docRowFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDE8DF' } };
const correctedFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFB3E5FC' } };
const statusFills: Record<string, ExcelJS.Fill> = {
  sick:          { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFCDD2' } },
  vacation:      { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFBBDEFB' } },
  business_trip: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE1BEE7' } },
  dayoff:        { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E0E0' } },
  unpaid:        { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF9C4' } },
  absent:        { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF8A80' } },
  remote:        { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC8E6C9' } },
};

const formatHHMM = (decimalHours: number): string => {
  const totalMinutes = Math.round(decimalHours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
};

const pad2 = (n: number) => String(n).padStart(2, '0');

// Column indices
const COL_NUM = 1;
const COL_FIO = 2;
const COL_TAB = 3;
const COL_SOURCE = 4;
const COL_DAY_START = 5;

const groupObjectEntriesForExport = (data: IDepartmentTimesheetData): Map<number, Array<{
  object_key: string;
  object_name: string;
  dayMap: Map<string, { hours: number; corrected: boolean }>;
  hasCorrection: boolean;
}>> => {
  const exportDateSet = new Set(
    data.exportDays.map(day => `${data.year}-${pad2(data.mon)}-${pad2(day)}`),
  );
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

    current.dayMap.set(entry.work_date, {
      hours: entry.hours_worked,
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

export function buildTimesheetSheet(
  wb: ExcelJS.Workbook,
  sheetName: string,
  data: IDepartmentTimesheetData,
): void {
  const {
    employees,
    schedulesMap,
    dailySchedulesMap,
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

  // --- Row 3: empty ---
  ws.getRow(3).height = 5;

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
        ws.getCell(rowNumber, COL_FIO).value = emp.full_name;
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
        const daySched = dailySchedulesMap.get(emp.id)?.get(dateStr) || sched;
        const col = COL_DAY_START + dayIndex;
        const cell = ws.getCell(rowNumber, col);
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.font = { size: 8 };

        const isDayOff = daySched ? !isWorkingDay(daySched, dateObj) : (dateObj.getDay() === 0 || dateObj.getDay() === 6);
        if (isDayOff) {
          cell.value = '';
          return;
        }

        if (isSummaryRow) {
          cell.fill = docRowFill;
          const entry = empData?.get(dateStr);
          if (!entry) {
            cell.value = '';
            return;
          }

          const label = STATUS_LABELS[entry.status];
          if (label) {
            cell.value = label;
            if (statusFills[entry.status]) cell.fill = statusFills[entry.status];
          } else if (entry.hours > 0) {
            cell.value = formatHHMM(entry.hours);
            rowDaysCount++;
            rowHoursSum += entry.hours;
            if (entry.corrected) cell.fill = correctedFill;
          } else {
            cell.value = '';
          }
          return;
        }

        if (isObjectRow) {
          cell.fill = docRowFill;
          const objectEntry = definition.item.dayMap.get(dateStr);
          if (!objectEntry || objectEntry.hours <= 0) {
            cell.value = '';
            return;
          }

          cell.value = formatHHMM(objectEntry.hours);
          if (objectEntry.corrected) cell.fill = correctedFill;
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
}

/** Sanitize sheet name for Excel (max 31 chars, no special chars) */
export function sanitizeSheetName(name: string): string {
  return name.replace(/[\/\\?*\[\]:]/g, '_').slice(0, 31);
}
