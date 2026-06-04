import { query } from '../config/postgres.js';
import { loadCalendarMonth, resolveSchedulesForPeriod, isWorkingDay } from './schedule.service.js';
import { listEmployeeMembershipsForDepartmentPeriod } from './timesheet-department-assignments.service.js';
import { countApprovalAttachmentsForApprovals } from './timesheet-approval-attachments.service.js';

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
 * Для каждого сотрудника возвращает множество нерабочих по ЕГО графику дат
 * в диапазоне [startDate; endDate]. Использует isWorkingDay → учитывается
 * personal schedule (work_days, cycle), respects_holidays и mandatory_holidays.
 *
 * Дни, для которых график не разрешён (нет записи в resolveSchedulesForPeriod),
 * в Set не попадают — такие даты считаются «нет данных», а не «выходной».
 */
export async function getOffDatesByEmployee(
  employeeIds: number[],
  startDate: string,
  endDate: string,
): Promise<Map<number, Set<string>>> {
  const result = new Map<number, Set<string>>();
  if (employeeIds.length === 0) return result;

  const rangeDates: string[] = [];
  iterateDates(startDate, endDate, (iso) => rangeDates.push(iso));

  const schedules = await resolveSchedulesForPeriod(
    employeeIds.map((id) => ({ id })),
    startDate,
    endDate,
  );

  const calendarCache = new Map<string, Awaited<ReturnType<typeof loadCalendarMonth>>>();
  const getCalendar = async (dateObj: Date) => {
    const key = `${dateObj.getFullYear()}-${dateObj.getMonth() + 1}`;
    if (!calendarCache.has(key)) {
      calendarCache.set(key, await loadCalendarMonth(dateObj.getFullYear(), dateObj.getMonth() + 1));
    }
    return calendarCache.get(key) ?? null;
  };

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
      }
    }
    result.set(empId, offSet);
  }

  return result;
}

/**
 * Выходной день определяется по ЛИЧНОМУ графику сотрудника (isWorkingDay):
 * нерабочий по его графику день — выходной, даже если по календарю это будний
 * (важно для сменных/цикличных графиков). Праздники производственного
 * календаря учитываются внутри isWorkingDay (respects_holidays).
 *
 * Если передан employeeIds — используется он (персональная подача руководителя
 * «по людям»); иначе тянется состав отдела через listEmployeeIdsAssignedToDepartmentPeriod.
 */
export async function checkWeekendWorkRequirement(params: {
  departmentId: string | null;
  startDate: string;
  endDate: string;
  employeeIds?: number[];
}): Promise<IWeekendWorkCheck> {
  const { departmentId, startDate, endDate } = params;

  // Окно членства в отделе по сотруднику: уволенный/переведённый числится в отделе
  // только с joined_date (вкл.) до transferred_out_date (искл.). Его «работа в выходной»
  // ПОСЛЕ выхода (СКУД уже на другом объекте) не должна требовать служебку в этом отделе.
  const membershipWindow = new Map<number, { joined: string | null; transferredOut: string | null }>();
  let employeeIds: number[];
  if (params.employeeIds) {
    employeeIds = [...new Set(params.employeeIds)].filter((id): id is number => Number.isInteger(id) && id > 0);
  } else if (departmentId) {
    const memberships = await listEmployeeMembershipsForDepartmentPeriod(departmentId, startDate, endDate);
    employeeIds = memberships.map(m => m.employee_id);
    for (const m of memberships) {
      membershipWindow.set(m.employee_id, {
        joined: m.joined_date ?? null,
        transferredOut: m.transferred_out_date ?? null,
      });
    }
  } else {
    employeeIds = [];
  }
  if (employeeIds.length === 0) {
    return { requires: false, weekendDates: [], weekendWorkDates: [] };
  }

  // Путь по employeeIds (подача «по людям») окна не имеет — там фильтр не применяем.
  const isWithinMembership = (empId: number, iso: string): boolean => {
    const window = membershipWindow.get(empId);
    if (!window) return true;
    if (window.transferredOut && iso >= window.transferredOut) return false;
    if (window.joined && iso < window.joined) return false;
    return true;
  };

  const offByEmployee = await getOffDatesByEmployee(employeeIds, startDate, endDate);
  const allOffDates = new Set<string>();
  for (const set of offByEmployee.values()) {
    for (const iso of set) allOffDates.add(iso);
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
    if (offByEmployee.get(empId)?.has(iso) && isWithinMembership(empId, iso)) weekendWorkDates.add(iso);
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
    if (offByEmployee.get(empId)?.has(iso) && isWithinMembership(empId, iso)) weekendWorkDates.add(iso);
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
  weekendMemoRequired: boolean;
  weekendWorkDates: string[];
  attachmentCount: number;
}): IManagerObjMemoCheck {
  if (!input.weekendMemoRequired) {
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
 * Если у роли флаг weekend_memo_required выключен, IO-запросы пропускаются ради экономии времени.
 */
export async function checkManagerObjWeekendMemoRequirement(params: {
  weekendMemoRequired: boolean;
  departmentId: string | null;
  startDate: string;
  endDate: string;
  /**
   * Все строки подачи, консолидируемые этим сабмитом (reuseRow + точный черновик
   * диапазона + вытесняемые toDeleteIds): служебка могла быть загружена на любую из них.
   */
  approvalIds: number[];
  employeeIds?: number[];
}): Promise<IManagerObjMemoCheck> {
  if (!params.weekendMemoRequired) {
    return { required: false, satisfied: true, weekendWorkDates: [] };
  }

  const weekend = await checkWeekendWorkRequirement({
    departmentId: params.departmentId,
    startDate: params.startDate,
    endDate: params.endDate,
    employeeIds: params.employeeIds,
  });

  const attachmentCount = await countApprovalAttachmentsForApprovals(params.approvalIds);

  return evaluateManagerObjMemoRequirement({
    weekendMemoRequired: params.weekendMemoRequired,
    weekendWorkDates: weekend.weekendWorkDates,
    attachmentCount,
  });
}
