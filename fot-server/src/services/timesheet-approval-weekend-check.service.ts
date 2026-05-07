import { supabase } from '../config/database.js';
import { loadCalendarMonth } from './schedule.service.js';
import { listEmployeeIdsAssignedToDepartmentPeriod } from './timesheet-department-assignments.service.js';
import { countApprovalAttachments } from './timesheet-approval-attachments.service.js';

export const MANAGER_OBJ_ROLE_CODE = 'manager_obj';

export interface IWeekendWorkCheck {
  requires: boolean;
  weekendDates: string[];
  weekendWorkDates: string[];
}

export interface IManagerObjMemoCheck {
  required: boolean;
  satisfied: boolean;
  weekendWorkDates: string[];
}

const iterateDates = (startDate: string, endDate: string, cb: (iso: string) => void): void => {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  const cursor = new Date(start);
  while (cursor <= end) {
    const y = cursor.getFullYear();
    const m = String(cursor.getMonth() + 1).padStart(2, '0');
    const d = String(cursor.getDate()).padStart(2, '0');
    cb(`${y}-${m}-${d}`);
    cursor.setDate(cursor.getDate() + 1);
  }
};

async function collectWeekendDates(startDate: string, endDate: string): Promise<Set<string>> {
  const weekends = new Set<string>();
  const months = new Set<string>();
  iterateDates(startDate, endDate, (iso) => {
    months.add(iso.slice(0, 7));
    const d = new Date(`${iso}T00:00:00`);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) weekends.add(iso);
  });

  for (const ym of months) {
    const [y, m] = ym.split('-').map(Number);
    const calendar = await loadCalendarMonth(y, m);
    if (!calendar) continue;
    for (const holiday of calendar.holidays ?? []) {
      if (typeof holiday === 'string' && holiday >= startDate && holiday <= endDate) {
        weekends.add(holiday);
      }
    }
    for (const holiday of calendar.mandatory_holidays ?? []) {
      if (typeof holiday === 'string' && holiday >= startDate && holiday <= endDate) {
        weekends.add(holiday);
      }
    }
  }
  return weekends;
}

export async function checkWeekendWorkRequirement(params: {
  departmentId: string;
  startDate: string;
  endDate: string;
}): Promise<IWeekendWorkCheck> {
  const { departmentId, startDate, endDate } = params;

  const weekends = await collectWeekendDates(startDate, endDate);
  const weekendDates = [...weekends].sort();
  if (weekendDates.length === 0) {
    return { requires: false, weekendDates: [], weekendWorkDates: [] };
  }

  const employeeIds = await listEmployeeIdsAssignedToDepartmentPeriod(departmentId, startDate, endDate);
  if (employeeIds.length === 0) {
    return { requires: false, weekendDates, weekendWorkDates: [] };
  }

  const weekendWorkDates = new Set<string>();

  const adjRes = await supabase
    .from('attendance_adjustments')
    .select('employee_id, work_date, status')
    .in('employee_id', employeeIds)
    .in('work_date', weekendDates)
    .eq('status', 'work');
  if (adjRes.error) throw adjRes.error;
  for (const row of adjRes.data || []) {
    weekendWorkDates.add(String(row.work_date));
  }

  const skudRes = await supabase
    .from('skud_daily_summary')
    .select('employee_id, date, total_minutes')
    .in('employee_id', employeeIds)
    .in('date', weekendDates)
    .gt('total_minutes', 0);
  if (skudRes.error) throw skudRes.error;
  for (const row of skudRes.data || []) {
    weekendWorkDates.add(String(row.date));
  }

  const sortedWeekendWork = [...weekendWorkDates].sort();
  return {
    requires: sortedWeekendWork.length > 0,
    weekendDates,
    weekendWorkDates: sortedWeekendWork,
  };
}

/**
 * Чистая логика: по роли + найденным выходным дням + количеству вложений
 * вычисляет, нужна ли служебка и приложена ли она.
 * Вынесено отдельно от IO для удобного юнит-тестирования.
 */
export function evaluateManagerObjMemoRequirement(input: {
  submitterRoleCode: string;
  weekendWorkDates: string[];
  attachmentCount: number;
}): IManagerObjMemoCheck {
  if (input.submitterRoleCode !== MANAGER_OBJ_ROLE_CODE) {
    return { required: false, satisfied: true, weekendWorkDates: [] };
  }
  if (input.weekendWorkDates.length === 0) {
    return { required: false, satisfied: true, weekendWorkDates: [] };
  }
  return {
    required: true,
    satisfied: input.attachmentCount > 0,
    weekendWorkDates: [...input.weekendWorkDates].sort(),
  };
}

/**
 * IO-обёртка: грузит выходные дни диапазона и количество вложений,
 * передаёт в чистую evaluateManagerObjMemoRequirement.
 * Если submitter — не manager_obj, IO-запросы пропускаются ради экономии времени.
 */
export async function checkManagerObjWeekendMemoRequirement(params: {
  submitterRoleCode: string;
  departmentId: string;
  startDate: string;
  endDate: string;
  approvalId: number | null;
}): Promise<IManagerObjMemoCheck> {
  if (params.submitterRoleCode !== MANAGER_OBJ_ROLE_CODE) {
    return { required: false, satisfied: true, weekendWorkDates: [] };
  }

  const weekend = await checkWeekendWorkRequirement({
    departmentId: params.departmentId,
    startDate: params.startDate,
    endDate: params.endDate,
  });

  const attachmentCount = params.approvalId
    ? await countApprovalAttachments(params.approvalId)
    : 0;

  return evaluateManagerObjMemoRequirement({
    submitterRoleCode: params.submitterRoleCode,
    weekendWorkDates: weekend.weekendWorkDates,
    attachmentCount,
  });
}
