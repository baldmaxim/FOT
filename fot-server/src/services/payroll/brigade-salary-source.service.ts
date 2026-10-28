/**
 * Откуда берутся дни бригады для «Табель → Зарплата».
 *
 * Закрытый месяц — из последних редакций подач бригады (timesheet_versions.payload): это официальный
 * табель, фоновый пересчёт СКУД его не меняет. Уволенного в месяце увольнения в редакции нет
 * (isFiredHiddenForPeriod), но долю за отработанные дни он получает (решение 27.10.2026) — его дни
 * берутся из живого табеля. Открытый месяц — «Предварительно», целиком по живому табелю.
 */
import type { DbExecutor } from '../../config/postgres.js';
import { query } from '../../config/postgres.js';
import type { IProductionCalendarMonth, IResolvedSchedule } from '../../types/index.js';
import { fetchTimesheetDataForEmployees } from '../timesheet-export.service.js';
import {
  buildMembershipWindowMap,
  isWithinMembershipWindow,
  listEmployeeMembershipsForDepartmentPeriod,
  type IDepartmentEmployeeMembership,
} from '../timesheet-department-assignments.service.js';
import type { IBrigadeDayValue, IBrigadeSalaryError } from './brigade-salary.calc.js';

export interface IBrigadeApprovalRow {
  id: number;
  start_date: string;
  end_date: string;
  status: string;
  unlocked: boolean;
  version_id: number | null;
}

export interface IDateRange {
  start_date: string;
  end_date: string;
}

export interface IBrigadeMonthClosure {
  closed: boolean;
  /** Дни месяца без закрытой подачи — для пометки «Табель не закрыт: 16–31». */
  open_ranges: IDateRange[];
  /** Последние редакции закрытых подач, покрывающих месяц, по approval_id. */
  versions: Array<{ approval_id: number; version_id: number }>;
}

export type DaysByEmployee = Map<number, Map<string, IBrigadeDayValue>>;

