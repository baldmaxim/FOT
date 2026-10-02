/**
 * Окно «Режим табелирования» в «Управлении кадрами» (миграция 291): «Офис» отделу,
 * сотруднику — «Офис» или объект. Само правило — timesheet-office-rule.ts.
 *
 * Запись: форма и существование (400) → права записи (403) → транзакция под локом режимов
 * (TIMESHEET_MODE_LOCK_KEY — его же берут ночной расчёт, дедуп и слияние отделов): прошлый
 * месяц не зафиксирован — 409; сотрудники перечитываются FOR UPDATE и сверяются со снимком
 * проверок — расхождение 409; запись и аудит — одной транзакцией.
 *
 * Личное назначение главнее отдела: и сотруднику отдела с «Офисом» можно назначить объект или
 * «Офис», правило отдела его не трогает. Снятие личного назначения сразу даёт то, что дала бы
 * ночь: в отделе с «Офисом» — «Офис» отдела, иначе объект по часам; снятие «Офиса» с отдела —
 * объект по часам всем, кроме назначенных лично. После COMMIT утверждённые подачи текущего
 * месяца с изменёнными сотрудниками сразу получают новую редакцию для API 1С (только у них).
 *
 * Идемпотентность: точный повтор (то же назначение из окна) ничего не пишет — ни дату, ни
 * автора, ни аудит; тот же объект от ночи один раз становится назначением.
 */
import * as Sentry from '@sentry/node';
import type { AuthenticatedRequest } from '../types/index.js';
import { query, withTransaction } from '../config/postgres.js';
import { invalidateCaches } from '../middleware/cacheResponse.js';
import { canWriteDepartmentInScope, canWriteEmployeeInScope } from './data-scope.service.js';
import { employeeCache } from './employee-cache.service.js';
import {
  isOfficeAddress,
  loadContractorDepartmentIds,
  loadSkudObjects,
  previousMonthStartMsk,
  readTimesheetObjectState,
  type TimesheetObjectSetBy,
} from './employee-timesheet-object.service.js';
import {
  TIMESHEET_MODE_LOCK_KEY,
  currentMonthStartMsk,
  type TimesheetExportMode,
} from './timesheet-export-mode.service.js';
import {
  enforceOfficeForDepartments,
  officeRuleAuditEntries,
  personalOfficeSql,
  personalPinSql,
  writeOfficeAudit,
  type IOfficeAuditEntry,
} from './timesheet-office-rule.js';
import { recomputeTimesheetObjectsNow } from './timesheet-object-recompute.service.js';
import { isRetryableDbError } from './timesheet-snapshot-tx.js';
import { rebuildVersionObjectsForMonth } from './timesheet-version-objects-rebuild.service.js';

/** Предел одного списка в запросе записи. */
export const TIMESHEET_OFFICE_BATCH_LIMIT = 500;
const MAX_ATTEMPTS = 3;

export type TimesheetOfficeErrorCode =
  | 'TIMESHEET_OFFICE_INVALID'
  | 'TIMESHEET_OFFICE_FORBIDDEN'
  | 'TIMESHEET_OFFICE_MONTH_NOT_FROZEN'
  | 'TIMESHEET_OFFICE_CHANGED'
  | 'TIMESHEET_OFFICE_BUSY';

export class TimesheetOfficeError extends Error {
  readonly status: number;
  readonly code: TimesheetOfficeErrorCode;
  readonly details: unknown;

