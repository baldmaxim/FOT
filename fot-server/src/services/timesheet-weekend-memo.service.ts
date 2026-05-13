import ExcelJS from 'exceljs';
import { query, queryOne } from '../config/postgres.js';
import { writeTimesheetWorkbookBuffer } from './timesheet-excel.service.js';
import { checkWeekendWorkRequirement } from './timesheet-approval-weekend-check.service.js';
import { listEmployeeIdsAssignedToDepartmentPeriod } from './timesheet-department-assignments.service.js';

export interface IWeekendMemoEmployee {
  id: number;
  full_name: string;
  position_name: string | null;
  weekend_dates: string[];
}

export interface IWeekendWorkEntry {
  employee_id: number;
  full_name: string;
  work_dates: string[];
}

export interface IWeekendWorkEntriesResult {
  entries: IWeekendWorkEntry[];
  weekend_dates: string[];
}

/**
 * Возвращает сотрудников отдела, у которых в attendance_adjustments проставлен
 * статус 'work' на выходные/праздничные дни выбранного диапазона, с их датами выхода.
 * Используется и preview-эндпоинтом, и генерацией .xlsx.
 */
export async function getWeekendWorkEntries(params: {
  departmentId: string;
  startDate: string;
  endDate: string;
}): Promise<IWeekendWorkEntriesResult> {
  const { departmentId, startDate, endDate } = params;
  const weekend = await checkWeekendWorkRequirement({ departmentId, startDate, endDate });
  if (weekend.weekendDates.length === 0) {
    return { entries: [], weekend_dates: [] };
  }

  const employeeIds = await listEmployeeIdsAssignedToDepartmentPeriod(departmentId, startDate, endDate);
  if (employeeIds.length === 0) {
    return { entries: [], weekend_dates: weekend.weekendDates };
  }

  const adjRows = await query<{ employee_id: number; work_date: string }>(
    `SELECT employee_id, work_date
       FROM attendance_adjustments
      WHERE employee_id = ANY($1::int[])
        AND work_date = ANY($2::date[])
        AND status = 'work'`,
    [employeeIds, weekend.weekendDates],
  );
  if (adjRows.length === 0) {
    return { entries: [], weekend_dates: weekend.weekendDates };
  }

  const datesByEmployee = new Map<number, Set<string>>();
  for (const row of adjRows) {
    const empId = Number(row.employee_id);
    const set = datesByEmployee.get(empId) ?? new Set<string>();
    set.add(String(row.work_date));
    datesByEmployee.set(empId, set);
  }

  const targetIds = [...datesByEmployee.keys()];
  const empRows = await query<{ id: number; full_name: string | null }>(
    'SELECT id, full_name FROM employees WHERE id = ANY($1::int[])',
    [targetIds],
  );
  const nameById = new Map<number, string>();
  for (const row of empRows) {
    nameById.set(Number(row.id), String(row.full_name ?? ''));
  }

  const entries: IWeekendWorkEntry[] = targetIds
    .map((empId) => ({
      employee_id: empId,
      full_name: nameById.get(empId) ?? '',
      work_dates: [...(datesByEmployee.get(empId) ?? new Set<string>())].sort(),
    }))
    .sort((a, b) => a.full_name.localeCompare(b.full_name, 'ru'));

  return {
    entries,
    weekend_dates: weekend.weekendDates,
  };
}

export interface IWeekendMemoInitiator {
  full_name: string | null;
  position_name: string | null;
  department_name: string | null;
}

export interface IWeekendMemoData {
  initiator: IWeekendMemoInitiator;
  employees: IWeekendMemoEmployee[];
  reason: string;
  generated_at: string;
}

const formatRu = (iso: string): string => {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
};

const formatDateList = (dates: string[]): string =>
  [...new Set(dates)].sort().map(formatRu).join(', ');

