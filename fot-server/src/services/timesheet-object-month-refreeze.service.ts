/**
 * Пересчёт фиксации уже зафиксированного месяца для одного отдела (миграция 288).
 *
 * Повод: отдел стоял в «Режиме табелирования» с «Офисом» (291), и месяц зафиксировался
 * «Офисом»; правило сняли позже — ночь текущий месяц пересчитывает, а зафиксированный
 * больше не трогает. Здесь фиксация месяца ставится по тому же правилу, что дала бы
 * ночная фиксация без «Офиса» отдела: объект с наибольшими часами за весь месяц (офисы —
 * суммой, как «Офис»), нет часов — фиксация прежняя, назначение из окна (личный «Офис» или
 * объект) не трогается. Рабочим
 * (timesheet-object-worker-rule.ts) — «По СКУД» (skud/auto) независимо от часов, как ночью.
 *
 * Одна транзакция под локом режимов (TIMESHEET_MODE_LOCK_KEY — его же берут ночь и окно):
 * строки фиксации FOR UPDATE, часы, запись и аудит. Редакции подач пересобирает
 * вызывающий после COMMIT (rebuildVersionObjectsForMonth с фильтром по сотрудникам).
 * Повтор — no-op.
 */
import type { PoolClient } from 'pg';
import { withTransaction } from '../config/postgres.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import { AUDIT_ACTIONS, auditService } from './audit.service.js';
import { targetFromTop } from './employee-timesheet-object-auto.service.js';
import {
  loadContractorDepartmentIds,
  loadSkudObjects,
  loadTimesheetObjectHours,
  monthEnd,
  readTimesheetObjectState,
  type ITimesheetObjectHours,
  type TimesheetObjectSetBy,
} from './employee-timesheet-object.service.js';
import {
  TIMESHEET_MODE_LOCK_KEY,
  currentMonthStartMsk,
  frozenPersonalPinSql,
  toMonthStart,
  type TimesheetExportMode,
} from './timesheet-export-mode.service.js';
import { WORKER_SKUD_LABEL, loadBrigadeDepartmentIds, workerSql } from './timesheet-object-worker-rule.js';

export class MonthRefreezeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MonthRefreezeError';
  }
}

export interface IFrozenMonthRow {
  employee_id: number;
  full_name: string | null;
  mode: TimesheetExportMode | null;
  object_id: string | null;
  set_by: TimesheetObjectSetBy | null;
  /** Назначение из окна «Режим табелирования» (личный «Офис» или объект), попавшее в фиксацию. */
  personal_pin: boolean;
  /** Рабочий: фиксация — skud, а не объект по часам. */
  worker?: boolean;
}

export interface IRefreezeChange {
  employeeId: number;
  fullName: string | null;
  fromMode: TimesheetExportMode | null;
  fromObjectId: string | null;
  fromSetBy: TimesheetObjectSetBy | null;
  toMode: 'current_activity' | 'object' | 'skud';
  toObjectId: string | null;
  label: string;
  hours: number;
}

/**
 * Изменения фиксации: цель — объект с наибольшими часами, у рабочего — skud. Личный
 * «Офис», нет часов, цель совпала при источнике auto — не изменение.
 */
export function planMonthRefreeze(
  rows: readonly IFrozenMonthRow[],
  topsByEmployee: ReadonlyMap<number, ITimesheetObjectHours[]>,
): IRefreezeChange[] {
  const changes: IRefreezeChange[] = [];
  for (const row of rows) {
    if (row.personal_pin) continue;
    if (row.worker) {
      if (row.mode === 'skud' && row.set_by === 'auto') continue;
      changes.push({
        employeeId: row.employee_id,
        fullName: row.full_name,
        fromMode: row.mode,
        fromObjectId: row.object_id,
        fromSetBy: row.set_by,
        toMode: 'skud',
        toObjectId: null,
        label: WORKER_SKUD_LABEL,
        hours: 0,
      });
      continue;
    }
    const top = topsByEmployee.get(row.employee_id)?.[0];
    if (!top) continue;
    const target = targetFromTop(top);
    const sameMode = row.mode === target.mode && (row.object_id ?? null) === target.objectId;
    if (sameMode && row.set_by === 'auto') continue;
    changes.push({
      employeeId: row.employee_id,
      fullName: row.full_name,
      fromMode: row.mode,
      fromObjectId: row.object_id,
      fromSetBy: row.set_by,
      toMode: target.mode,
      toObjectId: target.objectId,
      label: top.label,
      hours: top.hours,
    });
  }
  return changes;
}

