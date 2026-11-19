/**
 * API для ЗУП3 «сотрудники месяца» — дни сотрудников из БД (вызывается внутри withReadOnlySnapshot, exec — его клиент).
 *
 * Закрытый день — последняя редакция подачи месяца, подача согласована (status = 'approved') и не в аварийной
 * пересборке (version_dirty_at IS NULL), как у GET /timesheets. Открытая для правок подача отдаёт ту же последнюю
 * закрытую редакцию. Части дня — снимок timesheet_version_objects; у редакции без снимка — официальные часы дня,
 * веса объектов из живых проходов (buildVersionObjectBreakdown).
 *
 * Живой день — только у пары без закрытого дня: живой табель (fetchTimesheetDataForEmployees, как «Зарплата
 * бригады»), отсечка после увольнения. Охват живого — работавшие в месяце не подрядчики (по текущему отделу).
 */
import type { DbExecutor } from '../config/postgres.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import { listSectionDepartmentIds, type IExportDepartmentRow } from './employees-export.service.js';
import { loadSkudObjects, type ISkudObjectInfo } from './employee-timesheet-object.service.js';
import { summaryObjectOf } from './payroll/payroll-summary.attribution.js';
import { WORKED_STATUSES } from './payroll/brigade-salary.calc.js';
import { buildVersionObjectBreakdown, type IObjectMeta } from './timesheet-object-breakdown.service.js';
import { resolveExportModes } from './timesheet-export-mode.service.js';
import { fetchTimesheetDataForEmployees } from './timesheet-export.service.js';
import {
  normalizeParts,
  OFFICE_OBJECT,
  pickLatestVersion,
  toCenti,
  UNKNOWN_OBJECT,
  type IApiObject,
  type IDayPart,
  type IDayRecord,
} from './staff-month-1c.rules.js';

export interface IMonthBounds {
  month: string;
  start: string;
  end: string;
  /** Последний день с данными: конец месяца или сегодня (МСК) у текущего. */
  until: string;
  /** Месяц текущий — живые дни ещё меняются. */
  open: boolean;
}

export const monthBoundsOf = (month: string, now: Date = new Date()): IMonthBounds => {
  const [year, mon] = month.split('-').map(Number);
  const end = `${month}-${String(new Date(year, mon, 0).getDate()).padStart(2, '0')}`;
  const today = moscowTodayIso(now);
  return { month, start: `${month}-01`, end, until: today < end ? today : end, open: today.slice(0, 7) === month };
};

interface IVersionSqlRow {
  version_id: number;
  department_id: string | null;
  created_at: string;
  official: boolean;
  has_objects: boolean;
  employees: Array<{ identity?: { employee_id?: number; full_name?: string | null }; days?: Record<string, { status?: string; hours?: number }> }> | null;
  objects: Array<{ employee_id: number; objects?: IObjectSqlRow[] }> | null;
  config_errors: Array<{ employee_id: number }> | null;
}

interface IObjectSqlRow {
  object_id: string | null;
  object_key: string;
  object_name: string;
  object_address: string | null;
  days?: Record<string, number>;
}

export interface IEmployeeSqlRow {
  id: number;
  full_name: string | null;
  org_department_id: string | null;
  employment_status: string | null;
  hire_date: string | null;
  dismissal_date: string | null;
}

export interface ILoadedDays {
  days: Map<number, Map<string, IDayRecord>>;
  names: Map<number, string | null>;
  objects: Map<string, IApiObject>;
  configErrors: Set<number>;
  duplicateDays: number;
  employees: Map<number, IEmployeeSqlRow>;
  departments: IExportDepartmentRow[];
  skudObjects: Map<string, ISkudObjectInfo>;
}

const rowsOf = async <T>(exec: DbExecutor, sql: string, params: unknown[]): Promise<T[]> => (
  (await exec.query(sql, params)).rows as T[]
);

/** Отпечаток закрытой части месяца: подачи, выбранные редакции, их состояние и снимки объектов. */
export const loadClosedFingerprint = async (exec: DbExecutor, monthStart: string): Promise<string> => {
  const [row] = await rowsOf<{ fp: string }>(exec, `
    SELECT md5(COALESCE(string_agg(concat_ws('|', a.id, l.id, l.revision, a.status, a.version_dirty_at, a.unlocked_at,
                                             vo.objects_content_hash), ',' ORDER BY a.id), '')) AS fp
      FROM (SELECT DISTINCT ON (v.approval_id) v.id, v.approval_id, v.revision
              FROM timesheet_versions v
             WHERE date_trunc('month', v.start_date)::date = $1::date
             ORDER BY v.approval_id, v.revision DESC) l
      JOIN timesheet_approvals a ON a.id = l.approval_id
      LEFT JOIN timesheet_version_objects vo ON vo.version_id = l.id`, [monthStart]);
  return row?.fp ?? '';
};

