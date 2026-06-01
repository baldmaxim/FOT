import { query } from '../config/postgres.js';
import type { IDepartmentTimesheetData, TimesheetExportRangeArg } from './timesheet-export.service.js';
import { fetchTimesheetDataForEmployees } from './timesheet-export.service.js';
import { resolveTimesheetPeriodRange, resolveTimesheetDateRange } from './timesheet-department-assignments.service.js';

interface IDeptGroup {
  name: string;
  ids: number[];
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