export interface IRefreezeResult {
  dryRun: boolean;
  month: string;
  departmentName: string;
  /** Сотрудники отдела (не архивные) со строкой фиксации месяца. */
  employees: number;
  /** Их id — для пересборки подач (повтор дочиняет и упавшую пересборку). */
  employeeIds: number[];
  withHours: number;
  /** Назначенные в окне — не трогаются. */
  personalPin: number;
  /** Сотрудники отдела без строки фиксации месяца — не трогаются. */
  withoutFreezeRow: Array<{ id: number; fullName: string | null }>;
  changes: IRefreezeChange[];
  /** Изменённые в БД (при dryRun — пусто). */
  appliedIds: number[];
}

async function loadDepartmentFreezeRows(
  client: PoolClient,
  month: string,
  departmentId: string,
): Promise<{ rows: IFrozenMonthRow[]; withoutFreezeRow: Array<{ id: number; fullName: string | null }> }> {
  const brigadeIds = await loadBrigadeDepartmentIds(client);
  const employees = (await client.query<{ id: number | string; full_name: string | null; worker: boolean }>(
    `SELECT e.id, e.full_name, ${workerSql('e', '$2')} AS worker
       FROM employees e
      WHERE e.org_department_id = $1::uuid
        AND e.is_archived = false
      ORDER BY e.id`,
    [departmentId, brigadeIds],
  )).rows.map(row => ({ id: Number(row.id), fullName: row.full_name, worker: row.worker === true }));
  if (employees.length === 0) return { rows: [], withoutFreezeRow: [] };

  // Строки фиксации — FOR UPDATE по возрастанию id (у LEFT JOIN nullable-сторону не заблокировать).
  const frozen = (await client.query<{
    employee_id: number | string;
    mode: TimesheetExportMode | null;
    object_id: string | null;
    set_by: TimesheetObjectSetBy | null;
    personal_pin: boolean;
  }>(
    `SELECT f.employee_id,
            f.mode,
            f.object_id::text AS object_id,
            f.set_by,
            ${frozenPersonalPinSql('f')} AS personal_pin
       FROM employee_timesheet_object_months f
      WHERE f.month = $1::date
        AND f.employee_id = ANY($2::int[])
      ORDER BY f.employee_id
      FOR UPDATE`,
    [month, employees.map(employee => employee.id)],
  )).rows;
  const frozenById = new Map(frozen.map(row => [Number(row.employee_id), row]));

  const rows: IFrozenMonthRow[] = [];
  const withoutFreezeRow: Array<{ id: number; fullName: string | null }> = [];
  for (const employee of employees) {
    const row = frozenById.get(employee.id);
    if (!row) {
      withoutFreezeRow.push(employee);
      continue;
    }
    rows.push({
      employee_id: employee.id,
      full_name: employee.fullName,
      mode: row.mode,
      object_id: row.object_id,
      set_by: row.set_by,
      personal_pin: row.personal_pin,
      worker: employee.worker,
    });
  }
  return { rows, withoutFreezeRow };
}

/** Запись; условие личного «Офиса» — ещё раз в самом UPDATE. */
async function applyRefreeze(client: PoolClient, month: string, changes: readonly IRefreezeChange[]): Promise<number[]> {
  if (changes.length === 0) return [];
  const rows = (await client.query<{ employee_id: number | string }>(
    `UPDATE employee_timesheet_object_months f
        SET mode = c.mode,
            object_id = c.object_id,
            set_by = 'auto',
            set_by_user_id = NULL,
            set_at = NULL,
            frozen_at = now()
       FROM unnest($2::int[], $3::text[], $4::uuid[]) AS c(id, mode, object_id)
      WHERE f.employee_id = c.id
        AND f.month = $1::date
        AND NOT ${frozenPersonalPinSql('f')}
      RETURNING f.employee_id`,
    [
      month,
      changes.map(change => change.employeeId),
      changes.map(change => change.toMode),
      changes.map(change => change.toObjectId),
    ],
  )).rows;
  return rows.map(row => Number(row.employee_id));
}