/** Объект API из строки разбивки: «Офис» и «Не определён» — общие; объект СКУД — имя и адрес из справочника. */
const apiObjectOf = (row: IObjectSqlRow, dict: ReadonlyMap<string, ISkudObjectInfo>): IApiObject => {
  const group = summaryObjectOf({
    version_id: 0, department_id: null, hours: 0,
    object_key: row.object_key, object_id: row.object_id, object_name: row.object_name, object_address: row.object_address,
  });
  if (group.key === OFFICE_OBJECT.key) return OFFICE_OBJECT;
  if (group.key === UNKNOWN_OBJECT.key) return UNKNOWN_OBJECT;
  const current = dict.get(group.key);
  return {
    key: group.key,
    id: group.key,
    name: current?.name?.trim() || row.object_name?.trim() || UNKNOWN_OBJECT.name,
    address: current?.alt_name ?? row.object_address ?? null,
  };
};

const VERSIONS_SQL = `
  WITH latest AS (
    SELECT DISTINCT ON (v.approval_id) v.id, v.approval_id, v.department_id, v.created_at, v.payload
      FROM timesheet_versions v
     WHERE date_trunc('month', v.start_date)::date = $1::date
     ORDER BY v.approval_id, v.revision DESC
  )
  SELECT l.id::int AS version_id, l.department_id::text AS department_id,
         to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS created_at,
         (a.status = 'approved' AND a.version_dirty_at IS NULL) AS official,
         (vo.version_id IS NOT NULL) AS has_objects,
         l.payload->'employees' AS employees, vo.payload->'employees' AS objects, vo.config_errors
    FROM latest l
    JOIN timesheet_approvals a ON a.id = l.approval_id
    LEFT JOIN timesheet_version_objects vo ON vo.version_id = l.id`;

interface IClosedCandidate {
  versionId: number;
  createdAt: string;
  departmentId: string | null;
  status: string;
  centi: number;
  parts: IDayPart[] | null;
}

const pairKey = (employeeId: number, date: string): string => `${employeeId}|${date}`;

