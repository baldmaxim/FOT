/**
 * Разовая правка зафиксированного месяца под правило рабочих (timesheet-object-worker-rule.ts).
 *
 * Месяц фиксируется в ночь на 1-е тем, что расчёт поставил к этому моменту. Сентябрь 2026
 * зафиксирован до правила рабочих — у них в фиксации объект по часам, и «Единый 1С» и API 1С
 * отдают одну строку вместо разбивки по проходам. Правка приводит фиксацию к тому, что дала
 * бы фиксация с правилом:
 *   - строки рабочих, где ещё не skud/auto (объект, «Офис» по часам, NULL, ручной «По СКУД»),
 *     → skud/auto. Не трогаются личный «Офис», отдел с «Офисом» и подрядчики;
 *   - у уволенного — только строка, тронутая авторасчётом (set_by = 'auto'): строки давно
 *     уволенных расчёт никогда не трогал, правило бы их тоже не тронуло;
 *   - отдел уволенного — отдел до увольнения (employee_dismissal_events.from_department_id):
 *     по нему проверяются «Бригады», подрядчики и «Офис» отдела;
 *   - живые столбцы уволенных рабочих с объектом от авторасчёта → skud/auto: ночной расчёт
 *     уволенных не трогает.
 * Если строки фиксации изменились, objects_rebuilt_month откатывается на месяц раньше —
 * планировщик пересоберёт объектную разбивку утверждённых подач месяца.
 *
 * applyOfficeWindowToFrozenMonth — то же для «Офиса» из окна «Режим табелирования»: окно
 * действует на незафиксированные месяцы, и «Офис», поставленный после фиксации (УОК-Офис —
 * 1.10 10:51, сентябрь зафиксирован в 04:13), в прошлый месяц не попал. Правка ставит «Офис»
 * в строках фиксации всем, кто сейчас в окне: прямым сотрудникам отделов с «Офисом» —
 * current_activity/auto, личному «Офису» — current_activity без источника с автором из
 * карточки (так строку записала бы ночная фиксация).
 *
 * Одна транзакция под локом режимов (withModeSnapshot); повтор — 0 изменений. AUDIT_ACTIONS
 * читается только внутри функций: тесты с моком audit.service грузят модуль транзитивно.
 */
import type { PoolClient } from 'pg';
import { invalidateCaches } from '../middleware/cacheResponse.js';
import { AUDIT_ACTIONS, auditService } from './audit.service.js';
import { employeeCache } from './employee-cache.service.js';
import { withModeSnapshot } from './employee-timesheet-object-auto.service.js';
import {
  loadContractorDepartmentIds,
  readTimesheetObjectState,
  type TimesheetObjectSetBy,
} from './employee-timesheet-object.service.js';
import { toMonthStart, type TimesheetExportMode } from './timesheet-export-mode.service.js';
import { loadBrigadeDepartmentIds, workerSql } from './timesheet-object-worker-rule.js';
import { personalOfficeSql } from './timesheet-office-rule.js';

export class TimesheetObjectMonthFixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimesheetObjectMonthFixError';
  }
}

export interface IMonthFixRow {
  employeeId: number;
  fullName: string | null;
  employmentStatus: string;
  fromMode: TimesheetExportMode | null;
  fromObjectId: string | null;
  fromSetBy: TimesheetObjectSetBy | null;
}

export interface IMonthFixResult {
  dryRun: boolean;
  month: string;
  /** Строки фиксации месяца → skud/auto. */
  frozen: IMonthFixRow[];
  /** Живые столбцы уволенных рабочих → skud/auto. */
  live: IMonthFixRow[];
  /** Откатан objects_rebuilt_month — планировщик пересоберёт объекты подач месяца. */
  rebuildRequested: boolean;
}

interface IFixRow {
  id: number | string;
  full_name: string | null;
  employment_status: string;
  mode: TimesheetExportMode | null;
  object_id: string | null;
  set_by: TimesheetObjectSetBy | null;
}

