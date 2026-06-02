import { query } from '../config/postgres.js';
import type { IDepartmentTimesheetData, TimesheetExportRangeArg } from './timesheet-export.service.js';
import { fetchTimesheetDataForEmployees } from './timesheet-export.service.js';
import { resolveTimesheetPeriodRange, resolveTimesheetDateRange } from './timesheet-department-assignments.service.js';

interface IDeptGroup {
  name: string;
  ids: number[];
}

const SYNTHETIC_NO_DEPARTMENT_ID = '00000000-0000-0000-0000-000000000000';

function isMissingTableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? String((error as { code?: unknown }).code || '') : '';
  return code === '42P01';
}

function isExportRange(value: TimesheetExportRangeArg): value is { startDate: string; endDate: string } {
  return typeof value === 'object' && value !== null
    && typeof (value as any).startDate === 'string' && typeof (value as any).endDate === 'string';
}

export async function fetchEmployeeIdsForObjects(
  objectIds: string[],
  startDate: string,
  endDate: string,
): Promise<number[]> {
  if (objectIds.length === 0) return [];

  const rows = await query<{ employee_id: number }>(
    `SELECT DISTINCT se.employee_id
       FROM skud_events se
       JOIN skud_object_access_points sap
         ON BTRIM(lower(sap.access_point_name)) = BTRIM(lower(se.access_point))
      WHERE sap.object_id = ANY($1::uuid[])
        AND se.event_date BETWEEN $2::date AND $3::date
        AND se.employee_id IS NOT NULL
      UNION
      SELECT DISTINCT aa.employee_id
        FROM attendance_adjustments aa
       WHERE aa.source_type = 'manual_object'
         AND (aa.metadata->>'object_id')::uuid = ANY($1::uuid[])
         AND aa.work_date BETWEEN $2::date AND $3::date
      UNION
      SELECT DISTINCT aa.employee_id
        FROM attendance_adjustments aa
       WHERE aa.source_type IN ('manual', 'leave_request')
         AND aa.status IN ('work', 'remote')
         AND aa.work_date BETWEEN $2::date AND $3::date
         AND EXISTS (
           SELECT 1
             FROM skud_events se
             JOIN skud_object_access_points sap
               ON BTRIM(lower(sap.access_point_name)) = BTRIM(lower(se.access_point))
            WHERE sap.object_id = ANY($1::uuid[])
              AND se.employee_id = aa.employee_id
              AND se.event_date BETWEEN date_trunc('month', $2::date)::date AND $3::date
         )`,
    [objectIds, startDate, endDate],
  );

  return rows.map(r => r.employee_id);
}

export async function fetchDeptGroupsForEmployees(
  employeeIds: number[],
): Promise<Map<string, IDeptGroup>> {
  if (employeeIds.length === 0) return new Map();

  const rows = await query<{ org_department_id: string | null; org_department_name: string | null; employee_ids: number[] }>(
    `SELECT COALESCE(e.org_department_id, '00000000-0000-0000-0000-000000000000'::uuid) AS org_department_id,
            COALESCE(d.name, 'Без отдела') AS org_department_name,
            array_agg(e.id) AS employee_ids
       FROM employees e
       LEFT JOIN org_departments d ON d.id = e.org_department_id
      WHERE e.id = ANY($1::int[])
        AND e.is_archived = false
        AND e.excluded_from_timesheet = false
      GROUP BY COALESCE(e.org_department_id, '00000000-0000-0000-0000-000000000000'::uuid),
               COALESCE(d.name, 'Без отдела')
      ORDER BY org_department_name`,
    [employeeIds],
  );

  const map = new Map<string, IDeptGroup>();
  for (const row of rows) {
    const key = row.org_department_id || '__unknown__';
    map.set(key, {
      name: row.org_department_name || 'Без отдела',
      ids: row.employee_ids,
    });
  }
  return map;
}

/**
 * Руководители отделов/бригад, появившихся на объекте. Руководитель определяется
 * назначением в employee_department_access (source != 'sigur_sync', is_active=true)
 * на сам появившийся отдел ИЛИ на любого его предка по дереву org_departments —
 * рабочие лежат в бригадах (kind='brigade'), а начальник часто назначен на
 * родительский отдел (kind='department'). Ключ карты = id появившегося
 * отдела/бригады (appearing_id), значение = employee_id руководителей.
 */
