/**
 * API для ЗУП3 «сотрудники месяца» — сборка снимка месяца из дней (staff-month-1c.load.ts) внутри одной транзакции
 * только для чтения: норма и вид дня по графику, объект и категория — функциями «Свода», бригады, справочник объектов.
 */
import { randomUUID } from 'node:crypto';

import type { DbExecutor } from '../config/postgres.js';
import { buildEmployeeEmploymentPeriods, classifyPlanDay, type IEmploymentAssignment, type SchedulePlanDayKind } from './employee-schedule-plan.service.js';
import { attributeMonths, monthPairKey } from './payroll/payroll-month-attribution.service.js';
import { pickMainObject, type ISummaryBreakdownRow } from './payroll/payroll-summary.attribution.js';
import { resolveSummaryObjects, type SummaryObjectStep } from './payroll/payroll-summary-object.service.js';
import { resolveMonthStaffCategories } from './payroll/payroll-staff-category.js';
import { countMonthNormDays } from './payroll/payroll-basis.service.js';
import { scheduleMonthNorm } from './payroll/schedule-month-norm.js';
import { loadCalendarMonth, resolveSchedulesForPeriod } from './schedule.service.js';
import { CURRENT_ACTIVITY_KEY } from './timesheet-object-breakdown.service.js';
import { UNKNOWN_OBJECT_KEY } from './timesheet-object.service.js';
import {
  buildMembershipWindowMap,
  isWithinMembershipWindow,
  listEmployeeMembershipsForDepartmentPeriod,
  type IMembershipWindow,
} from './timesheet-department-assignments.service.js';
import { loadClosedFingerprint, loadMonthDays, type IMonthBounds } from './staff-month-1c.load.js';
import {
  aggregateBrigades,
  aggregateFact,
  fromCenti,
  objectHoursList,
  OFFICE_OBJECT,
  pickEmployeeBrigade,
  pickMainKnownKey,
  UNKNOWN_OBJECT,
  type IApiObject,
  type IBrigadeDayShare,
  type IDayRecord,
  type StaffMonthCategory,
  type StaffMonthObjectSource,
} from './staff-month-1c.rules.js';

export interface IStaffMonthDay {
  date: string;
  employed: boolean;
  day_kind: SchedulePlanDayKind | null;
  working_day: boolean | null;
  plan_hours: number | null;
  status_code: string | null;
  /** Часы дня в табеле (у неявки — норма графика), справочно. */
  timesheet_hours: number;
  /** Факт: отработанные часы. */
  hours: number;
  objects: Array<{ object: IApiObject; hours: number }>;
  source: 'closed' | 'live' | null;
}

export interface IStaffMonthNorm {
  hours: number | null;
  days: number | null;
  complete: boolean;
  weekend_quota: { saturdays: number; sundays: number; hours: number };
}

export interface IStaffMonthRow {
  employee_id: number;
  full_name: string | null;
  department: { id: string; name: string } | null;
  category: StaffMonthCategory;
  is_worker: boolean;
  object: IApiObject;
  object_source: StaffMonthObjectSource;
  objects: Array<{ object: IApiObject; hours: number }>;
  hours: number;
  norm: IStaffMonthNorm;
  brigade: { department_id: string; name: string; object: IApiObject | null } | null;
  preliminary: boolean;
  object_config_error: boolean;
  object_frozen: boolean;
  days: IStaffMonthDay[];
}

export interface IStaffMonthBrigade {
  department_id: string;
  name: string;
  object: IApiObject | null;
  objects: Array<{ object: IApiObject; hours: number }>;
  members: Array<{ employee_id: number; hours: number }>;
}

export interface IStaffMonthObject {
  object: IApiObject;
  employees_fact: number;
  employees_main: number;
  hours: number;
}

