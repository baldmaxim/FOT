/**
 * Режим табелирования сотрудника для выгрузки «Единый файл для 1С» (миграция 249).
 *
 * Три режима:
 *   current_activity — одна строка, «Адрес объекта» = «Текущая деятельность»;
 *   object           — одна строка, адрес = закреплённый объект (независимо от проходов);
 *   skud             — разбивка по фактическим СКУД-проходам (несколько строк на человека).
 *
 * Приоритет источников:
 *   1) employees.timesheet_export_mode         → employee_explicit
 *   2) org_departments.timesheet_export_mode   → department_explicit
 *   3) legacy-фолбэк по назначениям объектов   → legacy_employee | legacy_department | legacy_default
 *
 * Legacy-ветка дословно повторяет прежнюю логику buildRowsForDepartment: если у сотрудника
 * есть ХОТЬ ОДНО активное employee_object_assignment — смотрим только персональные объекты
 * (обычный персональный объект тем самым ВЫКЛЮЧАЕТ «текущую деятельность» отдела); иначе
 * смотрим объекты его непосредственного отдела. Благодаря этому миграция не меняет поведение
 * ни одного сотрудника до явной настройки режима.
 */
import { query } from '../config/postgres.js';

export type TimesheetExportMode = 'current_activity' | 'object' | 'skud';

export type TimesheetExportModeSource =
  | 'employee_explicit'
  | 'department_explicit'
  | 'legacy_employee'
  | 'legacy_department'
  | 'legacy_default';

export interface IResolvedExportMode {
  mode: TimesheetExportMode;
  /** Закреплённый объект — только для mode = 'object', иначе null. */
  pinnedObjectId: string | null;
  source: TimesheetExportModeSource;
}

export const TIMESHEET_EXPORT_MODES: readonly TimesheetExportMode[] = [
  'current_activity',
  'object',
  'skud',
] as const;

export const isTimesheetExportMode = (value: unknown): value is TimesheetExportMode =>
  typeof value === 'string' && (TIMESHEET_EXPORT_MODES as readonly string[]).includes(value);

/** Адрес объектов режима «текущая деятельность» — он же признак legacy-режима. */
export const CURRENT_ACTIVITY_ADDRESS = 'Текущая деятельность';

/**
 * Ключ advisory-локи для записи режимов. Один и тот же берут PUT-эндпоинты и
 * настроечный скрипт — иначе они не увидят друг друга (advisory lock защищает
 * только от процессов, берущих тот же ключ).
 */
export const TIMESHEET_MODE_LOCK_KEY = 249_0001;

interface IModeRow {
  employee_id: number | string;
  emp_mode: TimesheetExportMode | null;
  emp_object_id: string | null;
  dept_mode: TimesheetExportMode | null;
  dept_object_id: string | null;
  has_personal_assignment: boolean | null;
  personal_current_activity: boolean | null;
  dept_current_activity: boolean | null;
}

/**
 * Режимы для списка сотрудников. Один запрос: явные режимы сотрудника и его отдела
 * плюс legacy-признаки по назначениям объектов.
 */
export async function resolveExportModes(
  employeeIds: number[],
): Promise<Map<number, IResolvedExportMode>> {
  const result = new Map<number, IResolvedExportMode>();
  const ids = [...new Set(employeeIds.filter(id => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return result;

  const rows = await query<IModeRow>(
    `WITH ca AS (
       SELECT id FROM skud_objects
        WHERE lower(btrim(coalesce(alt_name, ''))) = lower($2::text)
     ),
     personal AS (
       SELECT eoa.employee_id,
              bool_or(eoa.skud_object_id IN (SELECT id FROM ca)) AS is_current
         FROM employee_object_assignment eoa
        WHERE eoa.is_active = true AND eoa.employee_id = ANY($1::int[])
        GROUP BY eoa.employee_id
     ),
     dept_ca AS (
       SELECT DISTINCT doa.org_department_id
         FROM department_object_assignment doa
        WHERE doa.is_active = true AND doa.skud_object_id IN (SELECT id FROM ca)
     )
     SELECT e.id                                AS employee_id,
            e.timesheet_export_mode             AS emp_mode,
            e.timesheet_export_object_id::text  AS emp_object_id,
            d.timesheet_export_mode             AS dept_mode,
            d.timesheet_export_object_id::text  AS dept_object_id,
            (p.employee_id IS NOT NULL)         AS has_personal_assignment,
            COALESCE(p.is_current, false)       AS personal_current_activity,
            (dc.org_department_id IS NOT NULL)  AS dept_current_activity
       FROM employees e
       LEFT JOIN org_departments d ON d.id = e.org_department_id
       LEFT JOIN personal p        ON p.employee_id = e.id
       LEFT JOIN dept_ca dc        ON dc.org_department_id = e.org_department_id
      WHERE e.id = ANY($1::int[])`,
    [ids, CURRENT_ACTIVITY_ADDRESS],
  );

  for (const row of rows) {
    const id = Number(row.employee_id);
    if (!Number.isInteger(id)) continue;
    result.set(id, resolveRow(row));
  }
  return result;
}

/** Резолвинг одной строки — вынесен ради тестов и переиспользования в API. */
export function resolveRow(row: IModeRow): IResolvedExportMode {
  if (row.emp_mode) {
    return {
      mode: row.emp_mode,
      pinnedObjectId: row.emp_mode === 'object' ? row.emp_object_id : null,
      source: 'employee_explicit',
    };
  }
  if (row.dept_mode) {
    return {
      mode: row.dept_mode,
      pinnedObjectId: row.dept_mode === 'object' ? row.dept_object_id : null,
      source: 'department_explicit',
    };
  }
  // Legacy: персональные назначения полностью перекрывают отдел.
  if (row.has_personal_assignment) {
    return {
      mode: row.personal_current_activity ? 'current_activity' : 'skud',
      pinnedObjectId: null,
      source: 'legacy_employee',
    };
  }
  if (row.dept_current_activity) {
    return { mode: 'current_activity', pinnedObjectId: null, source: 'legacy_department' };
  }
  return { mode: 'skud', pinnedObjectId: null, source: 'legacy_default' };
}

/** Режим по умолчанию для сотрудника, которого нет в карте (страховка). */
export const DEFAULT_EXPORT_MODE: IResolvedExportMode = {
  mode: 'skud',
  pinnedObjectId: null,
  source: 'legacy_default',
};