  constructor(status: number, code: TimesheetOfficeErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'TimesheetOfficeError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ITimesheetOfficeObjectAssignment {
  id: number;
  object_id: string;
}

export interface ITimesheetOfficeUpdate {
  departments: { add: string[]; remove: string[] };
  /** add — «Офис», objects — объект, remove — снять любое личное назначение. */
  employees: { add: number[]; remove: number[]; objects?: ITimesheetOfficeObjectAssignment[] };
}

export interface ITimesheetOfficeResult {
  changed: boolean;
  departments_added: number;
  departments_removed: number;
  employees_added: number;
  /** Сотрудникам назначен объект (не «Офис»). */
  objects_assigned: number;
  employees_removed: number;
  /** Сотрудникам добавленных отделов поставлен «Офис». */
  members_applied: number;
  /** После снятия «Офиса» объект по часам сменился у стольких сотрудников. */
  recomputed: number;
}

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

interface IEmployeeCheckRow {
  id: number | string;
  full_name: string | null;
  is_archived: boolean;
  employment_status: string | null;
  org_department_id: string | null;
  mode: TimesheetExportMode | null;
  object_id: string | null;
  set_by: TimesheetObjectSetBy | null;
  personal_office: boolean;
  /** Назначение из окна — «Офис» или объект. */
  personal_pin: boolean;
}

const employeeCheckSql = (lock: boolean): string =>
  `SELECT e.id,
          e.full_name,
          e.is_archived,
          e.employment_status,
          e.org_department_id::text          AS org_department_id,
          e.timesheet_export_mode            AS mode,
          e.timesheet_export_object_id::text AS object_id,
          e.timesheet_export_set_by          AS set_by,
          ${personalOfficeSql('e')}          AS personal_office,
          ${personalPinSql('e')}             AS personal_pin
     FROM employees e
    WHERE e.id = ANY($1::int[])
    ORDER BY e.id${lock ? '\n    FOR UPDATE' : ''}`;

/** Повтор транзакции при 40001/40P01; после последней неудачи — 409. */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof TimesheetOfficeError || !isRetryableDbError(err)) throw err;
      if (attempt >= MAX_ATTEMPTS) {
        throw new TimesheetOfficeError(
          409, 'TIMESHEET_OFFICE_BUSY', 'Не удалось сохранить из-за параллельных изменений — повторите',
        );
      }
      console.warn(`[timesheet-office] повтор ${attempt}/${MAX_ATTEMPTS - 1}`);
    }
  }
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

/** Аудит личного назначения: target — «Офис», объект или снятие. */
const personalAudit = (
  row: IEmployeeCheckRow,
  target: { kind: 'office' } | { kind: 'object'; objectId: string } | { kind: 'remove' },
): IOfficeAuditEntry => ({
  entityType: 'employee',
  entityId: String(Number(row.id)),
  details: {
    employee_name: row.full_name,
    via: 'personal',
    action: target.kind === 'remove' ? 'remove' : 'add',
    old_mode: row.mode,
    old_object_id: row.object_id,
    old_set_by: row.set_by,
    new_mode: target.kind === 'office' ? 'current_activity' : target.kind === 'object' ? 'object' : row.mode,
    new_object_id: target.kind === 'object' ? target.objectId : target.kind === 'remove' ? row.object_id : null,
    new_set_by: target.kind === 'remove' ? 'auto' : null,
  },
});

/** Точный повтор: уже назначен этот же объект из окна. */
const isSameObjectPin = (row: IEmployeeCheckRow | undefined, objectId: string): boolean =>
  row?.personal_pin === true && row.mode === 'object' && row.object_id === objectId;

/**
 * objects из запроса → id → объект. Одинаковые пары схлопываются; один сотрудник с разными
 * объектами — 400. Регистр uuid не важен.
 */
function normalizeObjectAssignments(items: readonly ITimesheetOfficeObjectAssignment[]): Map<number, string> {
  const targets = new Map<number, string>();
  const conflicting = new Set<number>();
  for (const item of items) {
    const objectId = item.object_id.toLowerCase();
    const current = targets.get(item.id);
    if (current !== undefined && current !== objectId) conflicting.add(item.id);
    else targets.set(item.id, objectId);
  }
  if (conflicting.size > 0) {
    throw new TimesheetOfficeError(
      400, 'TIMESHEET_OFFICE_INVALID', 'Одному сотруднику — разные объекты', [...conflicting].sort((a, b) => a - b),
    );
  }
  return targets;
}

