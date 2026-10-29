/**
 * Откуда берутся дни бригады для «Табель → Зарплата».
 *
 * Закрытый месяц — из последних редакций подач бригады (timesheet_versions.payload): это официальный
 * табель, фоновый пересчёт СКУД его не меняет. Уволенного в месяце увольнения в редакции нет
 * (isFiredHiddenForPeriod), но долю за отработанные дни он получает (решение 27.10.2026) — его дни
 * берутся из живого табеля. Открытый месяц — «Предварительно», целиком по живому табелю.
 *
 * Часы дня по объектам — та же разбивка, что уходит в 1С по объектам (buildVersionObjectBreakdown): у закрытого
 * месяца — снимок редакции (timesheet_version_objects), у редакции без снимка и у живого табеля — живая разбивка
 * (часы дня — из табеля, веса — объектные проходы). Снимок с config_errors — ошибка object_config, а не подстановка
 * «Не определён».
 */
import type { DbExecutor } from '../../config/postgres.js';
import { query } from '../../config/postgres.js';
import type { IProductionCalendarMonth, IResolvedSchedule } from '../../types/index.js';
import { buildVersionObjectBreakdown, type IObjectMeta } from '../timesheet-object-breakdown.service.js';
import { resolveExportModes } from '../timesheet-export-mode.service.js';
import { fetchTimesheetDataForEmployees } from '../timesheet-export.service.js';
import type { IAttendanceObjectEntry } from '../timesheet-object.service.js';
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

export interface IVersionDaysResult {
  days: DaysByEmployee;
  errors: IBrigadeSalaryError[];
  /** Редакции без снимка объектов (до миграции 263 и сбой записи снимка): веса их дней — живые. */
  withoutObjects: Set<number>;
  /** Из какой редакции день сотрудника — чтобы подставить живые веса только дням редакций без снимка. */
  versionOf: Map<number, Map<string, number>>;
  /** Имена объектов из снимков — замороженные вместе с ними. */
  objectNames: Map<string, string>;
}

/**
 * Дни сотрудников месяца из редакций и их часы по объектам из снимков тех же редакций. Один и тот же день в двух
 * редакциях — ошибка duplicate_day; config_errors снимка — object_config сотрудника.
 */
