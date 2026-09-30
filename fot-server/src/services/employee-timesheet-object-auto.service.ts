/**
 * Авторасчёт объекта табелирования и фиксация месяцев (миграция 288).
 *
 * Объект = где у своего сотрудника больше всего часов с 1-го числа месяца (офисы —
 * суммой, как «Офис»). Пересчитываются только авто-объекты и сотрудники без личного
 * режима; выбор сотрудника ('employee'), ведущего табель ('manager') и ручной режим
 * админа (set_by = NULL) ночь не трогает. С all = true (первый запуск) пересчитываются
 * и ручные админские — кроме личного «Офиса» из окна «Режим табелирования» (миграция 291).
 *
 * Сотрудники отделов с «Офисом» (291) в расчёт по часам не идут: им правило отдела ставит
 * «Офис» при любом источнике — одинаково в пересчёте, фиксации месяца и активации.
 *
 * Все операции — под session-локом TIMESHEET_MODE_LOCK_KEY (его же берёт выбор объекта
 * в ЛК и табеле), в одной транзакции REPEATABLE READ: часы, режимы,
 * объекты и состояние читаются одним снимком, запись, аудит и состояние — там же.
 * Кэши сбрасываются только после COMMIT; повтор после отката аудит не дублирует.
 */
import type { PoolClient } from 'pg';
import { pool } from '../config/postgres.js';
import { invalidateCaches } from '../middleware/cacheResponse.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import { AUDIT_ACTIONS, auditService } from './audit.service.js';
import { employeeCache } from './employee-cache.service.js';
import { isRetryableDbError } from './timesheet-snapshot-tx.js';
import {
  TIMESHEET_MODE_LOCK_KEY,
  currentMonthStartMsk,
  nextMonthStart,
  type TimesheetExportMode,
} from './timesheet-export-mode.service.js';
import {
  OFFICE_VALUE,
  loadContractorDepartmentIds,
  loadSkudObjects,
  loadTimesheetObjectHours,
  monthEnd,
  previousMonthStartMsk,
  readTimesheetObjectState,
  type ITimesheetObjectAutoState,
  type ITimesheetObjectHours,
  type TimesheetObjectSetBy,
} from './employee-timesheet-object.service.js';
import {
  enforceOfficeForDepartments,
  officeRuleAuditEntries,
  personalOfficeSql,
  writeOfficeAudit,
} from './timesheet-office-rule.js';

const MAX_ATTEMPTS = 3;

export interface IEmployeeModeRow {
  id: number;
  full_name: string | null;
  mode: TimesheetExportMode | null;
  object_id: string | null;
  set_by: TimesheetObjectSetBy | null;
  /** Отдел сотрудника с «Офисом» (291): объект ставит правило отдела, не часы. */
  office_department: boolean;
  /** Личный «Офис» из окна «Режим табелирования» (291). */
  personal_office: boolean;
}

export interface IAutoChange {
  employeeId: number;
  fullName: string | null;
  fromMode: TimesheetExportMode | null;
  fromObjectId: string | null;
  fromSetBy: TimesheetObjectSetBy | null;
  toMode: 'current_activity' | 'object';
  toObjectId: string | null;
  label: string;
  hours: number;
}

/**
 * Трогает ли ночной расчёт строку. Выбор сотрудника и ведущего табель и личный «Офис»
 * из окна — никогда; авто и «ничего не задано» — всегда; ручной режим админа — только с all.
 */
export function isAutoCandidate(
  row: Pick<IEmployeeModeRow, 'mode' | 'set_by'> & { personal_office?: boolean },
  all: boolean,
): boolean {
  if (row.personal_office) return false;
  if (row.set_by === 'employee' || row.set_by === 'manager') return false;
  if (row.set_by === 'auto') return true;
  if (row.mode === null) return true;
  return all;
}

/** Цель по объекту с максимумом часов. */
export function targetFromTop(top: ITimesheetObjectHours): { mode: 'current_activity' | 'object'; objectId: string | null } {
  return top.value === OFFICE_VALUE
    ? { mode: 'current_activity', objectId: null }
    : { mode: 'object', objectId: top.objectId };
}

/**
 * Изменения ночного расчёта. Нет часов — объект прежний. Строка без изменений режима,
 * объекта и источника — не изменение (повтор — no-op). Сотрудников отделов с «Офисом»
 * здесь нет — их ведёт enforceOfficeForDepartments.
 */
