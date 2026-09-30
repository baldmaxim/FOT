/**
 * Окно «Режим табелирования» в «Управлении кадрами» (миграция 291): «Офис» отделу или
 * сотруднику. Само правило и блокировка выбора — timesheet-office-rule.ts.
 *
 * Запись: форма и существование (400) → права записи (403) → транзакция под локом режимов
 * (TIMESHEET_MODE_LOCK_KEY — его же берут ночной расчёт, выбор в ЛК/табеле, дедуп и слияние
 * отделов): прошлый месяц не зафиксирован — 409; сотрудники перечитываются FOR UPDATE и
 * сверяются со снимком проверок — расхождение 409; запись и аудит — одной транзакцией.
 */
import type { AuthenticatedRequest } from '../types/index.js';
import { query, withTransaction } from '../config/postgres.js';
import { invalidateCaches } from '../middleware/cacheResponse.js';
import { escapeLike } from '../utils/search.utils.js';
import {
  canWriteDepartmentInScope,
  canWriteEmployeeInScope,
  resolveAccessibleDepartmentIds,
  resolveWritableScopedDepartmentIds,
} from './data-scope.service.js';
import { employeeCache } from './employee-cache.service.js';
import {
  loadContractorDepartmentIds,
  previousMonthStartMsk,
  readTimesheetObjectState,
  type TimesheetObjectSetBy,
} from './employee-timesheet-object.service.js';
import { TIMESHEET_MODE_LOCK_KEY, type TimesheetExportMode } from './timesheet-export-mode.service.js';
import {
  enforceOfficeForDepartments,
  officeRuleAuditEntries,
  personalOfficeSql,
  writeOfficeAudit,
  type IOfficeAuditEntry,
} from './timesheet-office-rule.js';
import { isRetryableDbError } from './timesheet-snapshot-tx.js';

/** Предел одного списка в запросе записи. */
export const TIMESHEET_OFFICE_BATCH_LIMIT = 500;
const SEARCH_LIMIT = 20;
const SEARCH_MIN_LENGTH = 2;
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

export interface ITimesheetOfficeDepartment {
  id: string;
  name: string;
  employees_count: number;
}

export interface ITimesheetOfficeEmployee {
  id: number;
  full_name: string;
  department: string | null;
}

export interface ITimesheetOfficeState {
  /** Отделы, которые можно выбрать: активные, не подрядные, в скоупе записи. */
  allowed_department_ids: string[];
  /** Отделы с «Офисом». */
  departments: ITimesheetOfficeDepartment[];
  /** Сотрудники с личным «Офисом». */
  employees: ITimesheetOfficeEmployee[];
}

export interface ITimesheetOfficeUpdate {
  departments: { add: string[]; remove: string[] };
  employees: { add: number[]; remove: number[] };
}

export interface ITimesheetOfficeResult {
  changed: boolean;
  departments_added: number;
  departments_removed: number;
  employees_added: number;
  employees_removed: number;
  /** Сотрудникам добавленных отделов поставлен «Офис». */
  members_applied: number;
}

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

/** Скоуп чтения как предикат по отделу. */
async function readScopePredicate(req: AuthenticatedRequest): Promise<(departmentId: string | null) => boolean> {
  const accessible = await resolveAccessibleDepartmentIds(req);
  if (accessible === 'all') return () => true;
  const allowed = new Set(accessible);
  return departmentId => departmentId !== null && allowed.has(departmentId);
}