/** PUT /api/admin/timesheet-office */
export async function updateTimesheetOffice(
  req: AuthenticatedRequest,
  input: ITimesheetOfficeUpdate,
  now: Date = new Date(),
): Promise<ITimesheetOfficeResult> {
  const deptAdd = unique(input.departments.add);
  const deptRemove = unique(input.departments.remove);
  const empAdd = unique(input.employees.add);
  const empRemove = unique(input.employees.remove);
  const objectTargets = normalizeObjectAssignments(input.employees.objects ?? []);
  const empObjects = [...objectTargets.keys()].sort((a, b) => a - b);

  const overlap = [
    ...deptAdd.filter(id => deptRemove.includes(id)),
    ...unique([
      ...empAdd.filter(id => empRemove.includes(id) || objectTargets.has(id)),
      ...empObjects.filter(id => empRemove.includes(id)),
    ]).map(String),
  ];
  if (overlap.length > 0) {
    throw new TimesheetOfficeError(400, 'TIMESHEET_OFFICE_INVALID', 'Один и тот же id в разных списках запроса', overlap);
  }
  const noop: ITimesheetOfficeResult = {
    changed: false, departments_added: 0, departments_removed: 0,
    employees_added: 0, objects_assigned: 0, employees_removed: 0, members_applied: 0, recomputed: 0,
  };
  if (deptAdd.length + deptRemove.length + empAdd.length + empRemove.length + empObjects.length === 0) return noop;

  const contractorIds = await loadContractorDepartmentIds();
  const contractors = new Set(contractorIds);

  // ── 400: существование — до прав, чтобы несуществующий id давал понятную ошибку ──
  if (deptAdd.length > 0) {
    const rows = await query<{ id: string; is_active: boolean; kind: string | null }>(
      'SELECT id::text AS id, is_active, kind FROM org_departments WHERE id = ANY($1::uuid[])',
      [deptAdd],
    );
    const byId = new Map(rows.map(row => [row.id, row]));
    const invalid = deptAdd.filter(id => {
      const row = byId.get(id);
      return !row || !row.is_active || row.kind === 'object' || contractors.has(id);
    });
    if (invalid.length > 0) {
      throw new TimesheetOfficeError(400, 'TIMESHEET_OFFICE_INVALID', 'Отдел не найден, неактивен или подрядный', invalid);
    }
  }
  const rulesToRemove = deptRemove.length > 0
    ? (await query<{ id: string }>(
      'SELECT org_department_id::text AS id FROM timesheet_office_departments WHERE org_department_id = ANY($1::uuid[])',
      [deptRemove],
    )).map(row => row.id)
    : [];

  const empAssign = [...empAdd, ...empObjects];
  const checkedIds = unique([...empAssign, ...empRemove]);
  const checkedRows = checkedIds.length > 0 ? await query<IEmployeeCheckRow>(employeeCheckSql(false), [checkedIds]) : [];
  const checkedById = new Map(checkedRows.map(row => [Number(row.id), row]));
  const invalidEmployees = empAssign.filter(id => {
    const row = checkedById.get(id);
    return !row
      || row.is_archived
      || row.employment_status !== 'active'
      || !row.org_department_id
      || contractors.has(row.org_department_id);
  });
  if (invalidEmployees.length > 0) {
    throw new TimesheetOfficeError(
      400, 'TIMESHEET_OFFICE_INVALID', 'Сотрудник не найден, в архиве, не работает или из подрядной организации',
      invalidEmployees,
    );
  }
  // Объект: есть, не офисный (для офиса — «Офис») и действующий; неактивный — только точный повтор.
  if (empObjects.length > 0) {
    const objectsById = await loadSkudObjects();
    const invalidObjects = empObjects.filter(id => {
      const objectId = objectTargets.get(id)!;
      const object = objectsById.get(objectId);
      if (!object || isOfficeAddress(object.alt_name)) return true;
      return !object.is_active && !isSameObjectPin(checkedById.get(id), objectId);
    });
    if (invalidObjects.length > 0) {
      throw new TimesheetOfficeError(
        400, 'TIMESHEET_OFFICE_INVALID', 'Объект не найден, неактивен или офисный — для офиса выберите «Офис»',
        invalidObjects,
      );
    }
  }
  // Снять можно только личное назначение из окна; остальное — no-op.
  const personalToRemove = empRemove.filter(id => checkedById.get(id)?.personal_pin === true);

  // ── 403: права записи ──
  const deniedDepartments: string[] = [];
  for (const id of unique([...deptAdd, ...rulesToRemove])) {
    if (!(await canWriteDepartmentInScope(req, id))) deniedDepartments.push(id);
  }
  const deniedEmployees: number[] = [];
  for (const id of unique([...empAssign, ...personalToRemove])) {
    if (!(await canWriteEmployeeInScope(req, id))) deniedEmployees.push(id);
  }
  if (deniedDepartments.length > 0 || deniedEmployees.length > 0) {
    throw new TimesheetOfficeError(
      403, 'TIMESHEET_OFFICE_FORBIDDEN', 'Есть отделы или сотрудники вне вашего доступа',
      { departments: deniedDepartments, employees: deniedEmployees },
    );
  }

  // Снимок проверенного: скоуп зависит от отдела сотрудника — под FOR UPDATE он не изменится.
  const lockIds = unique([...empAssign, ...personalToRemove]).sort((a, b) => a - b);

  const { result, personalChanged } = await withRetry(() => withTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [TIMESHEET_MODE_LOCK_KEY]);

    // Fail-closed: без состояния расчёта или до фиксации прошлого месяца запись попала бы в него.
    const state = await readTimesheetObjectState(client);
    if (!state || state.frozen_month < previousMonthStartMsk(now)) {
      throw new TimesheetOfficeError(
        409, 'TIMESHEET_OFFICE_MONTH_NOT_FROZEN', 'Объект за прошлый месяц ещё фиксируется — попробуйте позже',
      );
    }

    const lockedById = new Map<number, IEmployeeCheckRow>();
    if (lockIds.length > 0) {
      const rows = (await client.query<IEmployeeCheckRow>(employeeCheckSql(true), [lockIds])).rows;
      for (const row of rows) lockedById.set(Number(row.id), row);
      const drifted = lockIds.filter(id => {
        const locked = lockedById.get(id);
        const checked = checkedById.get(id);
        return !locked || !checked
          || locked.is_archived !== checked.is_archived
          || locked.employment_status !== checked.employment_status
          || locked.org_department_id !== checked.org_department_id;
      });
      if (drifted.length > 0) {
        throw new TimesheetOfficeError(409, 'TIMESHEET_OFFICE_CHANGED', 'Состав изменился — обновите окно', drifted);
      }
    }

    const audit: IOfficeAuditEntry[] = [];

    // Личное назначение — поверх любого объекта, в том числе того же от авто: меняются
    // источник и автор. Точный повтор (то же назначение из окна) — пропуск.
    const addIds = empAdd.filter(id => lockedById.get(id)?.personal_office !== true);
    const objectIds = empObjects.filter(id => !isSameObjectPin(lockedById.get(id), objectTargets.get(id)!));
    const added = addIds.length > 0
      ? (await client.query<{ id: number | string }>(
        `UPDATE employees e
            SET timesheet_export_mode = 'current_activity',
                timesheet_export_object_id = NULL,
                timesheet_export_set_by = NULL,
                timesheet_export_set_by_user_id = $2::uuid,
                timesheet_export_set_at = now(),
                updated_at = now()
          WHERE e.id = ANY($1::int[])
            AND e.is_archived = false
            AND e.employment_status = 'active'
            AND NOT ${personalOfficeSql('e')}
          RETURNING e.id`,
        [addIds, req.user.id],
      )).rows.map(row => Number(row.id))
      : [];
    for (const id of added) audit.push(personalAudit(lockedById.get(id)!, { kind: 'office' }));

    // Объект: условие точного повтора — ещё раз в самом UPDATE; id по возрастанию.
    const objectsAssigned = objectIds.length > 0
      ? (await client.query<{ id: number | string }>(
        `UPDATE employees e
            SET timesheet_export_mode = 'object',
                timesheet_export_object_id = c.object_id,
                timesheet_export_set_by = NULL,
                timesheet_export_set_by_user_id = $3::uuid,
                timesheet_export_set_at = now(),
                updated_at = now()
           FROM unnest($1::int[], $2::uuid[]) AS c(id, object_id)
          WHERE e.id = c.id
            AND e.is_archived = false
            AND e.employment_status = 'active'
            AND NOT (${personalPinSql('e')}
                     AND e.timesheet_export_mode = 'object'
                     AND e.timesheet_export_object_id = c.object_id)
          RETURNING e.id`,
        [objectIds, objectIds.map(id => objectTargets.get(id)!), req.user.id],
      )).rows.map(row => Number(row.id)).sort((a, b) => a - b)
      : [];
    for (const id of objectsAssigned) {
      audit.push(personalAudit(lockedById.get(id)!, { kind: 'object', objectId: objectTargets.get(id)! }));
    }

    // Снятие: объект снова авто (set_by = 'auto'), пересчёт по часам — ниже; автора обнулит триггер 289.
    const removeIds = personalToRemove.filter(id => lockedById.get(id)?.personal_pin === true);
    const removed = removeIds.length > 0
      ? (await client.query<{ id: number | string }>(
        `UPDATE employees e
            SET timesheet_export_set_by = 'auto',
                updated_at = now()
          WHERE e.id = ANY($1::int[])
            AND ${personalPinSql('e')}
          RETURNING e.id`,
        [removeIds],
      )).rows.map(row => Number(row.id))
      : [];
    for (const id of removed) audit.push(personalAudit(lockedById.get(id)!, { kind: 'remove' }));

    const departmentsRemoved = deptRemove.length > 0
      ? (await client.query<{ id: string; name: string | null }>(
        `DELETE FROM timesheet_office_departments tod
          WHERE tod.org_department_id = ANY($1::uuid[])
          RETURNING tod.org_department_id::text AS id,
                    (SELECT d.name FROM org_departments d WHERE d.id = tod.org_department_id) AS name`,
        [deptRemove],
      )).rows
      : [];
    for (const row of departmentsRemoved) {
      audit.push({ entityType: 'org_department', entityId: row.id, details: { department_name: row.name, office: false } });
    }

    const departmentsAdded = deptAdd.length > 0
      ? (await client.query<{ id: string; name: string | null }>(
        `INSERT INTO timesheet_office_departments AS tod (org_department_id, created_by)
         SELECT unnest($1::uuid[]), $2::uuid
         ON CONFLICT (org_department_id) DO NOTHING
         RETURNING tod.org_department_id::text AS id,
                   (SELECT d.name FROM org_departments d WHERE d.id = tod.org_department_id) AS name`,
        [deptAdd, req.user.id],
      )).rows
      : [];
    for (const row of departmentsAdded) {
      audit.push({ entityType: 'org_department', entityId: row.id, details: { department_name: row.name, office: true } });
    }

    // Правило для отделов из add — и уже отмеченных — и для отделов, где сняли личное
    // назначение: результат тот же, что дала бы ночь. Назначенных лично правило не трогает.
    const members = await enforceOfficeForDepartments(
      client,
      unique([...deptAdd, ...removed.map(id => lockedById.get(id)!.org_department_id!)]),
      contractorIds,
    );
    audit.push(...officeRuleAuditEntries(members, 'window'));

    await writeOfficeAudit(client, audit, { req, userId: req.user.id });

    // «Вернуть»: с кого снято назначение — лично или «Офис» с отдела, — тем объект по часам
    // сразу; сотрудников отделов с «Офисом» и назначенных лично пересчёт пропускает.
    const removedDepartmentMembers = departmentsRemoved.length > 0
      ? (await client.query<{ id: number | string }>(
        `SELECT e.id FROM employees e
          WHERE e.org_department_id = ANY($1::uuid[])
            AND e.is_archived = false
            AND e.employment_status = 'active'`,
        [departmentsRemoved.map(row => row.id)],
      )).rows.map(row => Number(row.id))
      : [];
    const recomputed = await recomputeTimesheetObjectsNow(client, [...removed, ...removedDepartmentMembers], {
      contractorIds, now, userId: req.user.id, reason: 'office_removed',
    });

    return {
      result: {
        changed: audit.length > 0 || recomputed.length > 0,
        departments_added: departmentsAdded.length,
        departments_removed: departmentsRemoved.length,
        employees_added: added.length,
        objects_assigned: objectsAssigned.length,
        employees_removed: removed.length,
        members_applied: members.length,
        recomputed: recomputed.length,
      },
      personalChanged: unique([...added, ...objectsAssigned, ...removed]).sort((a, b) => a - b),
    };
  }));

  if (result.changed) invalidateAfterWrite();
  await rebuildCurrentMonthVersions(personalChanged, now);
  return result;
}

/**
 * Утверждённые подачи текущего месяца с этими сотрудниками — новая редакция для API 1С сразу,
 * не дожидаясь фиксации месяца; меняются только эти сотрудники. Сбой — в Sentry: запись окна
 * уже сделана, а ночная пересборка после фиксации месяца соберёт назначенных заново.
 */
async function rebuildCurrentMonthVersions(employeeIds: number[], now: Date): Promise<void> {
  if (employeeIds.length === 0) return;
  try {
    const rebuilt = await rebuildVersionObjectsForMonth(currentMonthStartMsk(now), {
      employeeIds, onlyListedEmployees: true,
    });
    if (rebuilt.failures > 0) console.warn(`[timesheet-office] пересборка подач: сбоев ${rebuilt.failures}`);
  } catch (error) {
    console.error('[timesheet-office] пересборка подач текущего месяца не удалась:', error);
    Sentry.captureException(error, { tags: { source: 'timesheet-office' }, extra: { employeeIds } });
  }
}