const toFixRow = (row: IFixRow): IMonthFixRow => ({
  employeeId: Number(row.id),
  fullName: row.full_name,
  employmentStatus: row.employment_status,
  fromMode: row.mode,
  fromObjectId: row.object_id,
  fromSetBy: row.set_by,
});

/** Первое число предыдущего месяца. */
export function previousMonthStart(monthStart: string): string {
  const date = new Date(`${monthStart.slice(0, 8)}01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() - 1);
  return date.toISOString().slice(0, 10);
}

/**
 * Сотрудник с отделом для правила: у работающего — текущий, у уволенного — отдел до
 * увольнения (последнее неотменённое событие увольнения, как ветка firedFromDept табеля).
 * $1 — подрядчики, $2 — отделы «Бригад».
 */
const EMPLOYEES_WITH_RULE_DEPARTMENT_CTE = `
  ev AS (
    SELECT DISTINCT ON (de.employee_id) de.employee_id, de.from_department_id
      FROM employee_dismissal_events de
     WHERE de.cancelled = false
     ORDER BY de.employee_id, de.created_at DESC
  ),
  emp AS (
    SELECT e.id,
           e.full_name,
           e.employment_status,
           e.timesheet_export_mode,
           e.timesheet_export_object_id,
           e.timesheet_export_set_by,
           CASE WHEN e.employment_status = 'fired' THEN ev.from_department_id
                ELSE e.org_department_id END AS rule_department_id
      FROM employees e
      LEFT JOIN ev ON ev.employee_id = e.id
     WHERE e.is_archived = false
  ),
  workers AS (
    SELECT emp.*
      FROM emp
     WHERE ${workerSql('emp', '$2', 'emp.rule_department_id')}
       AND (emp.rule_department_id IS NULL OR NOT (emp.rule_department_id = ANY($1::uuid[])))
       AND NOT EXISTS (
             SELECT 1 FROM timesheet_office_departments tod
              WHERE tod.org_department_id = emp.rule_department_id
           )
  )`;

async function selectFrozenRows(client: PoolClient, month: string, contractorIds: string[], brigadeIds: string[]): Promise<IFixRow[]> {
  return (await client.query<IFixRow>(
    `WITH ${EMPLOYEES_WITH_RULE_DEPARTMENT_CTE}
     SELECT w.id, w.full_name, w.employment_status,
            f.mode, f.object_id::text AS object_id, f.set_by
       FROM workers w
       JOIN employee_timesheet_object_months f ON f.employee_id = w.id AND f.month = $3::date
      WHERE NOT (f.mode IS NOT DISTINCT FROM 'skud' AND f.set_by IS NOT DISTINCT FROM 'auto')
        -- личный «Офис» из окна «Режим табелирования» (291) в строке фиксации
        AND NOT (f.mode IS NOT DISTINCT FROM 'current_activity' AND f.object_id IS NULL
                 AND f.set_by IS NULL AND f.set_at IS NOT NULL)
        AND (w.employment_status = 'active' OR f.set_by IS NOT DISTINCT FROM 'auto')
      ORDER BY w.id`,
    [contractorIds, brigadeIds, month],
  )).rows;
}

async function selectLiveFiredRows(client: PoolClient, contractorIds: string[], brigadeIds: string[]): Promise<IFixRow[]> {
  return (await client.query<IFixRow>(
    `WITH ${EMPLOYEES_WITH_RULE_DEPARTMENT_CTE}
     SELECT w.id, w.full_name, w.employment_status,
            w.timesheet_export_mode AS mode,
            w.timesheet_export_object_id::text AS object_id,
            w.timesheet_export_set_by AS set_by
       FROM workers w
      WHERE w.employment_status = 'fired'
        AND w.timesheet_export_set_by IS NOT DISTINCT FROM 'auto'
        AND w.timesheet_export_mode IN ('object', 'current_activity')
      ORDER BY w.id`,
    [contractorIds, brigadeIds],
  )).rows;
}

/** Правка месяца month (любой день или YYYY-MM). dryRun — только отчёт. */
export async function fixWorkersFrozenMonth(options: { month: string; dryRun: boolean }): Promise<IMonthFixResult> {
  const month = toMonthStart(options.month);
  if (!month) throw new TimesheetObjectMonthFixError(`Некорректный месяц: ${options.month}`);

  const result = await withModeSnapshot(async client => {
    const state = await readTimesheetObjectState(client, true);
    if (!state) throw new TimesheetObjectMonthFixError('Нет состояния timesheet_object_auto_state — примените миграцию 288');
    if (!state.enabled) throw new TimesheetObjectMonthFixError('Расчёт объекта табелирования выключен');
    if (state.frozen_month < month) {
      throw new TimesheetObjectMonthFixError(`Месяц ${month} ещё не зафиксирован — его зафиксирует ночь уже по правилу рабочих`);
    }
    if (month <= state.baseline_month) {
      throw new TimesheetObjectMonthFixError(`Месяц ${month} не позже базового (${state.baseline_month}) — правка не нужна`);
    }

    const contractorIds = await loadContractorDepartmentIds(client);
    const brigadeIds = await loadBrigadeDepartmentIds(client);
    const frozenRows = await selectFrozenRows(client, month, contractorIds, brigadeIds);
    const liveRows = await selectLiveFiredRows(client, contractorIds, brigadeIds);
    if (options.dryRun) {
      return {
        dryRun: true, month, frozen: frozenRows.map(toFixRow), live: liveRows.map(toFixRow), rebuildRequested: false,
      } satisfies IMonthFixResult;
    }

    // Условия выборки повторены в UPDATE: правка ровно тех строк, что в отчёте.
    const frozenIds = frozenRows.map(row => Number(row.id));
    const frozenApplied = frozenIds.length > 0
      ? new Set((await client.query<{ employee_id: number | string }>(
        `UPDATE employee_timesheet_object_months f
            SET mode = 'skud', object_id = NULL, set_by = 'auto', set_by_user_id = NULL, set_at = NULL
          WHERE f.month = $1::date
            AND f.employee_id = ANY($2::int[])
            AND NOT (f.mode IS NOT DISTINCT FROM 'skud' AND f.set_by IS NOT DISTINCT FROM 'auto')
          RETURNING f.employee_id`,
        [month, frozenIds],
      )).rows.map(row => Number(row.employee_id)))
      : new Set<number>();

    const liveIds = liveRows.map(row => Number(row.id));
    const liveApplied = liveIds.length > 0
      ? new Set((await client.query<{ id: number | string }>(
        `UPDATE employees e
            SET timesheet_export_mode = 'skud',
                timesheet_export_object_id = NULL,
                timesheet_export_set_by = 'auto',
                updated_at = now()
          WHERE e.id = ANY($1::int[])
            AND e.employment_status = 'fired'
            AND e.timesheet_export_set_by IS NOT DISTINCT FROM 'auto'
            AND e.timesheet_export_mode IN ('object', 'current_activity')
          RETURNING e.id`,
        [liveIds],
      )).rows.map(row => Number(row.id)))
      : new Set<number>();

    const frozen = frozenRows.map(toFixRow).filter(row => frozenApplied.has(row.employeeId));
    const live = liveRows.map(toFixRow).filter(row => liveApplied.has(row.employeeId));
    if (frozen.length > 0 || live.length > 0) {
      await auditService.logWithClient(client, {
        user_id: null,
        action: AUDIT_ACTIONS.TIMESHEET_OBJECT_AUTO_ASSIGNED,
        entity_type: 'timesheet_object_month',
        entity_id: `workers:${month}`,
        details: {
          reason: 'workers_skud',
          month,
          frozen_changed: frozen.length,
          live_changed: live.length,
          frozen: frozen.map(row => ({
            id: row.employeeId, name: row.fullName, status: row.employmentStatus,
            from_mode: row.fromMode, from_object_id: row.fromObjectId, from_set_by: row.fromSetBy, to_mode: 'skud',
          })),
          live: live.map(row => ({
            id: row.employeeId, name: row.fullName,
            from_mode: row.fromMode, from_object_id: row.fromObjectId, from_set_by: row.fromSetBy, to_mode: 'skud',
          })),
        },
      });
    }

    // Пересборка объектов подач — только если фиксация реально изменилась.
    const rebuildRequested = frozen.length > 0;
    if (rebuildRequested) {
      await client.query(
        `UPDATE timesheet_object_auto_state
            SET objects_rebuilt_month = LEAST(objects_rebuilt_month, $1::date), updated_at = now()
          WHERE singleton`,
        [previousMonthStart(month)],
      );
    }
    return { dryRun: false, month, frozen, live, rebuildRequested } satisfies IMonthFixResult;
  });

  if (!result.dryRun && (result.frozen.length > 0 || result.live.length > 0)) {
    employeeCache.clear();
    invalidateCaches('timesheet', 'timesheet:today', 'timesheet:overview', 'timesheet:overview:today', 'timesheet:search');
  }
  return result;
}

// ── «Офис» из окна «Режим табелирования» в зафиксированном месяце ───────────────────────

export interface IOfficeMonthRow extends IMonthFixRow {
  /** department — «Офис» отдела, personal — личный «Офис» из окна. */
  via: 'department' | 'personal';
  departmentName: string | null;
}

export interface IOfficeMonthResult {
  dryRun: boolean;
  month: string;
  rows: IOfficeMonthRow[];
  /** Откатан objects_rebuilt_month — планировщик пересоберёт объекты подач месяца. */
  rebuildRequested: boolean;
}

interface IOfficeFixRow extends IFixRow {
  via: 'department' | 'personal';
  department_name: string | null;
}

/** Уже «Офис» в строке фиксации — от отдела, ночи или личный. */
const FROZEN_IS_OFFICE_SQL = "(f.mode IS NOT DISTINCT FROM 'current_activity' AND f.object_id IS NULL)";

/**
 * Кто сейчас в окне и у кого в фиксации месяца не «Офис». Отдел с «Офисом» — прямые
 * работающие не архивные сотрудники, кроме подрядчиков (как enforceOfficeForDepartments);
 * отдел главнее личного. $1 — месяц, $2 — подрядчики.
 */
async function selectOfficeWindowRows(client: PoolClient, month: string, contractorIds: string[]): Promise<IOfficeFixRow[]> {
  return (await client.query<IOfficeFixRow>(
    `SELECT e.id, e.full_name, e.employment_status,
            f.mode, f.object_id::text AS object_id, f.set_by,
            CASE WHEN tod.org_department_id IS NOT NULL THEN 'department' ELSE 'personal' END AS via,
            d.name AS department_name
       FROM employees e
       JOIN employee_timesheet_object_months f ON f.employee_id = e.id AND f.month = $1::date
       LEFT JOIN timesheet_office_departments tod ON tod.org_department_id = e.org_department_id
       LEFT JOIN org_departments d ON d.id = e.org_department_id
      WHERE e.is_archived = false
        AND e.employment_status = 'active'
        AND (e.org_department_id IS NULL OR NOT (e.org_department_id = ANY($2::uuid[])))
        AND (tod.org_department_id IS NOT NULL OR ${personalOfficeSql('e')})
        AND NOT ${FROZEN_IS_OFFICE_SQL}
      ORDER BY e.id`,
    [month, contractorIds],
  )).rows;
}

/** «Офис» окна в строках фиксации месяца month (любой день или YYYY-MM). dryRun — только отчёт. */
export async function applyOfficeWindowToFrozenMonth(options: { month: string; dryRun: boolean }): Promise<IOfficeMonthResult> {
  const month = toMonthStart(options.month);
  if (!month) throw new TimesheetObjectMonthFixError(`Некорректный месяц: ${options.month}`);

  const result = await withModeSnapshot(async client => {
    const state = await readTimesheetObjectState(client, true);
    if (!state) throw new TimesheetObjectMonthFixError('Нет состояния timesheet_object_auto_state — примените миграцию 288');
    if (!state.enabled) throw new TimesheetObjectMonthFixError('Расчёт объекта табелирования выключен');
    if (state.frozen_month < month) {
      throw new TimesheetObjectMonthFixError(`Месяц ${month} ещё не зафиксирован — «Офис» окна ему поставит ночная фиксация`);
    }
    if (month <= state.baseline_month) {
      throw new TimesheetObjectMonthFixError(`Месяц ${month} не позже базового (${state.baseline_month}) — правка не нужна`);
    }

    const contractorIds = await loadContractorDepartmentIds(client);
    const candidates = await selectOfficeWindowRows(client, month, contractorIds);
    const toRow = (row: IOfficeFixRow): IOfficeMonthRow => ({ ...toFixRow(row), via: row.via, departmentName: row.department_name });
    if (options.dryRun) {
      return { dryRun: true, month, rows: candidates.map(toRow), rebuildRequested: false } satisfies IOfficeMonthResult;
    }

    // Условия выборки повторены в UPDATE: правка ровно тех строк, что в отчёте.
    const departmentIds = candidates.filter(row => row.via === 'department').map(row => Number(row.id));
    const personalIds = candidates.filter(row => row.via === 'personal').map(row => Number(row.id));
    const applied = new Set<number>();
    if (departmentIds.length > 0) {
      const rows = (await client.query<{ employee_id: number | string }>(
        `UPDATE employee_timesheet_object_months f
            SET mode = 'current_activity', object_id = NULL, set_by = 'auto', set_by_user_id = NULL, set_at = NULL
          WHERE f.month = $1::date
            AND f.employee_id = ANY($2::int[])
            AND NOT ${FROZEN_IS_OFFICE_SQL}
          RETURNING f.employee_id`,
        [month, departmentIds],
      )).rows;
      for (const row of rows) applied.add(Number(row.employee_id));
    }
    if (personalIds.length > 0) {
      // Личный «Офис» — как его записала бы ночная фиксация: без источника, с автором из карточки.
      const rows = (await client.query<{ employee_id: number | string }>(
        `UPDATE employee_timesheet_object_months f
            SET mode = 'current_activity', object_id = NULL, set_by = NULL,
                set_by_user_id = e.timesheet_export_set_by_user_id, set_at = e.timesheet_export_set_at
           FROM employees e
          WHERE e.id = f.employee_id
            AND f.month = $1::date
            AND f.employee_id = ANY($2::int[])
            AND ${personalOfficeSql('e')}
            AND NOT ${FROZEN_IS_OFFICE_SQL}
          RETURNING f.employee_id`,
        [month, personalIds],
      )).rows;
      for (const row of rows) applied.add(Number(row.employee_id));
    }

    const rows = candidates.map(toRow).filter(row => applied.has(row.employeeId));
    if (rows.length > 0) {
      await auditService.logWithClient(client, {
        user_id: null,
        action: AUDIT_ACTIONS.TIMESHEET_OBJECT_AUTO_ASSIGNED,
        entity_type: 'timesheet_object_month',
        entity_id: `office:${month}`,
        details: {
          reason: 'office_window_month',
          month,
          changed: rows.length,
          changes: rows.map(row => ({
            id: row.employeeId, name: row.fullName, via: row.via, department: row.departmentName,
            from_mode: row.fromMode, from_object_id: row.fromObjectId, from_set_by: row.fromSetBy,
            to_mode: 'current_activity',
          })),
        },
      });
      // Объекты подач пересоберёт планировщик — только если фиксация реально изменилась.
      await client.query(
        `UPDATE timesheet_object_auto_state
            SET objects_rebuilt_month = LEAST(objects_rebuilt_month, $1::date), updated_at = now()
          WHERE singleton`,
        [previousMonthStart(month)],
      );
    }
    return { dryRun: false, month, rows, rebuildRequested: rows.length > 0 } satisfies IOfficeMonthResult;
  });

  if (!result.dryRun && result.rows.length > 0) {
    employeeCache.clear();
    invalidateCaches('timesheet', 'timesheet:today', 'timesheet:overview', 'timesheet:overview:today', 'timesheet:search');
  }
  return result;
}
