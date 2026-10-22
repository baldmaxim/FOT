/**
 * Объект и отдел месяца в «Зарплате» — для «Свода» и расчётного листка. Только чтение.
 *
 * Объект — объект табелирования из объектной разбивки закрытого табеля (последняя редакция каждой подачи
 * месяца), основной по часам (payroll-summary.attribution.ts); нет разбивки или часов — режим
 * табелирования месяца. Имя объекта — текущее из справочника СКУД.
 *
 * Отдел месяца — отдел подачи с наибольшими часами; персональная подача или подачи нет — у уволенного
 * отдел до увольнения (последнее неотменённое увольнение), иначе текущий.
 */
import { query } from '../../config/postgres.js';
import { resolveExportModes, type IResolvedExportMode } from '../timesheet-export-mode.service.js';
import {
  fallbackSummaryObject,
  pickMainObject,
  pickMonthDepartment,
  type ISummaryBreakdownRow,
  type ISummaryObject,
  type ISummaryObjectMeta,
} from './payroll-summary.attribution.js';

/** Ключ пары «сотрудник + месяц YYYY-MM». */
export const monthPairKey = (employeeId: number, month: string): string => `${employeeId}|${month}`;

interface IBreakdownSqlRow extends ISummaryBreakdownRow {
  month: string;
  employee_id: number;
}

/**
 * Разбивка подач месяцев (первые числа) по парам: последняя редакция каждой подачи, строка — часы
 * сотрудника на объекте. Сотрудник в подаче без объектов — одна строка с object_key NULL и нулём часов
 * (виден отдел подачи).
 */
export const loadMonthBreakdown = async (
  monthStarts: string[],
  employeeIds: number[],
): Promise<Map<string, ISummaryBreakdownRow[]>> => {
  const result = new Map<string, ISummaryBreakdownRow[]>();
  if (monthStarts.length === 0 || employeeIds.length === 0) return result;
  const rows = await query<IBreakdownSqlRow>(
    `WITH latest AS (
       SELECT DISTINCT ON (v.approval_id) v.id, v.department_id, v.start_date
         FROM timesheet_versions v
        WHERE date_trunc('month', v.start_date)::date = ANY($1::date[])
        ORDER BY v.approval_id, v.revision DESC
     )
     SELECT to_char(l.start_date, 'YYYY-MM') AS month,
            (emp->>'employee_id')::int AS employee_id,
            l.id::int AS version_id,
            l.department_id::text AS department_id,
            obj->>'object_key' AS object_key,
            obj->>'object_id' AS object_id,
            obj->>'object_name' AS object_name,
            obj->>'object_address' AS object_address,
            COALESCE((obj->>'total_hours')::float8, 0) AS hours
       FROM latest l
       JOIN timesheet_version_objects vo ON vo.version_id = l.id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(vo.payload->'employees', '[]'::jsonb)) AS emp
       LEFT JOIN LATERAL jsonb_array_elements(COALESCE(emp->'objects', '[]'::jsonb)) AS obj ON true
      WHERE (emp->>'employee_id')::int = ANY($2::int[])`,
    [monthStarts, employeeIds],
  );
  for (const row of rows) {
    const key = monthPairKey(Number(row.employee_id), row.month);
    const item: ISummaryBreakdownRow = {
      version_id: Number(row.version_id),
      department_id: row.department_id,
      object_key: row.object_key,
      object_id: row.object_id,
      object_name: row.object_name,
      object_address: row.object_address,
      hours: Number(row.hours),
    };
    const list = result.get(key);
    if (list) list.push(item);
    else result.set(key, [item]);
  }
  return result;
};

/** Сотрудник для запасного отдела месяца. */
export interface IMonthEmployee {
  org_department_id: string | null;
  employment_status: string | null;
}

export interface IMonthAttribution {
  object: ISummaryObject;
  departmentId: string | null;
  /** Режим табелирования месяца (для прошедшего — из фиксации). */
  mode: IResolvedExportMode | undefined;
}

const loadObjectMeta = async (ids: string[]): Promise<Map<string, ISummaryObjectMeta>> => {
  if (ids.length === 0) return new Map();
  const rows = await query<{ id: string; name: string; alt_name: string | null }>(
    'SELECT id::text AS id, name, alt_name FROM skud_objects WHERE id::text = ANY($1::text[])',
    [ids],
  );
  return new Map(rows.map(row => [row.id, { name: row.name, address: row.alt_name }]));
};

