import type {
  IEmployeeApprovalLock,
  IEmployeeAssignmentPeriod,
  IEmployeeStats,
  IProductionCalendarMonth,
  TimesheetEmployee,
  TimesheetEntry,
  TimesheetObjectEntry,
  TimesheetResponse,
} from '../../types';
import type { IResolvedSchedule } from '../../types/schedule';

/**
 * Сборка сетки режима «По сотруднику»: по строке на каждый период работы в отделе.
 *
 * Каждый период запрашивается ОТДЕЛЬНО и на ПОЛНЫЙ отображаемый диапазон — обрезка
 * from/to по границам периода ломает помесячный расчёт обязательных выходных. Отрезок
 * задаётся серверу через period_from/period_to, а границы строки (joined_date /
 * transferred_out_date), editable и employee_stats приходят уже посчитанными тем же
 * путём, что и в обычном табеле отдела. Здесь остаётся только разложить ответы по
 * строкам и слить общие части.
 */

export interface IEmployeeModeRowSource {
  period: IEmployeeAssignmentPeriod;
  data: TimesheetResponse | undefined;
}

export interface IEmployeeModeGridData {
  employees: TimesheetEmployee[];
  entries: TimesheetEntry[];
  objectEntries: TimesheetObjectEntry[];
  employeeStats: IEmployeeStats[];
  schedules: Record<number, IResolvedSchedule>;
  dailySchedules: Record<number, Record<string, IResolvedSchedule>>;
  approvalLocks: IEmployeeApprovalLock[];
  calendar: IProductionCalendarMonth | null;
}

export const getEmployeePeriodRowKey = (employeeId: number, period: IEmployeeAssignmentPeriod): string => (
  `${employeeId}:${period.org_department_id}:${period.from}`
);

/** Название отдела в строке недоступного периода: цифр там нет, причина должна быть видна. */
export const RESTRICTED_PERIOD_SUFFIX = ' (нет доступа)';

const shiftIsoDate = (date: string, days: number): string => {
  const cursor = new Date(`${date}T00:00:00`);
  cursor.setDate(cursor.getDate() + days);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}-${pad(cursor.getDate())}`;
};

/**
 * Строка периода, к которому нет доступа. Данные для него не запрашиваются вовсе —
 * чужие часы не должны покидать сервер, — поэтому строка синтезируется на клиенте:
 * все дни серые, правка запрещена.
 */
const buildRestrictedRow = (
  employee: TimesheetEmployee,
  period: IEmployeeAssignmentPeriod,
): TimesheetEmployee => ({
  ...employee,
  row_key: getEmployeePeriodRowKey(employee.id, period),
  org_department_id: period.org_department_id,
  department_name: `${period.department_name ?? 'Другой отдел'}${RESTRICTED_PERIOD_SUFFIX}`,
  // joined = transferred_out → ни один день строки не активен.
  joined_date: period.from,
  transferred_out_date: period.from,
  editable: false,
  is_restricted_period: true,
  source: 'department',
});

export function buildEmployeeModeGridData(
  employeeId: number,
  sources: IEmployeeModeRowSource[],
  fallbackEmployee: TimesheetEmployee | null,
): IEmployeeModeGridData {
  const employees: TimesheetEmployee[] = [];
  const employeeStats: IEmployeeStats[] = [];
  const entryByKey = new Map<string, TimesheetEntry>();
  const objectEntryByKey = new Map<string, TimesheetObjectEntry>();
  const schedules: Record<number, IResolvedSchedule> = {};
  const dailySchedules: Record<number, Record<string, IResolvedSchedule>> = {};
  const approvalLockByKey = new Map<string, IEmployeeApprovalLock>();
  let calendar: IProductionCalendarMonth | null = null;

  for (const { period, data } of sources) {
    const rowKey = getEmployeePeriodRowKey(employeeId, period);

    if (!period.accessible) {
      const base = fallbackEmployee ?? data?.employees?.[0] ?? null;
      if (base) employees.push(buildRestrictedRow(base, period));
      continue;
    }

    if (!data) continue;

    const employee = data.employees.find(candidate => candidate.id === employeeId);
    if (employee) {
      employees.push({
        ...employee,
        row_key: rowKey,
        // Имя отдела берём из периода: в ответе лежит snapshot-отдел сотрудника,
        // а он у всех строк одинаковый и после перевода указывает на новый отдел.
        department_name: period.department_name ?? employee.department_name ?? null,
        org_department_id: period.org_department_id,
        editable: period.editable && (employee.editable ?? true),
        source: 'department',
      });
    }

    const stat = data.employee_stats?.find(candidate => candidate.employee_id === employeeId);
    if (stat) employeeStats.push({ ...stat, row_key: rowKey });

    // Ответы перекрываются: каждый отдаёт записи за весь диапазон. Дедуп по
    // (сотрудник, дата) — строки различают дни серыми зонами, а не набором записей.
    for (const entry of data.entries) {
      entryByKey.set(`${entry.employee_id}_${entry.work_date}`, entry);
    }
    for (const objectEntry of data.object_entries) {
      objectEntryByKey.set(
        `${objectEntry.employee_id}_${objectEntry.work_date}_${objectEntry.object_key}`,
        objectEntry,
      );
    }

    Object.assign(schedules, data.schedules ?? {});
    // Глубокое слияние: плоский spread затёр бы дни соседнего периода целиком.
    for (const [empId, byDate] of Object.entries(data.daily_schedules ?? {})) {
      const numericId = Number(empId);
      dailySchedules[numericId] = { ...(dailySchedules[numericId] ?? {}), ...byDate };
    }
    for (const lock of data.approval_locks ?? []) {
      approvalLockByKey.set(`${lock.employee_id}_${lock.start_date}_${lock.end_date}_${lock.status}`, lock);
    }
    if (!calendar && data.calendar) calendar = data.calendar;
  }

  return {
    employees,
    entries: [...entryByKey.values()],
    objectEntries: [...objectEntryByKey.values()],
    employeeStats,
    schedules,
    dailySchedules,
    approvalLocks: [...approvalLockByKey.values()],
    calendar,
  };
}

/**
 * Верхняя граница строки для отладки/подсказок: первый день, когда сотрудника
 * в отделе уже нет. Совпадает с семантикой transferred_out_date в сетке.
 */
export const getPeriodCutoffDate = (period: IEmployeeAssignmentPeriod): string => shiftIsoDate(period.to, 1);