export interface IStaffMonthSnapshot {
  id: string;
  month: string;
  bounds: IMonthBounds;
  generatedAt: string;
  fingerprint: string;
  /** Есть живые дни — снимок стареет быстрее. */
  hasLive: boolean;
  preliminary: boolean;
  rows: IStaffMonthRow[];
  /** Для отбора: основной объект и факт по объектам, по employee_id. */
  index: Map<number, { mainKey: string; factByObject: Map<string, number> }>;
  brigades: IStaffMonthBrigade[];
  objects: IStaffMonthObject[];
  meta: { duplicate_days: number; object_config_errors: number; objects_not_frozen: number };
  /** Ревизия и хеш каждой строки — после записи состояний (staff-month-1c.export-state.ts). */
  exportRows?: Map<number, { revision: number; contentHash: string }>;
}

const rowsOf = async <T>(exec: DbExecutor, sql: string, params: unknown[]): Promise<T[]> => (
  (await exec.query(sql, params)).rows as T[]
);

const listDates = (start: string, end: string): string[] => {
  const dates: string[] = [];
  for (let date = new Date(`${start}T00:00:00Z`); date.toISOString().slice(0, 10) <= end; date.setUTCDate(date.getUTCDate() + 1)) {
    dates.push(date.toISOString().slice(0, 10));
  }
  return dates;
};

/** Строки разбивки «Свода» из дней: все табельные часы по объектам (и неявки — как в снимке редакции). */
const toBreakdownRows = (days: Iterable<IDayRecord>, objects: ReadonlyMap<string, IApiObject>): ISummaryBreakdownRow[] => {
  const grouped = new Map<string, ISummaryBreakdownRow>();
  for (const day of days) {
    for (const part of day.parts) {
      const groupKey = `${day.versionId ?? 0}|${day.departmentId ?? ''}|${part.key}`;
      const row = grouped.get(groupKey);
      if (row) {
        row.hours += part.centi / 100;
        continue;
      }
      const object = objects.get(part.key);
      const special = part.key === OFFICE_OBJECT.key ? CURRENT_ACTIVITY_KEY : part.key === UNKNOWN_OBJECT.key ? UNKNOWN_OBJECT_KEY : null;
      grouped.set(groupKey, {
        version_id: day.versionId ?? 0,
        department_id: day.departmentId,
        object_key: special ?? part.key,
        object_id: special ? null : part.key,
        object_name: object?.name ?? null,
        object_address: object?.address ?? null,
        hours: part.centi / 100,
      });
    }
  }
  return [...grouped.values()];
};

/** Окна членства в бригадах (для живых дней) — только бригады, где эти люди числились в месяце. */
const loadBrigadeWindows = async (
  exec: DbExecutor, brigadeIds: readonly string[], bounds: IMonthBounds,
): Promise<Map<number, Array<{ departmentId: string; window: IMembershipWindow | undefined }>>> => {
  const byEmployee = new Map<number, Array<{ departmentId: string; window: IMembershipWindow | undefined }>>();
  for (const departmentId of brigadeIds) {
    const memberships = await listEmployeeMembershipsForDepartmentPeriod(
      departmentId, bounds.start, bounds.until, exec, { firedInDismissalMonth: true },
    );
    const windows = buildMembershipWindowMap(memberships);
    for (const membership of memberships) {
      const list = byEmployee.get(membership.employee_id) ?? [];
      list.push({ departmentId, window: windows.get(membership.employee_id) });
      byEmployee.set(membership.employee_id, list);
    }
  }
  return byEmployee;
};