/** GET /api/admin/timesheet-office */
export async function getTimesheetOfficeState(req: AuthenticatedRequest): Promise<ITimesheetOfficeState> {
  const [contractorIds, inReadScope] = await Promise.all([
    loadContractorDepartmentIds(),
    readScopePredicate(req),
  ]);

  const candidates = await query<{ id: string }>(
    `SELECT id::text AS id
       FROM org_departments
      WHERE is_active = true
        AND kind IS DISTINCT FROM 'object'
        AND NOT (id = ANY($1::uuid[]))`,
    [contractorIds],
  );
  // С id: без них при скоупе «все» функция возвращает пустой список.
  const allowed = candidates.length > 0
    ? await resolveWritableScopedDepartmentIds(req, candidates.map(row => row.id))
    : [];

  // Отделы с «Офисом» — и неактивные: снять правило должно быть можно всегда.
  const departments = (await query<ITimesheetOfficeDepartment>(
    `SELECT d.id::text AS id,
            d.name,
            (SELECT count(*)::int
               FROM employees e
              WHERE e.org_department_id = d.id
                AND e.is_archived = false
                AND e.employment_status = 'active') AS employees_count
       FROM timesheet_office_departments tod
       JOIN org_departments d ON d.id = tod.org_department_id
      ORDER BY d.name, d.id`,
  )).filter(row => inReadScope(row.id));

  const employees = (await query<ITimesheetOfficeEmployee & { department_id: string | null }>(
    `SELECT e.id,
            e.full_name,
            e.org_department_id::text AS department_id,
            d.name AS department
       FROM employees e
       LEFT JOIN org_departments d ON d.id = e.org_department_id
      WHERE e.is_archived = false
        AND ${personalOfficeSql('e')}
      ORDER BY e.full_name, e.id`,
  ))
    .filter(row => inReadScope(row.department_id))
    .map(row => ({ id: Number(row.id), full_name: row.full_name, department: row.department }));

  return { allowed_department_ids: allowed, departments, employees };
}

/** GET /api/admin/timesheet-office/employees?search= — подсказки для «Поиска по ФИО». */
export async function searchTimesheetOfficeEmployees(
  req: AuthenticatedRequest,
  search: string,
): Promise<ITimesheetOfficeEmployee[]> {
  const term = search.trim().toLowerCase().replace(/ё/g, 'е');
  if (term.length < SEARCH_MIN_LENGTH) return [];

  const [contractorIds, accessible] = await Promise.all([
    loadContractorDepartmentIds(),
    resolveAccessibleDepartmentIds(req),
  ]);
  // Скоуп записи: при «всех» фильтра нет, иначе — отделы, где пользователь может править.
  const writable = accessible === 'all' ? null : await resolveWritableScopedDepartmentIds(req, accessible);
  if (writable && writable.length === 0) return [];

  const params: unknown[] = [contractorIds, `%${escapeLike(term)}%`];
  let scopeSql = '';
  if (writable) {
    params.push(writable);
    scopeSql = 'AND e.org_department_id = ANY($3::uuid[])';
  }
  const rows = await query<ITimesheetOfficeEmployee>(
    `SELECT e.id, e.full_name, d.name AS department
       FROM employees e
       LEFT JOIN org_departments d ON d.id = e.org_department_id
      WHERE e.is_archived = false
        AND e.employment_status = 'active'
        AND e.org_department_id IS NOT NULL
        AND NOT (e.org_department_id = ANY($1::uuid[]))
        AND replace(lower(e.full_name), 'ё', 'е') LIKE $2
        ${scopeSql}
      ORDER BY e.full_name, e.id
      LIMIT ${SEARCH_LIMIT}`,
    params,
  );
  return rows.map(row => ({ id: Number(row.id), full_name: row.full_name, department: row.department }));
}

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
          ${personalOfficeSql('e')}          AS personal_office
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