async function rows<T extends import('pg').QueryResultRow>(
  exec: DbExecutor | undefined, sql: string, params: readonly unknown[],
): Promise<T[]> {
  if (exec) return (await exec.query<T>(sql, params as unknown[])).rows;
  return query<T>(sql, params);
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

export const monthBounds = (month: string): { start: string; end: string } => {
  const [year, mon] = month.split('-').map(Number);
  return { start: `${month}-01`, end: `${month}-${pad2(new Date(year, mon, 0).getDate())}` };
};

const listDates = (start: string, end: string): string[] => {
  const [year, mon] = start.split('-').map(Number);
  const first = Number(start.slice(8, 10));
  const last = Number(end.slice(8, 10));
  return Array.from({ length: last - first + 1 }, (_, index) => `${year}-${pad2(mon)}-${pad2(first + index)}`);
};

/** Подачи бригады (не персональные), задевающие месяц, с последней редакцией каждой. */
export async function loadBrigadeMonthApprovals(
  departmentId: string,
  month: string,
  exec?: DbExecutor,
): Promise<IBrigadeApprovalRow[]> {
  const { start, end } = monthBounds(month);
  const found = await rows<{
    id: string | number;
    start_date: string;
    end_date: string;
    status: string;
    unlocked: boolean;
    version_id: string | number | null;
  }>(
    exec,
    `SELECT a.id, a.start_date::text AS start_date, a.end_date::text AS end_date, a.status,
            (a.unlocked_at IS NOT NULL) AS unlocked, v.id AS version_id
       FROM timesheet_approvals a
       LEFT JOIN LATERAL (
         SELECT tv.id FROM timesheet_versions tv
          WHERE tv.approval_id = a.id
          ORDER BY tv.revision DESC
          LIMIT 1
       ) v ON true
      WHERE a.department_id = $1
        AND a.manager_employee_id IS NULL
        AND a.start_date <= $3::date
        AND a.end_date >= $2::date
      ORDER BY a.start_date, a.id`,
    [departmentId, start, end],
  );
  return found.map(row => ({
    id: Number(row.id),
    start_date: row.start_date,
    end_date: row.end_date,
    status: row.status,
    unlocked: row.unlocked === true,
    version_id: row.version_id == null ? null : Number(row.version_id),
  }));
}

/**
 * Месяц закрыт, когда каждый его день покрыт подачей, которая утверждена, закрыта (замок на месте)
 * и имеет редакцию. Подача бывает одна на месяц или две половины.
 */
export const resolveBrigadeMonthClosure = (
  approvals: readonly IBrigadeApprovalRow[],
  month: string,
): IBrigadeMonthClosure => {
  const { start, end } = monthBounds(month);
  const closedApprovals = approvals.filter(row => (
    row.status === 'approved' && !row.unlocked && row.version_id != null
  ));
  const openDates = listDates(start, end).filter(date => !closedApprovals.some(row => (
    row.start_date <= date && row.end_date >= date
  )));
  const open_ranges: IDateRange[] = [];
  for (const date of openDates) {
    const last = open_ranges[open_ranges.length - 1];
    const previousDay = last ? Number(last.end_date.slice(8, 10)) : null;
    if (last && previousDay === Number(date.slice(8, 10)) - 1) last.end_date = date;
    else open_ranges.push({ start_date: date, end_date: date });
  }
  const versions = closedApprovals
    .map(row => ({ approval_id: row.id, version_id: row.version_id as number }))
    .sort((a, b) => a.approval_id - b.approval_id);
  return { closed: openDates.length === 0, open_ranges, versions };
};

/** Дни сотрудников месяца из редакций. Один и тот же день в двух редакциях — ошибка duplicate_day. */
export async function loadVersionDays(
  versionIds: readonly number[],
  month: string,
  exec?: DbExecutor,
): Promise<{ days: DaysByEmployee; errors: IBrigadeSalaryError[] }> {
  const days: DaysByEmployee = new Map();
  const errors: IBrigadeSalaryError[] = [];
  if (versionIds.length === 0) return { days, errors };
  const { start, end } = monthBounds(month);
  const found = await rows<{ employee_id: string | number; date: string; day: Record<string, unknown> }>(
    exec,
    `SELECT (e->'identity'->>'employee_id')::bigint AS employee_id, d.key AS date, d.value AS day
       FROM timesheet_versions v
       CROSS JOIN LATERAL jsonb_array_elements(v.payload->'employees') e
       CROSS JOIN LATERAL jsonb_each(e->'days') d
      WHERE v.id = ANY($1::bigint[])
        AND d.key >= $2 AND d.key <= $3`,
    [versionIds, start, end],
  );
  for (const row of found) {
    const employeeId = Number(row.employee_id);
    const byDate = days.get(employeeId) ?? new Map<string, IBrigadeDayValue>();
    if (byDate.has(row.date)) {
      errors.push({ employee_id: employeeId, code: 'duplicate_day', date: row.date });
      continue;
    }
    byDate.set(row.date, {
      status: String(row.day.status ?? ''),
      hours: typeof row.day.hours === 'number' ? row.day.hours : Number(row.day.hours ?? 0),
      corrected: row.day.corrected === true,
      hours_overridden: row.day.hours_overridden === true,
    });
    days.set(employeeId, byDate);
  }
  return { days, errors };
}

export interface ILiveBrigadeData {
  days: DaysByEmployee;
  schedules: Map<number, Map<string, IResolvedSchedule>>;
  calendar: IProductionCalendarMonth | null;
}

/**
 * Дни из живого табеля за [start, until] — те же правила, что у редакции: фактические часы СКУД,
 * несогласованные выходные обнулены. Дни после увольнения и вне окна членства в бригаде отброшены.
 * memberships — уже загруженное членство бригады за [start, until] (предварительный расчёт «Расчётов»), чтобы
 * не читать его второй раз.
 */
export async function loadLiveDays(
  departmentId: string,
  employeeIds: readonly number[],
  month: string,
  until: string,
  exec?: DbExecutor,
  memberships?: readonly IDepartmentEmployeeMembership[],
): Promise<ILiveBrigadeData> {
  const { start } = monthBounds(month);
  const data = await fetchTimesheetDataForEmployees(
    month,
    [...employeeIds],
    'Зарплата бригады',
    { startDate: start, endDate: until },
    'actual',
    true,
    { rosterMode: 'snapshot', exec },
  );
  const members = memberships ?? await listEmployeeMembershipsForDepartmentPeriod(
    departmentId, start, until, exec, { firedInDismissalMonth: true },
  );
  const windows = buildMembershipWindowMap([...members]);
  const days: DaysByEmployee = new Map();
  for (const [employeeId, byDate] of data.dataMap) {
    const cutoff = data.cutoffByEmployeeId?.get(employeeId) ?? null;
    const kept = new Map<string, IBrigadeDayValue>();
    for (const [date, value] of byDate) {
      if (date < start || date > until) continue;
      if (cutoff && date >= cutoff) continue;
      if (!isWithinMembershipWindow(windows.get(employeeId), date, 'viaTransferOnly')) continue;
      kept.set(date, {
        status: value.status,
        hours: value.hours,
        corrected: value.corrected === true,
        hours_overridden: value.hoursOverridden === true,
      });
    }
    days.set(employeeId, kept);
  }
  return { days, schedules: data.dailySchedulesMap, calendar: data.calendarMonth };
}

/** Состав бригады за месяц, как в сетке табеля (уволенный виден и в месяце увольнения). */
export async function listBrigadeMemberIds(
  departmentId: string,
  month: string,
  exec?: DbExecutor,
): Promise<number[]> {
  const { start, end } = monthBounds(month);
  const memberships = await listEmployeeMembershipsForDepartmentPeriod(
    departmentId, start, end, exec, { firedInDismissalMonth: true },
  );
  return memberships.map(row => row.employee_id).sort((a, b) => a - b);
}