export async function loadWeekendMemoData(params: {
  managerUserId: string;
  employeeIds: number[];
  weekendDates: string[];
  reason: string;
}): Promise<IWeekendMemoData> {
  const { managerUserId, employeeIds, weekendDates, reason } = params;

  const initiator: IWeekendMemoInitiator = {
    full_name: null,
    position_name: null,
    department_name: null,
  };

  const profile = await queryOne<{ id: string; full_name: string | null; employee_id: number | null }>(
    'SELECT id, full_name, employee_id FROM user_profiles WHERE id = $1',
    [managerUserId],
  );
  if (profile) {
    initiator.full_name = profile.full_name ?? null;
    const initiatorEmployeeId = profile.employee_id ?? null;
    if (initiatorEmployeeId) {
      const empRow = await queryOne<{ id: number; position_id: string | null; department_id: string | null }>(
        'SELECT id, position_id, department_id FROM employees WHERE id = $1',
        [initiatorEmployeeId],
      );
      const positionId = empRow?.position_id ?? null;
      const departmentId = empRow?.department_id ?? null;
      if (positionId) {
        const posRow = await queryOne<{ id: string; name: string | null }>(
          'SELECT id, name FROM positions WHERE id = $1',
          [positionId],
        );
        initiator.position_name = posRow?.name ?? null;
      }
      if (departmentId) {
        const deptRow = await queryOne<{ id: string; name: string | null }>(
          'SELECT id, name FROM org_departments WHERE id = $1',
          [departmentId],
        );
        initiator.department_name = deptRow?.name ?? null;
      }
    }
  }

  const employeesRaw = await query<{ id: number; full_name: string; position_id: string | null }>(
    'SELECT id, full_name, position_id FROM employees WHERE id = ANY($1::int[])',
    [employeeIds],
  );

  const positionIds = [...new Set(employeesRaw.map(e => e.position_id).filter((v): v is string => Boolean(v)))];
  const positionsMap = new Map<string, string>();
  if (positionIds.length > 0) {
    const posRows = await query<{ id: string; name: string | null }>(
      'SELECT id, name FROM positions WHERE id = ANY($1::uuid[])',
      [positionIds],
    );
    for (const row of posRows) {
      positionsMap.set(String(row.id), String(row.name ?? ''));
    }
  }

  const sortedDates = [...new Set(weekendDates)].sort();
  const employees: IWeekendMemoEmployee[] = employeesRaw
    .map(e => ({
      id: Number(e.id),
      full_name: String(e.full_name ?? ''),
      position_name: e.position_id ? positionsMap.get(String(e.position_id)) ?? null : null,
      weekend_dates: sortedDates,
    }))
    .sort((a, b) => a.full_name.localeCompare(b.full_name, 'ru'));

  return {
    initiator,
    employees,
    reason,
    generated_at: new Date().toISOString(),
  };
}