const personalAudit = (
  row: IEmployeeCheckRow,
  action: 'add' | 'remove',
): IOfficeAuditEntry => ({
  entityType: 'employee',
  entityId: String(Number(row.id)),
  details: {
    employee_name: row.full_name,
    via: 'personal',
    action,
    old_mode: row.mode,
    old_object_id: row.object_id,
    old_set_by: row.set_by,
    new_mode: action === 'add' ? 'current_activity' : row.mode,
    new_object_id: null,
    new_set_by: action === 'add' ? null : 'auto',
  },
});

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

  const overlap = [
    ...deptAdd.filter(id => deptRemove.includes(id)),
    ...empAdd.filter(id => empRemove.includes(id)).map(String),
  ];
  if (overlap.length > 0) {
    throw new TimesheetOfficeError(400, 'TIMESHEET_OFFICE_INVALID', 'Один и тот же id и в добавлении, и в снятии', overlap);
  }
  const noop: ITimesheetOfficeResult = {
    changed: false, departments_added: 0, departments_removed: 0,
    employees_added: 0, employees_removed: 0, members_applied: 0,
  };
  if (deptAdd.length + deptRemove.length + empAdd.length + empRemove.length === 0) return noop;

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

  const checkedIds = unique([...empAdd, ...empRemove]);
  const checkedRows = checkedIds.length > 0 ? await query<IEmployeeCheckRow>(employeeCheckSql(false), [checkedIds]) : [];
  const checkedById = new Map(checkedRows.map(row => [Number(row.id), row]));
  const invalidEmployees = empAdd.filter(id => {
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
  // Снять можно только личный «Офис»; остальное — no-op.
  const personalToRemove = empRemove.filter(id => checkedById.get(id)?.personal_office === true);

  // ── 403: права записи ──
  const deniedDepartments: string[] = [];
  for (const id of unique([...deptAdd, ...rulesToRemove])) {
    if (!(await canWriteDepartmentInScope(req, id))) deniedDepartments.push(id);
  }
  const deniedEmployees: number[] = [];
  for (const id of unique([...empAdd, ...personalToRemove])) {
    if (!(await canWriteEmployeeInScope(req, id))) deniedEmployees.push(id);
  }
  if (deniedDepartments.length > 0 || deniedEmployees.length > 0) {
    throw new TimesheetOfficeError(
      403, 'TIMESHEET_OFFICE_FORBIDDEN', 'Есть отделы или сотрудники вне вашего доступа',
      { departments: deniedDepartments, employees: deniedEmployees },
    );
  }

  // Снимок проверенного: скоуп зависит от отдела сотрудника — под FOR UPDATE он не изменится.
  const lockIds = unique([...empAdd, ...personalToRemove]).sort((a, b) => a - b);

  const result = await withRetry(() => withTransaction(async client => {
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

    // Личный «Офис» — поверх любого объекта, в том числе «Офиса» от авто или ручного выбора:
    // меняются источник и автор (столбец 38 «Единого 1С»).
    const addIds = empAdd.filter(id => lockedById.get(id)?.personal_office !== true);
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
    for (const id of added) audit.push(personalAudit(lockedById.get(id)!, 'add'));

    // Снятие: объект снова считает ночь (set_by = 'auto'); автора обнулит триггер 289.
    const removeIds = personalToRemove.filter(id => lockedById.get(id)?.personal_office === true);
    const removed = removeIds.length > 0
      ? (await client.query<{ id: number | string }>(
        `UPDATE employees e
            SET timesheet_export_set_by = 'auto',
                updated_at = now()
          WHERE e.id = ANY($1::int[])
            AND ${personalOfficeSql('e')}
          RETURNING e.id`,
        [removeIds],
      )).rows.map(row => Number(row.id))
      : [];
    for (const id of removed) audit.push(personalAudit(lockedById.get(id)!, 'remove'));

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

    // Правило для всех отделов из add — и уже отмеченных: результат тот же, что дала бы ночь.
    const members = await enforceOfficeForDepartments(client, deptAdd, contractorIds);
    audit.push(...officeRuleAuditEntries(members, 'window'));

    await writeOfficeAudit(client, audit, { req, userId: req.user.id });

    return {
      changed: audit.length > 0,
      departments_added: departmentsAdded.length,
      departments_removed: departmentsRemoved.length,
      employees_added: added.length,
      employees_removed: removed.length,
      members_applied: members.length,
    };
  }));

  if (result.changed) invalidateAfterWrite();
  return result;
}