export async function fetchManagerIdsForDepartments(
  departmentIds: string[],
): Promise<Map<string, number[]>> {
  const result = new Map<string, number[]>();
  if (departmentIds.length === 0) return result;

  try {
    const rows = await query<{ department_id: string; employee_ids: number[] }>(
      `WITH RECURSIVE ancestry(appearing_id, dept_id, parent_id) AS (
         SELECT a.dept_id, d.id, d.parent_id
           FROM unnest($1::uuid[]) AS a(dept_id)
           JOIN org_departments d ON d.id = a.dept_id
         UNION ALL
         SELECT an.appearing_id, p.id, p.parent_id
           FROM ancestry an
           JOIN org_departments p ON p.id = an.parent_id
       )
       SELECT an.appearing_id AS department_id,
              array_agg(DISTINCT eda.employee_id) AS employee_ids
         FROM ancestry an
         JOIN employee_department_access eda
           ON eda.department_id = an.dept_id
          AND eda.is_active = true
          AND eda.source <> 'sigur_sync'
         JOIN employees e
           ON e.id = eda.employee_id
          AND e.is_archived = false
          AND e.excluded_from_timesheet = false
        GROUP BY an.appearing_id`,
      [departmentIds],
    );

    for (const row of rows) {
      result.set(row.department_id, row.employee_ids);
    }
    return result;
  } catch (err) {
    if (isMissingTableError(err)) {
      console.warn(
        '[timesheet-objects-export] table public.employee_department_access not found; managers are not added to object export.',
      );
      return result;
    }
    throw err;
  }
}

/**
 * Добавляет руководителей в группы соответствующих отделов/бригад.
 * Дедуп внутри группы (руководитель уже мог пробить СКУД) и между группами
 * (руководитель отдела D, под которым появились бригады B1 и B2, попадает только
 * в первую по сортировке ключей) — одна строка статуса на руководителя.
 */
export function mergeManagerIdsIntoGroups(
  deptGroups: Map<string, IDeptGroup>,
  managerMap: Map<string, number[]>,
): void {
  const placed = new Set<number>();
  for (const key of [...deptGroups.keys()].sort()) {
    const managerIds = managerMap.get(key);
    if (!managerIds || managerIds.length === 0) continue;
    const group = deptGroups.get(key);
    if (!group) continue;

    const fresh = managerIds.filter(id => !placed.has(id));
    if (fresh.length === 0) continue;
    fresh.forEach(id => placed.add(id));
    group.ids = [...new Set([...group.ids, ...fresh])];
  }
}

export async function fetchTimesheetDataForObjectIds(
  month: string,
  objectIds: string[],
  rangeArg: TimesheetExportRangeArg = 'FULL',
  departmentIdFilter?: string[],
): Promise<IDepartmentTimesheetData[]> {
  if (objectIds.length === 0) return [];

  const periodRange = isExportRange(rangeArg)
    ? resolveTimesheetDateRange(month, rangeArg.startDate, rangeArg.endDate)
    : resolveTimesheetPeriodRange(month, rangeArg);

  if (!periodRange) {
    throw new Error('Invalid export month');
  }

  const { startDate, endDate } = periodRange;
  const employeeIds = await fetchEmployeeIdsForObjects(objectIds, startDate, endDate);

  if (employeeIds.length === 0) {
    return [];
  }

  let deptGroups = await fetchDeptGroupsForEmployees(employeeIds);

  // Добавляем руководителей появившихся отделов/бригад (они не пробивают СКУД).
  const appearingDeptIds = [...deptGroups.keys()].filter(
    key => key !== SYNTHETIC_NO_DEPARTMENT_ID && key !== '__unknown__',
  );
  const managerMap = await fetchManagerIdsForDepartments(appearingDeptIds);
  mergeManagerIdsIntoGroups(deptGroups, managerMap);

  // Фильтруем отделы если задан фильтр
  if (departmentIdFilter && departmentIdFilter.length > 0) {
    const allowedDeptIds = new Set(departmentIdFilter);
    const filtered = new Map<string, IDeptGroup>();
    for (const [key, group] of deptGroups) {
      if (allowedDeptIds.has(key)) {
        filtered.set(key, group);
      }
    }
    deptGroups = filtered;
  }

  const results: IDepartmentTimesheetData[] = [];

  for (const [, group] of deptGroups) {
    const data = await fetchTimesheetDataForEmployees(
      month,
      group.ids,
      group.name,
      rangeArg,
      'actual',
      true,
    );

    // Фильтруем objectEntries только к выбранным объектам
    const objectIdSet = new Set(objectIds);
    data.objectEntries = data.objectEntries.filter(
      e => e.object_id && objectIdSet.has(e.object_id),
    );

    results.push(data);
  }

  return results;
}