/**
 * Пересчёт фиксации месяца month (любой день или YYYY-MM) для прямых не архивных
 * сотрудников отдела. dryRun — только отчёт.
 */
export async function refreezeDepartmentMonth(options: {
  month: string;
  departmentId: string;
  dryRun: boolean;
  now?: Date;
}): Promise<IRefreezeResult> {
  const now = options.now ?? new Date();
  const month = toMonthStart(options.month);
  if (!month) throw new MonthRefreezeError(`Некорректный месяц: ${options.month}`);
  if (month >= currentMonthStartMsk(now)) {
    throw new MonthRefreezeError(`Месяц ${month} ещё не закончился — пересчитывать нечего, это делает ночь`);
  }
  const period = { start: month, end: monthEnd(month) };

  return withTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [TIMESHEET_MODE_LOCK_KEY]);

    const state = await readTimesheetObjectState(client, true);
    if (!state) throw new MonthRefreezeError('Нет состояния timesheet_object_auto_state — миграция 288 не применена');
    if (state.frozen_month < month) {
      throw new MonthRefreezeError(`Месяц ${month} ещё не зафиксирован (frozen_month ${state.frozen_month}) — его зафиксирует ночь`);
    }

    const department = (await client.query<{ name: string; office: boolean }>(
      `SELECT d.name,
              EXISTS (SELECT 1 FROM timesheet_office_departments tod WHERE tod.org_department_id = d.id) AS office
         FROM org_departments d
        WHERE d.id = $1::uuid`,
      [options.departmentId],
    )).rows[0];
    if (!department) throw new MonthRefreezeError(`Отдел ${options.departmentId} не найден`);
    if (department.office) {
      throw new MonthRefreezeError(`У отдела «${department.name}» стоит «Офис» в «Режиме табелирования» — сначала снимите его`);
    }
    if ((await loadContractorDepartmentIds(client)).includes(options.departmentId)) {
      throw new MonthRefreezeError(`Отдел «${department.name}» — подрядный, объект табелирования у него не считается`);
    }

    const { rows, withoutFreezeRow } = await loadDepartmentFreezeRows(client, month, options.departmentId);
    const objectsById = await loadSkudObjects(client);
    const tops = await loadTimesheetObjectHours(
      rows.map(row => row.employee_id),
      period,
      { todayStr: moscowTodayIso(now), exec: client, objectsById },
    );
    const changes = planMonthRefreeze(rows, tops);
    const result: IRefreezeResult = {
      dryRun: options.dryRun,
      month,
      departmentName: department.name,
      employees: rows.length,
      employeeIds: rows.map(row => row.employee_id),
      withHours: rows.filter(row => (tops.get(row.employee_id)?.length ?? 0) > 0).length,
      personalPin: rows.filter(row => row.personal_pin).length,
      withoutFreezeRow,
      changes,
      appliedIds: [],
    };
    if (options.dryRun || changes.length === 0) return result;

    const appliedIds = await applyRefreeze(client, month, changes);
    if (appliedIds.length > 0) {
      const applied = new Set(appliedIds);
      await auditService.logWithClient(client, {
        user_id: null,
        action: AUDIT_ACTIONS.TIMESHEET_OBJECT_AUTO_ASSIGNED,
        entity_type: 'timesheet_object_month',
        entity_id: `refreeze:${month}:${options.departmentId}`,
        details: {
          reason: 'month_refreeze',
          month,
          period,
          department_id: options.departmentId,
          department_name: department.name,
          changed: applied.size,
          changes: changes
            .filter(change => applied.has(change.employeeId))
            .map(change => ({
              id: change.employeeId,
              name: change.fullName,
              from_mode: change.fromMode,
              from_object_id: change.fromObjectId,
              from_set_by: change.fromSetBy,
              to_mode: change.toMode,
              to_object_id: change.toObjectId,
              label: change.label,
              hours: change.hours,
            })),
        },
      });
    }
    return { ...result, appliedIds };
  });
}