/** Снимок месяца целиком. exec — клиент withReadOnlySnapshot. */
export const buildStaffMonthSnapshot = async (
  exec: DbExecutor, bounds: IMonthBounds, now: Date = new Date(), timing?: { mark: (step: string) => void },
): Promise<IStaffMonthSnapshot> => {
  const fingerprint = await loadClosedFingerprint(exec, bounds.start);
  const loaded = await loadMonthDays(exec, bounds, timing);
  timing?.mark('days');
  const ids = [...loaded.days.keys()].filter(id => (loaded.days.get(id)?.size ?? 0) > 0).sort((a, b) => a - b);
  const departmentName = new Map(loaded.departments.map(row => [row.id, row.name]));
  // Бригада — отдел kind = 'brigade', как вкладка «Бригады» табеля (папка раздела бригадой не считается).
  const brigadeIds = loaded.departments.filter(row => row.kind === 'brigade').map(row => row.id)
    .sort((a, b) => (departmentName.get(a) ?? '').localeCompare(departmentName.get(b) ?? '', 'ru') || a.localeCompare(b));
  const brigadeSet = new Set(brigadeIds);
  const [year, mon] = bounds.month.split('-').map(Number);

  // Один клиент транзакции — запросы по очереди. Отдел «Уволенные» — справочник настроек, через пул.
  const archiveDepartmentPromise = import('./employee-archive-department.service.js')
    .then(module => module.getKnownArchiveDepartment())
    .then(department => department?.id ?? null)
    .catch(() => null);
  const schedules = await resolveSchedulesForPeriod(
    ids.map(id => ({ id, org_department_id: loaded.employees.get(id)?.org_department_id ?? null })), bounds.start, bounds.end, exec,
  );
  const calendar = await loadCalendarMonth(year, mon, exec);
  const assignments = await rowsOf<IEmploymentAssignment & { employee_id: number }>(exec, `
    SELECT employee_id, org_department_id::text AS org_department_id, effective_from::text AS effective_from,
           effective_to::text AS effective_to
      FROM employee_assignments WHERE employee_id = ANY($1::int[])`, [ids]);
  const archiveDepartmentId = await archiveDepartmentPromise;
  timing?.mark('schedules');

  // Объект и категория — как «Свод».
  const breakdown = new Map(ids.map(id => [monthPairKey(id, bounds.month), toBreakdownRows(loaded.days.get(id)!.values(), loaded.objects)]));
  const pairs = ids.map(id => ({ employeeId: id, month: bounds.month }));
  const attribution = await attributeMonths(pairs, breakdown, new Map(ids.map(id => [id, {
    org_department_id: loaded.employees.get(id)?.org_department_id ?? null,
    employment_status: loaded.employees.get(id)?.employment_status ?? null,
  }])), exec);
  const steps = new Map<string, SummaryObjectStep>();
  timing?.mark('attribution');
  const summaryObjects = await resolveSummaryObjects(attribution, now, undefined, { exec, steps });
  timing?.mark('summary_objects');
  const finalObject = (id: number) => {
    const key = monthPairKey(id, bounds.month);
    return summaryObjects.get(key) ?? attribution.get(key)?.object ?? { key: UNKNOWN_OBJECT.key, name: UNKNOWN_OBJECT.name };
  };
  const categories = await resolveMonthStaffCategories(ids.map(id => {
    const item = attribution.get(monthPairKey(id, bounds.month));
    return {
      employeeId: id,
      monthStart: bounds.start,
      officeObject: finalObject(id).key === OFFICE_OBJECT.key,
      departmentId: item?.departmentId ?? null,
      mode: item?.mode,
    };
  }), exec);
  timing?.mark('categories');

  const apiObject = (key: string, name: string): IApiObject => {
    if (key === OFFICE_OBJECT.key) return OFFICE_OBJECT;
    if (key === UNKNOWN_OBJECT.key) return UNKNOWN_OBJECT;
    const known = loaded.objects.get(key);
    if (known) return known;
    const skud = loaded.skudObjects.get(key);
    const object = { key, id: key, name: skud?.name?.trim() || name, address: skud?.alt_name ?? null };
    loaded.objects.set(key, object);
    return object;
  };

  // Бригады: закрытый день — по подаче бригады, живой — по окну членства. Окна — только бригадам, где люди с
  // живыми рабочими днями числились в месяце (текущий отдел или назначение, задевающее месяц).
  const liveWorked = new Set(ids.filter(id => [...loaded.days.get(id)!.values()].some(day => day.source === 'live' && day.worked)));
  const candidateBrigades = new Set<string>();
  for (const id of liveWorked) {
    const current = loaded.employees.get(id)?.org_department_id;
    if (current && brigadeSet.has(current)) candidateBrigades.add(current);
  }
  for (const row of assignments) {
    if (!liveWorked.has(Number(row.employee_id)) || !row.org_department_id || !brigadeSet.has(row.org_department_id)) continue;
    if (row.effective_from <= bounds.until && (row.effective_to === null || row.effective_to >= bounds.start)) {
      candidateBrigades.add(row.org_department_id);
    }
  }
  // Уволенный в месяце числится в бригаде до увольнения (firedInDismissalMonth) — отдел из события увольнения.
  if (liveWorked.size > 0) {
    const dismissals = await rowsOf<{ department_id: string | null }>(exec, `
      SELECT DISTINCT de.from_department_id::text AS department_id
        FROM employee_dismissal_events de
       WHERE de.cancelled = false AND de.employee_id = ANY($1::int[])`, [[...liveWorked]]);
    for (const row of dismissals) if (row.department_id && brigadeSet.has(row.department_id)) candidateBrigades.add(row.department_id);
  }
  const windows = await loadBrigadeWindows(exec, brigadeIds.filter(id => candidateBrigades.has(id)), bounds);
  const shares: IBrigadeDayShare[] = [];
  for (const id of ids) {
    for (const day of loaded.days.get(id)!.values()) {
      if (!day.worked || day.parts.length === 0) continue;
      const departmentId = day.source === 'closed'
        ? (day.departmentId && brigadeSet.has(day.departmentId) ? day.departmentId : null)
        : (windows.get(id) ?? []).find(item => isWithinMembershipWindow(item.window, day.date, 'viaTransferOnly'))?.departmentId ?? null;
      if (departmentId) shares.push({ departmentId, employeeId: id, date: day.date, parts: day.parts });
    }
  }
  const brigadeAggregates = aggregateBrigades(shares);
  timing?.mark('brigades');
  const brigadeObject = (departmentId: string): IApiObject | null => {
    const key = pickMainKnownKey(brigadeAggregates.get(departmentId)?.byObject ?? new Map(), loaded.objects);
    return key ? apiObject(key, key) : null;
  };

  const assignmentsBy = new Map<number, IEmploymentAssignment[]>();
  for (const row of assignments) assignmentsBy.set(Number(row.employee_id), [...(assignmentsBy.get(Number(row.employee_id)) ?? []), row]);
  const dates = listDates(bounds.start, bounds.end);
  const index = new Map<number, { mainKey: string; factByObject: Map<string, number> }>();
  let notFrozen = 0;
  let configErrors = 0;
  const rows: IStaffMonthRow[] = ids.map((id, position) => {
    const days = loaded.days.get(id)!;
    const fact = aggregateFact(days.values());
    const key = monthPairKey(id, bounds.month);
    const configError = loaded.configErrors.has(id);
    const resolved = finalObject(id);
    const object = configError ? UNKNOWN_OBJECT : apiObject(resolved.key, resolved.name);
    const step = steps.get(key);
    const byHours = pickMainObject(breakdown.get(key) ?? []);
    const objectSource: StaffMonthObjectSource = configError || object.key === UNKNOWN_OBJECT.key
      ? 'unknown'
      : step ?? (byHours && byHours.key === object.key ? 'hours' : 'mode');
    const departmentId = attribution.get(key)?.departmentId ?? null;
    const employeeSchedules = schedules.get(id);
    const norm = scheduleMonthNorm(employeeSchedules, bounds.month, calendar);
    const normDayHours = new Map(norm.days.map(day => [day.date, day.hours]));
    const employment = buildEmployeeEmploymentPeriods({
      hireDate: loaded.employees.get(id)?.hire_date ?? null,
      dismissalDate: loaded.employees.get(id)?.dismissal_date ?? null,
      assignments: assignmentsBy.get(id) ?? [],
      archiveDepartmentId,
      startDate: bounds.start,
      endDate: bounds.end,
    });
    const brigadeId = pickEmployeeBrigade(id, brigadeAggregates, departmentIdValue => departmentName.get(departmentIdValue) ?? '');
    if (!fact.frozen) notFrozen += 1;
    if (configError) configErrors += 1;
    index.set(id, { mainKey: object.key, factByObject: fact.factByObject });
    return {
      employee_id: id,
      full_name: loaded.names.get(id) ?? null,
      department: departmentId ? { id: departmentId, name: departmentName.get(departmentId) ?? '' } : null,
      category: categories[position] as StaffMonthCategory,
      is_worker: categories[position] === 'worker',
      object,
      object_source: objectSource,
      objects: objectHoursList(fact.factByObject, loaded.objects),
      hours: fromCenti(fact.factCenti),
      norm: {
        hours: norm.complete && norm.totalMinutes !== null ? Math.round(norm.totalMinutes / 0.6) / 100 : null,
        days: norm.complete ? countMonthNormDays(employeeSchedules, bounds.month, calendar) : null,
        complete: norm.complete,
        weekend_quota: {
          saturdays: norm.saturdays,
          sundays: norm.sundays,
          hours: Math.round((norm.saturdays + norm.sundays) * norm.quotaHours * 100) / 100,
        },
      },
      brigade: brigadeId ? { department_id: brigadeId, name: departmentName.get(brigadeId) ?? '', object: brigadeObject(brigadeId) } : null,
      preliminary: fact.preliminary,
      object_config_error: configError,
      object_frozen: fact.frozen,
      days: dates.map((date): IStaffMonthDay => {
        const record = days.get(date);
        const schedule = employeeSchedules?.get(date);
        const kind = schedule ? classifyPlanDay(schedule, new Date(year, mon - 1, Number(date.slice(8, 10))), calendar) : null;
        const worked = record?.worked ? record.parts : [];
        return {
          date,
          employed: employment.some(range => range.from <= date && date <= range.to),
          day_kind: kind,
          working_day: kind === null ? null : kind === 'work' || kind === 'pre_holiday',
          plan_hours: schedule ? (normDayHours.get(date) ?? 0) : null,
          status_code: record?.status ?? null,
          timesheet_hours: fromCenti(record?.timesheetCenti ?? 0),
          hours: fromCenti(worked.reduce((sum, part) => sum + part.centi, 0)),
          objects: worked.map(part => ({ object: loaded.objects.get(part.key) ?? UNKNOWN_OBJECT, hours: fromCenti(part.centi) })),
          source: record?.source ?? null,
        };
      }),
    };
  });

  const brigades: IStaffMonthBrigade[] = brigadeIds.filter(id => brigadeAggregates.has(id)).map(departmentId => {
    const aggregate = brigadeAggregates.get(departmentId)!;
    return {
      department_id: departmentId,
      name: departmentName.get(departmentId) ?? '',
      object: brigadeObject(departmentId),
      objects: objectHoursList(aggregate.byObject, loaded.objects),
      members: [...aggregate.members].sort(([a], [b]) => a - b).map(([employeeId, member]) => ({ employee_id: employeeId, hours: fromCenti(member.centi) })),
    };
  });

  const objectStats = new Map<string, { fact: Set<number>; main: Set<number>; centi: number }>();
  const stat = (key: string) => {
    let entry = objectStats.get(key);
    if (!entry) {
      entry = { fact: new Set(), main: new Set(), centi: 0 };
      objectStats.set(key, entry);
    }
    return entry;
  };
  for (const [id, item] of index) {
    stat(item.mainKey).main.add(id);
    for (const [key, centi] of item.factByObject) {
      if (centi <= 0) continue;
      stat(key).fact.add(id);
      stat(key).centi += centi;
    }
  }
  const objects: IStaffMonthObject[] = [...objectStats]
    .map(([key, entry]) => ({
      object: loaded.objects.get(key) ?? UNKNOWN_OBJECT,
      employees_fact: entry.fact.size,
      employees_main: entry.main.size,
      hours: fromCenti(entry.centi),
    }))
    .sort((a, b) => a.object.name.localeCompare(b.object.name, 'ru') || a.object.key.localeCompare(b.object.key));

  return {
    id: randomUUID(),
    month: bounds.month,
    bounds,
    generatedAt: now.toISOString(),
    fingerprint,
    hasLive: rows.some(row => row.days.some(day => day.source === 'live')),
    preliminary: rows.some(row => row.preliminary),
    rows,
    index,
    brigades,
    objects,
    meta: { duplicate_days: loaded.duplicateDays, object_config_errors: configErrors, objects_not_frozen: notFrozen },
  };
};