export async function generateWeekendMemoXlsx(data: IWeekendMemoData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Служебная записка', {
    pageSetup: {
      paperSize: 9,
      orientation: 'portrait',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    },
  });

  ws.getColumn(1).width = 5;
  ws.getColumn(2).width = 38;
  ws.getColumn(3).width = 28;
  ws.getColumn(4).width = 28;

  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const todayStr = `${dd}.${mm}.${yyyy}`;

  ws.mergeCells('A1:D1');
  const titleCell = ws.getCell('A1');
  titleCell.value = 'СЛУЖЕБНАЯ ЗАПИСКА';
  titleCell.font = { name: 'Times New Roman', size: 14, bold: true };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 22;

  ws.mergeCells('A2:D2');
  const subTitle = ws.getCell('A2');
  subTitle.value = 'о привлечении работников к работе в выходные/нерабочие праздничные дни';
  subTitle.font = { name: 'Times New Roman', size: 11, italic: true };
  subTitle.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(2).height = 18;

  ws.mergeCells('A3:D3');
  const dateCell = ws.getCell('A3');
  dateCell.value = `Дата составления: ${todayStr}`;
  dateCell.font = { name: 'Times New Roman', size: 11 };
  dateCell.alignment = { horizontal: 'right' };

  let row = 5;
  const setLabel = (r: number, label: string, value: string): void => {
    ws.mergeCells(r, 1, r, 1);
    ws.getCell(r, 1).value = '';
    ws.mergeCells(r, 2, r, 4);
    const v = ws.getCell(r, 2);
    v.value = `${label}${value}`;
    v.font = { name: 'Times New Roman', size: 11 };
    v.alignment = { horizontal: 'left', wrapText: true };
  };

  setLabel(row++, 'От кого: ', `${data.initiator.full_name ?? '—'}, ${data.initiator.position_name ?? 'должность не указана'}`);
  if (data.initiator.department_name) {
    setLabel(row++, 'Отдел: ', data.initiator.department_name);
  }
  row++;

  ws.mergeCells(row, 1, row, 4);
  const reasonHeader = ws.getCell(row, 1);
  reasonHeader.value = 'Прошу разрешить привлечь работников к выполнению трудовых обязанностей в выходные дни в связи со следующими обстоятельствами:';
  reasonHeader.font = { name: 'Times New Roman', size: 11, bold: true };
  reasonHeader.alignment = { wrapText: true, vertical: 'top' };
  ws.getRow(row).height = 32;
  row++;

  ws.mergeCells(row, 1, row, 4);
  const reasonCell = ws.getCell(row, 1);
  reasonCell.value = data.reason || '—';
  reasonCell.font = { name: 'Times New Roman', size: 11 };
  reasonCell.alignment = { wrapText: true, vertical: 'top' };
  reasonCell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
  ws.getRow(row).height = 60;
  row += 2;

  const headerRow = row;
  const headers = ['№', 'ФИО работника', 'Должность', 'Даты выхода'];
  headers.forEach((h, i) => {
    const cell = ws.getCell(headerRow, i + 1);
    cell.value = h;
    cell.font = { name: 'Times New Roman', size: 11, bold: true };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E0E0' } };
    cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
  });
  ws.getRow(headerRow).height = 24;
  row++;

  data.employees.forEach((emp, idx) => {
    const r = row + idx;
    ws.getCell(r, 1).value = idx + 1;
    ws.getCell(r, 2).value = emp.full_name;
    ws.getCell(r, 3).value = emp.position_name ?? '—';
    ws.getCell(r, 4).value = formatDateList(emp.weekend_dates);
    for (let c = 1; c <= 4; c++) {
      const cell = ws.getCell(r, c);
      cell.font = { name: 'Times New Roman', size: 11 };
      cell.alignment = { vertical: 'middle', wrapText: true, horizontal: c === 1 ? 'center' : 'left' };
      cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    }
    ws.getRow(r).height = 22;
  });

  row += data.employees.length + 2;

  const sigRoles: Array<{ title: string; line: string }> = [
    { title: 'Генеральный директор', line: '_______________________ / _________________________ /' },
    { title: 'Главный инженер проекта', line: '_______________________ / _________________________ /' },
    { title: 'Начальник отдела кадров', line: '_______________________ / _________________________ /' },
    { title: 'Подпись инициатора', line: '_______________________ / _________________________ /' },
  ];

  for (const sig of sigRoles) {
    ws.mergeCells(row, 1, row, 4);
    const titleC = ws.getCell(row, 1);
    titleC.value = `${sig.title}:`;
    titleC.font = { name: 'Times New Roman', size: 11, bold: true };
    titleC.alignment = { horizontal: 'left' };
    row++;
    ws.mergeCells(row, 1, row, 4);
    const lineC = ws.getCell(row, 1);
    lineC.value = `${sig.line}              «___» __________ ${yyyy} г.`;
    lineC.font = { name: 'Times New Roman', size: 11 };
    lineC.alignment = { horizontal: 'left' };
    ws.getRow(row).height = 22;
    row += 2;
  }

  return writeTimesheetWorkbookBuffer(wb);
}
