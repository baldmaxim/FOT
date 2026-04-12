import { supabase } from '../config/database.js';
import { resolveSchedulesForPeriod } from './schedule.service.js';
import type { IResolvedSchedule } from '../types/index.js';
import { buildAttendanceEntries } from './attendance.service.js';

export interface IExportEmployee {
  id: number;
  full_name: string;
  position_id: string | null;
  org_department_id: string | null;
  sigur_employee_id: number | null;
  work_category: string | null;
}

export interface IDepartmentTimesheetData {
  departmentName: string;
  departmentId: string | null;
  isBrigade: boolean;
  employees: IExportEmployee[];
  schedulesMap: Map<number, IResolvedSchedule>;
  dailySchedulesMap: Map<number, Map<string, IResolvedSchedule>>;
  dataMap: Map<number, Map<string, { status: string; hours: number; corrected?: boolean }>>;
  skudMap: Map<number, Map<string, { hours: number; corrected: boolean }>>;
  posMap: Map<string, string>;
  year: number;
  mon: number;
  daysInMonth: number;
}

export async function fetchTimesheetDataForDepartment(
  month: string,
  departmentId: string | null,
): Promise<IDepartmentTimesheetData> {
  const [yearStr, monthStr] = month.split('-');
  const year = parseInt(yearStr);
  const mon = parseInt(monthStr);
  const startDate = `${month}-01`;
  const daysInMonth = new Date(year, mon, 0).getDate();
  const endDate = `${month}-${daysInMonth}`;
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  // Имя отдела
  let departmentName = 'Все отделы';
  if (departmentId) {
    const { data: dept } = await supabase
      .from('org_departments')
      .select('name')
      .eq('id', departmentId)
      .single();
    if (dept?.name) departmentName = dept.name;
  }

  // Сотрудники
  let empQuery = supabase
    .from('employees')
    .select('id, full_name, position_id, org_department_id, sigur_employee_id, work_category')
    .eq('employment_status', 'active')
    .eq('is_archived', false)
    .order('full_name');

  if (departmentId) {
    empQuery = empQuery.eq('org_department_id', departmentId);
  }

  const { data: employees } = await empQuery;
  const empArr: IExportEmployee[] = (employees || []).map(e => ({
    id: e.id as number,
    full_name: e.full_name as string,
    position_id: (e.position_id as string | null),
    org_department_id: (e.org_department_id as string | null),
    sigur_employee_id: (e.sigur_employee_id as number | null),
    work_category: (e.work_category as string | null) || null,
  }));
  // Графики
  const empList = empArr.map(e => ({ id: e.id, work_category: e.work_category }));
  const dailySchedulesMap = await resolveSchedulesForPeriod(empList, startDate, endDate);
  const referenceDate = todayStr < startDate ? startDate : (todayStr > endDate ? endDate : todayStr);
  const schedulesMap = new Map<number, IResolvedSchedule>();
  for (const [employeeId, dailyMap] of dailySchedulesMap) {
    const schedule = dailyMap.get(referenceDate) || dailyMap.get(startDate);
    if (schedule) schedulesMap.set(employeeId, schedule);
  }

  const attendance = await buildAttendanceEntries({
    employees: empArr.map(employee => ({
      id: employee.id,
      full_name: employee.full_name,
      work_category: employee.work_category,
    })),
    startDate,
    endDate,
    dailySchedulesMap,
    calendarMonth: null,
    todayStr,
  });

  const dataMap = new Map<number, Map<string, { status: string; hours: number; corrected?: boolean }>>();
  for (const [employeeId, dateMap] of attendance.byEmployeeDate) {
    dataMap.set(employeeId, new Map());
    for (const [date, entry] of dateMap) {
      dataMap.get(employeeId)!.set(date, {
        status: entry.status,
        hours: typeof entry.hours_worked === 'number' ? entry.hours_worked : 0,
        corrected: entry.is_correction,
      });
    }
  }

  const skudMap = attendance.skudMap;

  // Positions
  const positionIds = [...new Set(empArr.map(e => e.position_id).filter(Boolean))] as string[];
  const posMap = new Map<string, string>();
  if (positionIds.length > 0) {
    const { data: positions } = await supabase.from('positions').select('id, name').in('id', positionIds);
    (positions || []).forEach((p: { id: string; name: string }) => posMap.set(p.id, p.name));
  }

  return {
    departmentName,
    departmentId,
    isBrigade: departmentName.toLowerCase().startsWith('бр.'),
    employees: empArr,
    schedulesMap,
    dailySchedulesMap,
    dataMap,
    skudMap,
    posMap,
    year,
    mon,
    daysInMonth,
  };
}