export async function loadVersionDays(
  versionIds: readonly number[],
  month: string,
  exec?: DbExecutor,
): Promise<IVersionDaysResult> {
  const days: DaysByEmployee = new Map();
  const errors: IBrigadeSalaryError[] = [];
  const versionOf = new Map<number, Map<string, number>>();
  const objectNames = new Map<string, string>();
  const withoutObjects = new Set<number>(versionIds);
  if (versionIds.length === 0) return { days, errors, withoutObjects, versionOf, objectNames };
  const { start, end } = monthBounds(month);
  const found = await rows<{ version_id: string | number; employee_id: string | number; date: string; day: Record<string, unknown> }>(
    exec,
    `SELECT v.id AS version_id, (e->'identity'->>'employee_id')::bigint AS employee_id, d.key AS date, d.value AS day
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
    const versions = versionOf.get(employeeId) ?? new Map<string, number>();
    versions.set(row.date, Number(row.version_id));
    versionOf.set(employeeId, versions);
  }

  const snapshots = await rows<{ version_id: string | number; config_errors: unknown }>(
    exec,
    'SELECT version_id, config_errors FROM timesheet_version_objects WHERE version_id = ANY($1::bigint[])',
    [versionIds],
  );
  for (const snapshot of snapshots) {
    withoutObjects.delete(Number(snapshot.version_id));
    const configErrors = Array.isArray(snapshot.config_errors) ? snapshot.config_errors : [];
    for (const item of configErrors as Array<{ employee_id?: unknown }>) {
      const employeeId = Number(item?.employee_id);
      if (Number.isInteger(employeeId) && employeeId > 0) {
        errors.push({ employee_id: employeeId, code: 'object_config', date: null });
      }
    }
  }

  const objectRows = await rows<{
    version_id: string | number;
    employee_id: string | number;
    object_key: string;
    object_name: string | null;
    date: string;
    hours: string | number;
  }>(
    exec,
    `SELECT o.version_id, (e->>'employee_id')::bigint AS employee_id,
            obj->>'object_key' AS object_key, obj->>'object_name' AS object_name,
            d.key AS date, d.value::text AS hours
       FROM timesheet_version_objects o
       CROSS JOIN LATERAL jsonb_array_elements(o.payload->'employees') e
       CROSS JOIN LATERAL jsonb_array_elements(e->'objects') obj
       CROSS JOIN LATERAL jsonb_each(COALESCE(obj->'days', '{}'::jsonb)) d
      WHERE o.version_id = ANY($1::bigint[])
        AND d.key >= $2 AND d.key <= $3`,
    [versionIds, start, end],
  );
  const weights = new Map<number, Map<string, Map<string, number>>>();
  for (const row of objectRows) {
    const employeeId = Number(row.employee_id);
    // Только дни, взятые из той же редакции: при duplicate_day второй снимок не подмешивается.
    if (versionOf.get(employeeId)?.get(row.date) !== Number(row.version_id)) continue;
    const hours = Number(row.hours);
    if (!(hours > 0)) continue;
    objectNames.set(row.object_key, row.object_name ?? row.object_key);
    const byDate = weights.get(employeeId) ?? new Map<string, Map<string, number>>();
    const byObject = byDate.get(row.date) ?? new Map<string, number>();
    byObject.set(row.object_key, (byObject.get(row.object_key) ?? 0) + hours);
    byDate.set(row.date, byObject);
    weights.set(employeeId, byDate);
  }
  for (const [employeeId, byDate] of weights) {
    const employeeDays = days.get(employeeId);
    if (!employeeDays) continue;
    for (const [date, objects] of byDate) {
      const day = employeeDays.get(date);
      if (day) employeeDays.set(date, { ...day, objects });
    }
  }
  return { days, errors, withoutObjects, versionOf, objectNames };
}

/** Имена и адреса объектов для разбивки (как buildObjectsSnapshot): фактические и закреплённые в режиме «объект». */
async function loadObjectMeta(objectIds: readonly string[], exec?: DbExecutor): Promise<Map<string, IObjectMeta>> {
  const meta = new Map<string, IObjectMeta>();
  if (objectIds.length === 0) return meta;
  const found = await rows<{ id: string; name: string; alt_name: string | null }>(
    exec,
    'SELECT id, name, alt_name FROM skud_objects WHERE id = ANY($1::uuid[])',
    [[...objectIds]],
  );
  for (const row of found) {
    const altName = row.alt_name?.trim();
    meta.set(row.id, { name: row.name, address: altName && altName.length > 0 ? altName : row.name });
  }
  return meta;
}

/**
 * Живая разбивка дней по объектам — тот же buildVersionObjectBreakdown, что у снимка редакции: часы дня берутся из
 * days, веса — из objectEntries, режим табелирования — месяца. Дни уже отфильтрованы окнами членства, поэтому
 * ownsDay — все. Возвращает дни с objects, ошибки object_config и имена объектов.
 */
export async function attachLiveObjects(
  days: DaysByEmployee,
  objectEntries: readonly IAttendanceObjectEntry[],
  month: string,
  exec?: DbExecutor,
): Promise<{ days: DaysByEmployee; errors: IBrigadeSalaryError[]; objectNames: Map<string, string> }> {
  const objectNames = new Map<string, string>();
  const employeeIds = [...days.keys()];
  if (employeeIds.length === 0) return { days, errors: [], objectNames };
  const modeByEmployee = await resolveExportModes(employeeIds, exec, { month: `${month}-01` });
  const objectIds = new Set<string>();
  for (const entry of objectEntries) if (entry.object_id) objectIds.add(entry.object_id);
  for (const resolved of modeByEmployee.values()) {
    if (resolved.mode === 'object' && resolved.pinnedObjectId) objectIds.add(resolved.pinnedObjectId);
  }
  const built = buildVersionObjectBreakdown({
    employees: employeeIds.map(employeeId => ({
      employee_id: employeeId,
      full_name: null,
      days: Object.fromEntries([...days.get(employeeId)!].map(([date, day]) => [date, { hours: day.hours }])),
    })),
    objectEntries: [...objectEntries],
    ownsDay: () => true,
    modeByEmployee,
    objectMetaById: await loadObjectMeta([...objectIds], exec),
  });
  const result: DaysByEmployee = new Map();
  for (const [employeeId, byDate] of days) result.set(employeeId, new Map(byDate));
  for (const employee of built.payload.employees) {
    const employeeDays = result.get(employee.employee_id);
    if (!employeeDays) continue;
    const byDate = new Map<string, Map<string, number>>();
    for (const object of employee.objects) {
      objectNames.set(object.object_key, object.object_name);
      for (const [date, hours] of Object.entries(object.days)) {
        if (!(hours > 0)) continue;
        const byObject = byDate.get(date) ?? new Map<string, number>();
        byObject.set(object.object_key, (byObject.get(object.object_key) ?? 0) + hours);
        byDate.set(date, byObject);
      }
    }
    for (const [date, objects] of byDate) {
      const day = employeeDays.get(date);
      if (day) employeeDays.set(date, { ...day, objects });
    }
  }
  const errors = built.configErrors.map(error => ({
    employee_id: error.employee_id, code: 'object_config' as const, date: null,
  }));
  return { days: result, errors, objectNames };
}

/** Объектные проходы сотрудников за [1-е, until] — веса живой разбивки для дней редакций без снимка. */
export async function loadLiveObjectEntries(
  employeeIds: readonly number[],
  month: string,
  until: string,
  exec?: DbExecutor,
): Promise<IAttendanceObjectEntry[]> {
  if (employeeIds.length === 0) return [];
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
  return data.objectEntries ?? [];
}

export interface ILiveBrigadeData {
  days: DaysByEmployee;
  schedules: Map<number, Map<string, IResolvedSchedule>>;
  calendar: IProductionCalendarMonth | null;
  /** object_config живой разбивки. */
  errors: IBrigadeSalaryError[];
  objectNames: Map<string, string>;
}

/**
 * Дни из живого табеля за [start, until] — те же правила, что у редакции: фактические часы СКУД,
 * несогласованные выходные обнулены. Дни после увольнения и вне окна членства в бригаде отброшены. Часы дня по
 * объектам — живая разбивка (attachLiveObjects).
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
  const withObjects = await attachLiveObjects(days, data.objectEntries ?? [], month, exec);
  return {
    days: withObjects.days,
    schedules: data.dailySchedulesMap,
    calendar: data.calendarMonth,
    errors: withObjects.errors,
    objectNames: withObjects.objectNames,
  };
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