export function planAutoChanges(
  rows: readonly IEmployeeModeRow[],
  topsByEmployee: ReadonlyMap<number, ITimesheetObjectHours[]>,
  all: boolean,
): IAutoChange[] {
  const changes: IAutoChange[] = [];
  for (const row of rows) {
    if (row.office_department || !isAutoCandidate(row, all)) continue;
    const top = topsByEmployee.get(row.id)?.[0];
    if (!top) continue;
    const target = targetFromTop(top);
    const sameMode = row.mode === target.mode && (row.object_id ?? null) === target.objectId;
    if (sameMode && row.set_by === 'auto') continue;
    changes.push({
      employeeId: row.id,
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

/** Отчёт переходов для скрипта активации. */
export interface IAutoReport {
  employees: number;
  withHours: number;
  changed: number;
  toOffice: number;
  toObject: number;
  fromNone: number;
  fromSkud: number;
  fromAdminObject: number;
  fromAdminOffice: number;
  fromAuto: number;
  unchanged: number;
  skippedManual: number;
  /** Сотрудники отделов с «Офисом»: объект ставит правило отдела (291). */
  officeDepartment: number;
}

export function summarizeAutoChanges(
  rows: readonly IEmployeeModeRow[],
  topsByEmployee: ReadonlyMap<number, ITimesheetObjectHours[]>,
  changes: readonly IAutoChange[],
  all: boolean,
): IAutoReport {
  const report: IAutoReport = {
    employees: rows.length,
    withHours: rows.filter(row => (topsByEmployee.get(row.id)?.length ?? 0) > 0).length,
    changed: changes.length,
    toOffice: changes.filter(change => change.toMode === 'current_activity').length,
    toObject: changes.filter(change => change.toMode === 'object').length,
    fromNone: 0,
    fromSkud: 0,
    fromAdminObject: 0,
    fromAdminOffice: 0,
    fromAuto: 0,
    unchanged: 0,
    skippedManual: rows.filter(row => !row.office_department && !isAutoCandidate(row, all)).length,
    officeDepartment: rows.filter(row => row.office_department).length,
  };
  for (const change of changes) {
    if (change.fromSetBy === 'auto') report.fromAuto += 1;
    else if (change.fromMode === null) report.fromNone += 1;
    else if (change.fromMode === 'skud') report.fromSkud += 1;
    else if (change.fromMode === 'object') report.fromAdminObject += 1;
    else report.fromAdminOffice += 1;
  }
  // Кандидаты, у которых объект остаётся (нет часов или цель совпала); вместе с изменёнными,
  // нетронутыми и отделами с «Офисом» — все сотрудники.
  report.unchanged = report.employees - report.changed - report.skippedManual - report.officeDepartment;
  return report;
}

/**
 * Session-лок режимов → BEGIN REPEATABLE READ → fn → COMMIT; лок снимается до
 * возврата соединения в пул. Лок берётся ДО снимка: иначе транзакция не увидела бы
 * правку, которую ждала на локе. 40001/40P01 — повтор целиком.
 */
async function withModeSnapshot<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const client = await pool().connect();
    let locked = false;
    try {
      await client.query('SELECT pg_advisory_lock($1::bigint)', [TIMESHEET_MODE_LOCK_KEY]);
      locked = true;
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      try {
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // соединение сломано — уйдёт из пула ниже
        }
        throw err;
      }
    } catch (err) {
      lastError = err;
      if (!isRetryableDbError(err) || attempt === MAX_ATTEMPTS) throw err;
      console.warn(`[timesheet-object] повтор ${attempt}/${MAX_ATTEMPTS - 1}`);
    } finally {
      let released = true;
      if (locked) {
        try {
          await client.query('SELECT pg_advisory_unlock($1::bigint)', [TIMESHEET_MODE_LOCK_KEY]);
        } catch {
          released = false;
        }
      }
      // Неснятый session-лок отравил бы следующего потребителя пула.
      client.release(!released);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('timesheet object transaction failed');
}

/**
 * Свои работающие сотрудники с режимами. employeeIds — только эти, и строки берутся
 * FOR UPDATE по порядку id (пересчёт сразу после снятия «Офиса» в окне). Без списка —
 * все и без блокировки строк: ночь не держит всех сотрудников на время расчёта часов.
 */
export async function loadOwnActiveEmployees(
  client: PoolClient,
  contractorIds: string[],
  employeeIds?: readonly number[],
): Promise<IEmployeeModeRow[]> {
  const filtered = employeeIds !== undefined;
  const rows = (await client.query<IEmployeeModeRow>(
    `SELECT e.id,
            e.full_name,
            e.timesheet_export_mode             AS mode,
            e.timesheet_export_object_id::text  AS object_id,
            e.timesheet_export_set_by           AS set_by,
            (tod.org_department_id IS NOT NULL) AS office_department,
            ${personalOfficeSql('e')}           AS personal_office
       FROM employees e
       LEFT JOIN timesheet_office_departments tod ON tod.org_department_id = e.org_department_id
      WHERE e.is_archived = false
        AND e.employment_status = 'active'
        AND (e.org_department_id IS NULL OR NOT (e.org_department_id = ANY($1::uuid[])))${filtered ? `
        AND e.id = ANY($2::int[])` : ''}
      ORDER BY e.id${filtered ? `
      FOR UPDATE OF e` : ''}`,
    filtered ? [contractorIds, [...employeeIds]] : [contractorIds],
  )).rows;
  return rows.map(row => ({ ...row, id: Number(row.id) }));
}

/** Запись изменений; условие кандидата — ещё раз в самом UPDATE. */
export async function applyChanges(client: PoolClient, changes: readonly IAutoChange[], all: boolean): Promise<number[]> {
  if (changes.length === 0) return [];
  const rows = (await client.query<{ id: number }>(
    `UPDATE employees e
        SET timesheet_export_mode = c.mode,
            timesheet_export_object_id = c.object_id,
            timesheet_export_set_by = 'auto',
            updated_at = now()
       FROM unnest($1::int[], $2::text[], $3::uuid[]) AS c(id, mode, object_id)
      WHERE e.id = c.id
        AND e.is_archived = false
        AND (e.timesheet_export_set_by IS NULL OR e.timesheet_export_set_by = 'auto')
        AND ($4::boolean OR e.timesheet_export_set_by = 'auto' OR e.timesheet_export_mode IS NULL)
      RETURNING e.id`,
    [
      changes.map(change => change.employeeId),
      changes.map(change => change.toMode),
      changes.map(change => change.toObjectId),
      all,
    ],
  )).rows;
  return rows.map(row => Number(row.id));
}

export async function auditChanges(
  client: PoolClient,
  changes: readonly IAutoChange[],
  appliedIds: readonly number[],
  context: { period: { start: string; end: string }; all: boolean; reason: string; userId: string | null },
): Promise<void> {
  if (appliedIds.length === 0) return;
  const applied = new Set(appliedIds);
  await auditService.logWithClient(client, {
    user_id: context.userId,
    action: AUDIT_ACTIONS.TIMESHEET_OBJECT_AUTO_ASSIGNED,
    entity_type: 'employee',
    entity_id: `auto:${context.period.start}..${context.period.end}`,
    details: {
      reason: context.reason,
      period: context.period,
      all: context.all,
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

/**
 * Фиксация месяца: строки для своих не архивных (включая уволенных) из текущих
 * режимов. Без ON CONFLICT: строки месяца при frozen_month < M — порча состояния,
 * её нельзя молча проглотить. Автора ручной смены (289) строка получает триггером
 * из employees.
 */
async function insertMonthFreeze(client: PoolClient, month: string, contractorIds: string[]): Promise<number> {
  const result = await client.query(
    `INSERT INTO employee_timesheet_object_months (employee_id, month, mode, object_id, set_by)
     SELECT e.id,
            $1::date,
            e.timesheet_export_mode,
            CASE WHEN e.timesheet_export_mode = 'object' THEN e.timesheet_export_object_id END,
            e.timesheet_export_set_by
       FROM employees e
      WHERE e.is_archived = false
        AND (e.org_department_id IS NULL OR NOT (e.org_department_id = ANY($2::uuid[])))`,
    [month, contractorIds],
  );
  return result.rowCount ?? 0;
}

/**
 * Правило «Офиса» отдела (291) и его аудит — по строке на сотрудника. Вызывается после
 * расчёта по часам в той же транзакции; возвращает число изменённых сотрудников.
 */
async function applyOfficeRule(client: PoolClient, contractorIds: string[], reason: string): Promise<number> {
  const changes = await enforceOfficeForDepartments(client, 'all', contractorIds);
  await writeOfficeAudit(client, officeRuleAuditEntries(changes, reason), { req: null, userId: null });
  return changes.length;
}

function invalidateAfterWrite(): void {
  employeeCache.clear();
  invalidateCaches(
    'timesheet',
    'timesheet:today',
    'timesheet:overview',
    'timesheet:overview:today',
    'timesheet:search',
  );
}

function requireState(state: ITimesheetObjectAutoState | null): ITimesheetObjectAutoState {
  if (!state) throw new Error('Нет состояния timesheet_object_auto_state — примените миграцию 288');
  return state;
}

/** Вчера по МСК. */
export function yesterdayMsk(now: Date): string {
  const date = new Date(`${moscowTodayIso(now)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

async function computeChanges(
  client: PoolClient,
  period: { start: string; end: string },
  all: boolean,
  now: Date,
): Promise<{
  contractorIds: string[];
  rows: IEmployeeModeRow[];
  tops: Map<number, ITimesheetObjectHours[]>;
  changes: IAutoChange[];
}> {
  const contractorIds = await loadContractorDepartmentIds(client);
  const rows = await loadOwnActiveEmployees(client, contractorIds);
  const objectsById = await loadSkudObjects(client);
  const tops = await loadTimesheetObjectHours(
    rows.map(row => row.id),
    period,
    { todayStr: moscowTodayIso(now), exec: client, objectsById },
  );
  return { contractorIds, rows, tops, changes: planAutoChanges(rows, tops, all) };
}

export type AutoRunResult =
  | { kind: 'skipped'; reason: string }
  | { kind: 'applied'; period: { start: string; end: string }; changed: number };

/**
 * Ночной пересчёт текущего месяца с 1-го числа по вчера. applied_date двигает только
 * он (и активация) — даже при нуле изменений; фиксация месяца его не трогает.
 */
export async function recomputeCurrentMonth(now: Date = new Date()): Promise<AutoRunResult> {
  const today = moscowTodayIso(now);
  if (today.endsWith('-01')) return { kind: 'skipped', reason: 'first_day' };
  const period = { start: currentMonthStartMsk(now), end: yesterdayMsk(now) };

  const outcome = await withModeSnapshot(async client => {
    const state = requireState(await readTimesheetObjectState(client, true));
    if (!state.enabled) return { kind: 'skipped', reason: 'disabled' } as AutoRunResult;
    if (state.applied_date && state.applied_date >= today) {
      return { kind: 'skipped', reason: 'already_applied' } as AutoRunResult;
    }
    // Порядок: пока прошлый месяц не зафиксирован, текущий не пересчитываем.
    if (state.frozen_month < previousMonthStartMsk(now)) {
      return { kind: 'skipped', reason: 'previous_month_not_frozen' } as AutoRunResult;
    }

    const { contractorIds, changes } = await computeChanges(client, period, false, now);
    const appliedIds = await applyChanges(client, changes, false);
    await auditChanges(client, changes, appliedIds, { period, all: false, reason: 'current_month', userId: null });
    const officeChanged = await applyOfficeRule(client, contractorIds, 'current_month');
    await client.query(
      'UPDATE timesheet_object_auto_state SET applied_date = $1::date, updated_at = now() WHERE singleton',
      [today],
    );
    return { kind: 'applied', period, changed: appliedIds.length + officeChanged } as AutoRunResult;
  });

  if (outcome.kind === 'applied' && outcome.changed > 0) invalidateAfterWrite();
  return outcome;
}

export type FreezeResult =
  | { kind: 'skipped'; reason: string }
  | { kind: 'frozen'; month: string; changed: number; rows: number };

/**
 * Фиксация месяца M: пересчёт авто-объектов за весь M, затем строки фиксации и
 * frozen_month = M — одной транзакцией. Месяцы фиксируются строго по порядку.
 */
export async function freezeMonth(month: string, now: Date = new Date()): Promise<FreezeResult> {
  if (month >= currentMonthStartMsk(now)) {
    throw new Error(`Месяц ${month} ещё не закончился — фиксировать нельзя`);
  }
  const period = { start: month, end: monthEnd(month) };

  const outcome = await withModeSnapshot(async client => {
    const state = requireState(await readTimesheetObjectState(client, true));
    if (!state.enabled) return { kind: 'skipped', reason: 'disabled' } as FreezeResult;
    if (state.frozen_month >= month) return { kind: 'skipped', reason: 'already_frozen' } as FreezeResult;
    if (nextMonthStart(state.frozen_month) !== month) {
      throw new Error(`Фиксация по порядку: после ${state.frozen_month} идёт ${nextMonthStart(state.frozen_month)}, а не ${month}`);
    }

    const { contractorIds, changes } = await computeChanges(client, period, false, now);
    const appliedIds = await applyChanges(client, changes, false);
    await auditChanges(client, changes, appliedIds, { period, all: false, reason: 'month_freeze', userId: null });
    // Месяц уходит с объектом на момент фиксации: «Офис» отдела — тем, кто в нём сейчас.
    const officeChanged = await applyOfficeRule(client, contractorIds, 'month_freeze');
    const rows = await insertMonthFreeze(client, month, contractorIds);
    const changed = appliedIds.length + officeChanged;
    await auditService.logWithClient(client, {
      user_id: null,
      action: AUDIT_ACTIONS.TIMESHEET_OBJECT_MONTH_FROZEN,
      entity_type: 'timesheet_object_month',
      entity_id: month,
      details: { month, rows, changed },
    });
    await client.query(
      'UPDATE timesheet_object_auto_state SET frozen_month = $1::date, updated_at = now() WHERE singleton',
      [month],
    );
    return { kind: 'frozen', month, changed, rows } as FreezeResult;
  });

  if (outcome.kind === 'frozen') invalidateAfterWrite();
  return outcome;
}

export class TimesheetObjectActivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimesheetObjectActivationError';
  }
}

export interface IActivationResult {
  dryRun: boolean;
  period: { start: string; end: string };
  frozenMonths: string[];
  report: IAutoReport;
  changes: IAutoChange[];
}

/**
 * Первый запуск (скрипт). Одной транзакцией: дозафиксация пропущенных месяцев
 * текущими значениями (расчёт тогда ещё не работал), пересчёт текущего месяца с 1-го
 * по вчера, enabled = true, applied_date, frozen_month. dryRun — только отчёт.
 */
export async function activateTimesheetObjects(options: {
  all: boolean;
  force: boolean;
  dryRun: boolean;
  now?: Date;
}): Promise<IActivationResult> {
  const now = options.now ?? new Date();
  const today = moscowTodayIso(now);
  if (today.endsWith('-01')) {
    throw new TimesheetObjectActivationError('1-го числа запуск запрещён: за текущий месяц ещё нет часов — запустите со 2-го');
  }
  const period = { start: currentMonthStartMsk(now), end: yesterdayMsk(now) };
  const previousMonth = previousMonthStartMsk(now);

  const result = await withModeSnapshot(async client => {
    const state = requireState(await readTimesheetObjectState(client, true));
    if (state.enabled && options.all && !options.force) {
      throw new TimesheetObjectActivationError(
        'Расчёт уже включён: --all перезапишет ручные режимы админа — добавьте --force, если это нужно',
      );
    }

    const { contractorIds, rows, tops, changes } = await computeChanges(client, period, options.all, now);
    const report = summarizeAutoChanges(rows, tops, changes, options.all);

    const frozenMonths: string[] = [];
    for (let month = nextMonthStart(state.frozen_month); month <= previousMonth; month = nextMonthStart(month)) {
      frozenMonths.push(month);
    }
    if (options.dryRun) {
      return { dryRun: true, period, frozenMonths, report, changes };
    }

    // Сначала фиксации прошедших месяцев — текущими значениями, до пересчёта.
    for (const month of frozenMonths) {
      await insertMonthFreeze(client, month, contractorIds);
    }
    const appliedIds = await applyChanges(client, changes, options.all);
    await auditChanges(client, changes, appliedIds, {
      period, all: options.all, reason: 'activation', userId: null,
    });
    await applyOfficeRule(client, contractorIds, 'activation');
    await auditService.logWithClient(client, {
      user_id: null,
      action: AUDIT_ACTIONS.TIMESHEET_OBJECT_ACTIVATED,
      entity_type: 'timesheet_object_state',
      entity_id: today,
      details: { period, all: options.all, force: options.force, frozen_months: frozenMonths, report },
    });
    const frozenMonth = frozenMonths.length > 0 ? frozenMonths[frozenMonths.length - 1] : state.frozen_month;
    // Месяцы, зафиксированные при активации, не пересобираются: их версии собраны
    // ровно с теми режимами, что легли в фиксацию.
    await client.query(
      `UPDATE timesheet_object_auto_state
          SET enabled = true,
              applied_date = $1::date,
              frozen_month = $2::date,
              objects_rebuilt_month = GREATEST(objects_rebuilt_month, $2::date),
              updated_at = now()
        WHERE singleton`,
      [today, frozenMonth],
    );
    return { dryRun: false, period, frozenMonths, report, changes };
  });

  if (!result.dryRun) invalidateAfterWrite();
  return result;
}