/** Дни месяца: закрытые, затем живые. */
export const loadMonthDays = async (
  exec: DbExecutor, bounds: IMonthBounds, timing?: { mark: (step: string) => void },
): Promise<ILoadedDays> => {
  // Один клиент транзакции — запросы по очереди.
  const versions = await rowsOf<IVersionSqlRow>(exec, VERSIONS_SQL, [bounds.start]);
  const departments = await rowsOf<IExportDepartmentRow>(exec, 'SELECT id::text AS id, parent_id::text AS parent_id, name, kind FROM org_departments', []);
  const skudObjects = await loadSkudObjects(exec);
  const objects = new Map<string, IApiObject>([[OFFICE_OBJECT.key, OFFICE_OBJECT], [UNKNOWN_OBJECT.key, UNKNOWN_OBJECT]]);
  const keyOf = (row: IObjectSqlRow): string => {
    const object = apiObjectOf(row, skudObjects);
    if (!objects.has(object.key)) objects.set(object.key, object);
    return object.key;
  };
  const names = new Map<number, string | null>();
  const configErrors = new Set<number>();
  const official = new Map<string, IClosedCandidate[]>();
  const rework = new Set<string>();
  const unfrozen: Array<{ employeeId: number; date: string }> = [];

  for (const version of versions) {
    const partsByPair = new Map<string, IDayPart[]>();
    for (const employee of version.objects ?? []) {
      for (const row of employee.objects ?? []) {
        const key = keyOf(row);
        for (const [date, hours] of Object.entries(row.days ?? {})) {
          const list = partsByPair.get(pairKey(employee.employee_id, date)) ?? [];
          list.push({ key, centi: toCenti(hours) });
          partsByPair.set(pairKey(employee.employee_id, date), list);
        }
      }
    }
    if (version.official) for (const error of version.config_errors ?? []) configErrors.add(Number(error.employee_id));
    for (const employee of version.employees ?? []) {
      const employeeId = Number(employee.identity?.employee_id);
      if (!Number.isSafeInteger(employeeId)) continue;
      if (!names.has(employeeId)) names.set(employeeId, employee.identity?.full_name ?? null);
      for (const [date, value] of Object.entries(employee.days ?? {})) {
        if (date < bounds.start || date > bounds.end) continue;
        const key = pairKey(employeeId, date);
        if (!version.official) {
          rework.add(key);
          continue;
        }
        const list = official.get(key) ?? [];
        list.push({
          versionId: version.version_id,
          createdAt: version.created_at,
          departmentId: version.department_id,
          status: value?.status ?? 'absent',
          centi: toCenti(value?.hours ?? 0),
          parts: version.has_objects ? (partsByPair.get(key) ?? []) : null,
        });
        official.set(key, list);
      }
    }
  }

  const days = new Map<number, Map<string, IDayRecord>>();
  const put = (employeeId: number, record: IDayRecord): void => {
    const byDate = days.get(employeeId) ?? new Map<string, IDayRecord>();
    byDate.set(record.date, record);
    days.set(employeeId, byDate);
  };
  let duplicateDays = 0;
  for (const [key, candidates] of official) {
    if (candidates.length > 1) duplicateDays += 1;
    const winner = pickLatestVersion(candidates)!;
    const [employeeIdRaw, date] = key.split('|');
    const employeeId = Number(employeeIdRaw);
    if (winner.parts === null && winner.centi > 0) unfrozen.push({ employeeId, date });
    put(employeeId, {
      date,
      source: 'closed',
      status: winner.status,
      timesheetCenti: winner.centi,
      parts: normalizeParts(winner.centi, winner.parts ?? []),
      worked: WORKED_STATUSES.has(winner.status),
      versionId: winner.versionId,
      departmentId: winner.departmentId,
      frozen: winner.parts !== null,
      preliminary: false,
    });
  }

  const contractorIds = listSectionDepartmentIds(departments, 'contractors');
  const employees = await rowsOf<IEmployeeSqlRow>(exec, `
    SELECT e.id, e.full_name, e.org_department_id::text AS org_department_id, e.employment_status,
           e.hire_date::text AS hire_date, e.dismissal_date::text AS dismissal_date
      FROM employees e
     WHERE e.id = ANY($1::int[])
        OR (e.is_archived = false
            AND (e.hire_date IS NULL OR e.hire_date <= $3::date)
            AND (e.dismissal_date IS NULL OR e.dismissal_date >= $2::date)
            AND NOT (e.employment_status = 'fired' AND e.dismissal_date IS NULL)
            AND (e.org_department_id IS NULL OR NOT (e.org_department_id::text = ANY($4::text[]))))`,
  [[...days.keys(), ...new Set([...rework].map(key => Number(key.split('|')[0])))], bounds.start, bounds.end, contractorIds]);
  const employeeById = new Map(employees.map(row => [Number(row.id), { ...row, id: Number(row.id) }]));
  timing?.mark('closed');

  // Живой табель — у кого в окне работы [start, until] есть дата без закрытого дня, и у редакций без снимка (веса).
  const liveIds = new Set<number>(unfrozen.map(item => item.employeeId));
  if (bounds.until >= bounds.start) {
    for (const employee of employeeById.values()) {
      const from = employee.hire_date && employee.hire_date > bounds.start ? employee.hire_date : bounds.start;
      const to = employee.dismissal_date && employee.dismissal_date < bounds.until ? employee.dismissal_date : bounds.until;
      const own = days.get(employee.id);
      for (let date = from; date <= to; date = nextDate(date)) {
        if (!own?.has(date)) {
          liveIds.add(employee.id);
          break;
        }
      }
    }
  }
  if (liveIds.size > 0) {
    await attachLiveDays(exec, bounds, [...liveIds].sort((a, b) => a - b), {
      days, put, rework, unfrozen, objects, keyOf, skudObjects, names, configErrors,
    });
  }
  timing?.mark(`live(${liveIds.size})`);
  for (const [employeeId, employee] of employeeById) if (!names.has(employeeId)) names.set(employeeId, employee.full_name);
  return { days, names, objects, configErrors, duplicateDays, employees: employeeById, departments, skudObjects };
};

const nextDate = (iso: string): string => {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
};