/** Режимы табелирования месяцев по парам. */
const loadMonthModes = async (
  pairs: ReadonlyArray<{ employeeId: number; month: string }>,
): Promise<Map<string, IResolvedExportMode>> => {
  const byMonth = new Map<string, number[]>();
  for (const pair of pairs) {
    const list = byMonth.get(pair.month);
    if (list) list.push(pair.employeeId);
    else byMonth.set(pair.month, [pair.employeeId]);
  }
  const result = new Map<string, IResolvedExportMode>();
  for (const [month, ids] of byMonth) {
    const modes = await resolveExportModes(ids, undefined, { month });
    for (const [employeeId, mode] of modes) result.set(monthPairKey(employeeId, month), mode);
  }
  return result;
};

/** Отдел до увольнения: последнее неотменённое увольнение. */
const loadDismissalDepartments = async (employeeIds: number[]): Promise<Map<number, string | null>> => {
  if (employeeIds.length === 0) return new Map();
  const rows = await query<{ employee_id: number; department_id: string | null }>(
    `SELECT DISTINCT ON (de.employee_id) de.employee_id, de.from_department_id::text AS department_id
       FROM employee_dismissal_events de
      WHERE de.cancelled = false AND de.employee_id = ANY($1::int[])
      ORDER BY de.employee_id, de.created_at DESC`,
    [employeeIds],
  );
  return new Map(rows.map(row => [Number(row.employee_id), row.department_id]));
};

/** Объект, отдел и режим месяца для пар (month — YYYY-MM); breakdown — loadMonthBreakdown этих пар. */
export const attributeMonths = async (
  pairs: ReadonlyArray<{ employeeId: number; month: string }>,
  breakdown: ReadonlyMap<string, readonly ISummaryBreakdownRow[]>,
  employees: ReadonlyMap<number, IMonthEmployee>,
): Promise<Map<string, IMonthAttribution>> => {
  const result = new Map<string, IMonthAttribution>();
  if (pairs.length === 0) return result;

  const firedWithoutMonthDepartment = [...new Set(pairs
    .filter(pair => employees.get(pair.employeeId)?.employment_status === 'fired'
      && pickMonthDepartment(breakdown.get(monthPairKey(pair.employeeId, pair.month)) ?? []) === null)
    .map(pair => pair.employeeId))];
  const [modes, dismissalDepartments] = await Promise.all([
    loadMonthModes(pairs),
    loadDismissalDepartments(firedWithoutMonthDepartment),
  ]);

  const mainObjects = new Map<string, ISummaryObject | null>();
  for (const pair of pairs) {
    const key = monthPairKey(pair.employeeId, pair.month);
    mainObjects.set(key, pickMainObject(breakdown.get(key) ?? []));
  }
  const pinnedIds = [...modes.values()]
    .map(mode => (mode.mode === 'object' ? mode.pinnedObjectId : null))
    .filter((id): id is string => id !== null);
  const breakdownIds = [...mainObjects.values()]
    .map(object => object?.key ?? null)
    .filter((id): id is string => id !== null && id !== 'office' && id !== 'unknown');
  const objectMeta = await loadObjectMeta([...new Set([...pinnedIds, ...breakdownIds])]);

  for (const pair of pairs) {
    const key = monthPairKey(pair.employeeId, pair.month);
    const mode = modes.get(key);
    const main = mainObjects.get(key) ?? null;
    const object = main ?? fallbackSummaryObject(mode, objectMeta);
    // Имя объекта — текущее из справочника СКУД (в разбивке — имя на момент закрытия табеля).
    const name = objectMeta.get(object.key)?.name?.trim() || object.name;
    const employee = employees.get(pair.employeeId);
    const departmentId = pickMonthDepartment(breakdown.get(key) ?? [])
      ?? (employee?.employment_status === 'fired' ? dismissalDepartments.get(pair.employeeId) ?? null : null)
      ?? employee?.org_department_id
      ?? null;
    result.set(key, { object: { key: object.key, name }, departmentId, mode });
  }
  return result;
};
