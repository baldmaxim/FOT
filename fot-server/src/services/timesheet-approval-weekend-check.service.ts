import { query } from '../config/postgres.js';
import { loadCalendarMonth, resolveSchedulesForPeriod, isWorkingDay } from './schedule.service.js';
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

/**
 * Выходной день определяется по ЛИЧНОМУ графику сотрудника (isWorkingDay):
 * нерабочий по его графику день — выходной, даже если по календарю это будний
 * (важно для сменных/цикличных графиков). Праздники производственного
 * календаря учитываются внутри isWorkingDay (respects_holidays).
 */
export async function checkWeekendWorkRequirement(params: {
  departmentId: string;
  startDate: string;
  endDate: string;
}): Promise<IWeekendWorkCheck> {
  const { departmentId, startDate, endDate } = params;

  const employeeIds = await listEmployeeIdsAssignedToDepartmentPeriod(departmentId, startDate, endDate);
  if (employeeIds.length === 0) {
    return { requires: false, weekendDates: [], weekendWorkDates: [] };
  }

  const rangeDates: string[] = [];
  iterateDates(startDate, endDate, (iso) => rangeDates.push(iso));

  const schedules = await resolveSchedulesForPeriod(
    employeeIds.map((id) => ({ id })),
    startDate,
    endDate,
  );

  // Производственный календарь по месяцам диапазона грузим один раз.
  const calendarCache = new Map<string, Awaited<ReturnType<typeof loadCalendarMonth>>>();
  const getCalendar = async (dateObj: Date) => {
    const key = `${dateObj.getFullYear()}-${dateObj.getMonth() + 1}`;
    if (!calendarCache.has(key)) {
      calendarCache.set(key, await loadCalendarMonth(dateObj.getFullYear(), dateObj.getMonth() + 1));
    }
    return calendarCache.get(key) ?? null;
  };

  // Для каждого сотрудника — множество нерабочих по ЕГО графику дат.
  const offByEmployee = new Map<number, Set<string>>();
  const allOffDates = new Set<string>();
  for (const empId of employeeIds) {
    const dailyMap = schedules.get(empId);
    const offSet = new Set<string>();
    for (const iso of rangeDates) {
      const schedule = dailyMap?.get(iso);
      if (!schedule) continue;
      const dateObj = new Date(`${iso}T00:00:00`);
      const calendar = await getCalendar(dateObj);
      if (!isWorkingDay(schedule, dateObj, calendar)) {
        offSet.add(iso);
        allOffDates.add(iso);
      }
    }
    offByEmployee.set(empId, offSet);
  }

  const weekendDates = [...allOffDates].sort();
  if (weekendDates.length === 0) {
    return { requires: false, weekendDates: [], weekendWorkDates: [] };
  }

  const weekendWorkDates = new Set<string>();

  const adjRows = await query<{ employee_id: number; work_date: string; status: string }>(
    `SELECT employee_id, work_date::text AS work_date, status
       FROM attendance_adjustments
      WHERE employee_id = ANY($1::int[])
        AND work_date >= $2::date AND work_date <= $3::date
        AND status = 'work'`,
    [employeeIds, startDate, endDate],
  );
  for (const row of adjRows) {
    const empId = Number(row.employee_id);
    const iso = String(row.work_date).slice(0, 10);
    if (offByEmployee.get(empId)?.has(iso)) weekendWorkDates.add(iso);
  }

  const skudRows = await query<{ employee_id: number; date: string; total_minutes: number }>(
    `SELECT employee_id, date::text AS date, total_minutes
       FROM skud_daily_summary
      WHERE employee_id = ANY($1::int[])
        AND date >= $2::date AND date <= $3::date
        AND total_minutes > 0`,
    [employeeIds, startDate, endDate],
  );
  for (const row of skudRows) {
    const empId = Number(row.employee_id);
    const iso = String(row.date).slice(0, 10);
    if (offByEmployee.get(empId)?.has(iso)) weekendWorkDates.add(iso);
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