interface ILiveContext {
  days: Map<number, Map<string, IDayRecord>>;
  put: (employeeId: number, record: IDayRecord) => void;
  rework: ReadonlySet<string>;
  unfrozen: ReadonlyArray<{ employeeId: number; date: string }>;
  objects: Map<string, IApiObject>;
  keyOf: (row: IObjectSqlRow) => string;
  skudObjects: ReadonlyMap<string, ISkudObjectInfo>;
  names: Map<number, string | null>;
  configErrors: Set<number>;
}

/** Живые дни пар без закрытого дня и живые веса объектов для закрытых дней редакций без снимка. */
const attachLiveDays = async (
  exec: DbExecutor, bounds: IMonthBounds, employeeIds: number[], ctx: ILiveContext,
): Promise<void> => {
  const data = await fetchTimesheetDataForEmployees(
    bounds.month, employeeIds, 'API ЗУП3', { startDate: bounds.start, endDate: bounds.until }, 'actual', true,
    { rosterMode: 'snapshot', exec },
  );
  for (const employee of data.employees) {
    if (!ctx.names.has(employee.id)) ctx.names.set(employee.id, employee.full_name ?? null);
  }
  const liveTargets = new Map<number, Record<string, { hours: number }>>();
  const liveValues = new Map<string, { status: string; centi: number }>();
  for (const [employeeId, byDate] of data.dataMap) {
    const cutoff = data.cutoffByEmployeeId?.get(employeeId) ?? null;
    for (const [date, value] of byDate) {
      if (date < bounds.start || date > bounds.until) continue;
      if (cutoff && date >= cutoff) continue;
      if (ctx.days.get(employeeId)?.has(date)) continue;
      const centi = toCenti(typeof value.hours === 'number' ? value.hours : 0);
      liveValues.set(pairKey(employeeId, date), { status: value.status, centi });
      const targets = liveTargets.get(employeeId) ?? {};
      targets[date] = { hours: centi / 100 };
      liveTargets.set(employeeId, targets);
    }
  }
  // Закрытые дни без снимка: целевые часы — официальные.
  for (const { employeeId, date } of ctx.unfrozen) {
    const record = ctx.days.get(employeeId)?.get(date);
    if (!record) continue;
    const targets = liveTargets.get(employeeId) ?? {};
    targets[date] = { hours: record.timesheetCenti / 100 };
    liveTargets.set(employeeId, targets);
  }

  const modeIds = [...liveTargets.keys()];
  const modes = await resolveExportModes(modeIds, exec, { month: bounds.start });
  const objectMetaById = new Map<string, IObjectMeta>([...ctx.skudObjects.values()]
    .map(object => [object.id, { name: object.name, address: object.alt_name ?? '' }]));
  const built = buildVersionObjectBreakdown({
    employees: modeIds.map(employeeId => ({ employee_id: employeeId, full_name: null, days: liveTargets.get(employeeId)! })),
    objectEntries: data.objectEntries ?? [],
    ownsDay: () => true,
    modeByEmployee: modes,
    objectMetaById,
  });
  for (const error of built.configErrors) ctx.configErrors.add(error.employee_id);
  const partsByPair = new Map<string, IDayPart[]>();
  for (const employee of built.payload.employees) {
    for (const row of employee.objects) {
      const key = ctx.keyOf(row);
      for (const [date, hours] of Object.entries(row.days)) {
        const list = partsByPair.get(pairKey(employee.employee_id, date)) ?? [];
        list.push({ key, centi: toCenti(hours) });
        partsByPair.set(pairKey(employee.employee_id, date), list);
      }
    }
  }
  for (const [key, value] of liveValues) {
    const [employeeIdRaw, date] = key.split('|');
    const employeeId = Number(employeeIdRaw);
    ctx.put(employeeId, {
      date,
      source: 'live',
      status: value.status,
      timesheetCenti: value.centi,
      parts: normalizeParts(value.centi, partsByPair.get(key) ?? []),
      worked: WORKED_STATUSES.has(value.status),
      versionId: null,
      departmentId: null,
      frozen: false,
      preliminary: bounds.open || ctx.rework.has(key),
    });
  }
  for (const { employeeId, date } of ctx.unfrozen) {
    const record = ctx.days.get(employeeId)?.get(date);
    if (record) record.parts = normalizeParts(record.timesheetCenti, partsByPair.get(pairKey(employeeId, date)) ?? []);
  }
};
