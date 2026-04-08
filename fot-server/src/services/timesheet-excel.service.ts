import ExcelJS from 'exceljs';
import { isWorkingDay, countNormHoursForSchedule } from './schedule.service.js';
import type { IDepartmentTimesheetData } from './timesheet-export.service.js';

export interface ISheetRoundingRules {
  capHours: number;
  warningBelow: number;
}

export const NORMAL_RULES: ISheetRoundingRules = { capHours: 8, warningBelow: 8 };
export const BRIGADE_RULES: ISheetRoundingRules = { capHours: 10, warningBelow: 9 };

const STATUS_LABELS: Record<string, string> = {
  work: '', sick: 'Б', vacation: 'О', absent: 'Н',
  business_trip: 'К', dayoff: 'В', remote: 'У', unpaid: 'НО', manual: '',
};

const MONTH_NAMES = ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const DAY_NAMES = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

const thinBorder: Partial<ExcelJS.Borders> = {
  top: { style: 'thin' }, left: { style: 'thin' },
  bottom: { style: 'thin' }, right: { style: 'thin' },
};
const greenFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF90EE90' } };
const yellowFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
const headerFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
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

const formatH = (h: number): number => Math.round(h);

export function buildTimesheetSheet(
  wb: ExcelJS.Workbook,
  sheetName: string,
  data: IDepartmentTimesheetData,
  rules: ISheetRoundingRules,
): void {
  const { employees, schedulesMap, dataMap, posMap, year, mon, daysInMonth, departmentName } = data;
  const totalCols = daysInMonth + 6;

  const ws = wb.addWorksheet(sheetName);

  // Column widths
  ws.getColumn(1).width = 4;
  ws.getColumn(2).width = 30;
  ws.getColumn(3).width = 25;
  for (let d = 1; d <= daysInMonth; d++) ws.getColumn(3 + d).width = 6;
  ws.getColumn(daysInMonth + 4).width = 10;
  ws.getColumn(daysInMonth + 5).width = 10;
  ws.getColumn(daysInMonth + 6).width = 10;

  // Row 1: Title
  ws.mergeCells(1, 1, 1, totalCols);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = `${MONTH_NAMES[mon]} ${year}\n${departmentName}`;
  titleCell.font = { bold: true, size: 16 };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  ws.getRow(1).height = 50;

  // Row 2: Header — day numbers
  const hdr1 = ws.getRow(2);
  const hdr1Vals: (string | number)[] = ['№', 'Сотрудник', 'Должность'];
  for (let d = 1; d <= daysInMonth; d++) hdr1Vals.push(d);
  hdr1Vals.push('Факт', 'Норма', '+/−');
  hdr1Vals.forEach((v, i) => {
    const cell = hdr1.getCell(i + 1);
    cell.value = v;
    cell.font = { bold: true, size: 9 };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.fill = headerFill;
  });

  // Row 3: Header — day names
  const hdr2 = ws.getRow(3);
  for (let d = 1; d <= daysInMonth; d++) {
    const dayOfWeek = new Date(year, mon - 1, d).getDay();
    const cell = hdr2.getCell(3 + d);
    cell.value = DAY_NAMES[dayOfWeek];
    cell.font = { size: 8 };
    cell.alignment = { horizontal: 'center' };
    cell.fill = headerFill;
  }
  [1, 2, 3, daysInMonth + 4, daysInMonth + 5, daysInMonth + 6].forEach(c => {
    hdr2.getCell(c).fill = headerFill;
  });

  // Employee rows
  employees.forEach((emp, idx) => {
    const sched = schedulesMap.get(emp.id);
    const empNormHours = sched
      ? countNormHoursForSchedule(year, mon, sched)
      : new Date(year, mon, 0).getDate() * 8;

    const rowNum = idx + 4;
    const row = ws.getRow(rowNum);

    row.getCell(1).value = idx + 1;
    row.getCell(1).alignment = { horizontal: 'center' };
    row.getCell(2).value = emp.full_name;
    row.getCell(3).value = emp.position_id ? posMap.get(emp.position_id) || '' : '';

    let factHours = 0;
    const empData = dataMap.get(emp.id);

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(mon).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const dateObj = new Date(year, mon - 1, d);
      const col = 3 + d;
      const cell = row.getCell(col);
      cell.alignment = { horizontal: 'center' };

      const isDayOff = sched ? !isWorkingDay(sched, dateObj) : (dateObj.getDay() === 0 || dateObj.getDay() === 6);

      if (isDayOff) {
        cell.value = '—';
        continue;
      }

      const entry = empData?.get(dateStr);
      if (!entry) {
        cell.value = '';
        continue;
      }

      const label = STATUS_LABELS[entry.status];
      if (label) {
        cell.value = label;
        if (statusFills[entry.status]) cell.fill = statusFills[entry.status];
        factHours += entry.hours;
      } else {
        // work / manual — округление и цветовая разметка с учётом правил
        const hours = entry.hours;
        const rounded = Math.round(hours);
        if (hours > rules.capHours) {
          cell.value = rules.capHours;
          cell.fill = greenFill;
          factHours += rules.capHours;
        } else {
          cell.value = rounded;
          factHours += rounded;
          if (rounded < rules.warningBelow) {
            cell.fill = yellowFill;
          } else if (entry.corrected) {
            cell.fill = correctedFill;
          }
        }
        if (entry.corrected && hours > rules.capHours) {
          cell.fill = correctedFill;
        }
      }
    }

    const diff = factHours - empNormHours;
    row.getCell(daysInMonth + 4).value = formatH(factHours);
    row.getCell(daysInMonth + 4).alignment = { horizontal: 'center' };
    row.getCell(daysInMonth + 5).value = formatH(empNormHours);
    row.getCell(daysInMonth + 5).alignment = { horizontal: 'center' };
    row.getCell(daysInMonth + 6).value = `${diff >= 0 ? '+' : '−'}${formatH(Math.abs(diff))}`;
    row.getCell(daysInMonth + 6).alignment = { horizontal: 'center' };
  });

  // Borders
  ws.eachRow(row => {
    for (let c = 1; c <= totalCols; c++) {
      row.getCell(c).border = thinBorder;
    }
  });
}

/** Sanitize sheet name for Excel (max 31 chars, no special chars) */
export function sanitizeSheetName(name: string): string {
  return name.replace(/[\/\\?*\[\]:]/g, '_').slice(0, 31);
}
