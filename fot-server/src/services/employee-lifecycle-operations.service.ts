import { hostname } from 'node:os';
import { AxiosError } from 'axios';
import * as Sentry from '@sentry/node';
import type { PoolClient } from 'pg';
import { query, queryOne, execute, withTransaction } from '../config/postgres.js';
import { employeeChangesService } from './employee-changes.service.js';
import { ensureLocalArchiveDepartment } from './employee-archive-department.service.js';
import {
  ensureArchiveSigurDepartment,
  syncLinkedEmployeeFromSigur,
} from './sigur-linked-employees.service.js';
import { sigurService } from './sigur.service.js';
import { settingsService } from './settings.service.js';
import {
  upsertTechnicalDepartmentAccess,
  deactivateAllDepartmentAccessForEmployee,
} from './employee-department-access.service.js';
import { employeeCache } from './employee-cache.service.js';
import { normalizeEmployee } from './sigur-sync-shared.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import type { ConnectionType } from './sigur-base.service.js';
import type { EmployeeEncrypted } from '../types/index.js';

/**
 * Durable-операции жизненного цикла сотрудника: увольнение, восстановление, ремонт
 * карточки в Sigur. Между PostgreSQL и Sigur нет общей транзакции, поэтому каждая
 * операция хранится в employee_lifecycle_operations (миграция 261) с идемпотентными
 * шагами: crash на любом шаге доводится планировщиком по lease, повтор кнопки
 * продолжает ТУ ЖЕ операцию. Финализация — CAS по employees.lifecycle_revision:
 * любое решение, принятое по устаревшему снимку (в т.ч. синком Sigur), становится noop.
 *
 * Инцидент 31.08–01.09.2026 (Тухтаев 1826): синк уволил по одной постраничной выгрузке,
 * а после «Восстановить» уволил снова через 3 минуты — см. миграцию 261.
 */

export type TLifecycleOperationKind = 'rehire' | 'dismiss' | 'repair_sigur';
export type TLifecycleOperationStatus = 'pending' | 'applied' | 'cancelled';
export type TLifecycleOperationSource =
  | 'manual'
  | 'scheduler'
  | 'contractor_admin'
  | 'sigur_archive'
  | 'sigur_missing'
  | 'sigur_compensation';

export interface ILifecycleOperation {
  id: string;
  employee_id: number;
  kind: TLifecycleOperationKind;
  status: TLifecycleOperationStatus;
  source: TLifecycleOperationSource;
  base_revision: number;
  sigur_employee_id: number | null;
  from_department_id: string | null;
  target_department_id: string;
  target_sigur_department_id: number | null;
  effective_date: string;
  dismissal_date: string | null;
  sigur_move_required: boolean;
  sigur_access_required: boolean;
  sigur_moved: boolean;
  sigur_access_toggled: boolean;
  sigur_detached: boolean;
  lease_owner: string | null;
  lease_expires_at: string | null;
  attempts: number;
  last_error: string | null;
  created_by: string | null;
  created_at: string;
  applied_at: string | null;
}

/** Просроченный lease перехватывается (процесс упал между шагами). */
export const LIFECYCLE_LEASE_MINUTES = 30;
/** После стольких попыток операция остаётся pending, но уходит алерт в Sentry. */
export const LIFECYCLE_MAX_ATTEMPTS_ALERT = 50;
/**
 * Дополнительный фильтр после успешного rehire: синк не трогает сотрудника ещё столько
 * минут (лаг Sigur между PUT и выгрузкой). Основа корректности — pending-операция и CAS.
 */
export const REHIRE_GRACE_MINUTES = 60;

const PROCESS_ID = `${hostname()}:${process.pid}`;
let ownerCounter = 0;

/** Уникальный владелец lease на один запуск: stale-исполнитель того же процесса не пройдёт CAS. */
export function newLeaseOwner(): string {
  ownerCounter += 1;
  return `${PROCESS_ID}:${Date.now().toString(36)}:${ownerCounter}`;
}

export const EMPLOYEE_LIFECYCLE_COLUMNS = 'id, full_name, last_name, first_name, middle_name, current_salary, salary_actual, salary_calculated, staff_units, birth_date, hire_date, country, pension_number, patent_issue_date, patent_expiry_date, email, org_department_id, position_id, sigur_employee_id, tab_number, current_status, permit_expiry_date, registration_cat1, registration_cat4, doc_receipt_date, work_object, employment_status, department_locked, is_archived, archived_at, dismissal_date, excluded_from_timesheet, excluded_from_timesheet_date, created_at, updated_at';

const OPERATION_COLUMNS = `id, employee_id, kind, status, source, base_revision, sigur_employee_id,
  from_department_id, target_department_id, target_sigur_department_id,
  effective_date::text AS effective_date, dismissal_date::text AS dismissal_date,
  sigur_move_required, sigur_access_required, sigur_moved, sigur_access_toggled, sigur_detached,
  lease_owner, lease_expires_at::text AS lease_expires_at, attempts, last_error, created_by,
  created_at::text AS created_at, applied_at::text AS applied_at`;

export class LifecycleOperationError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Ошибка Sigur при увольнении с признаками частичного применения (для ответа fire()). */
export class DismissalSigurError extends Error {
  status: number;
  code: string;
  movedToArchive: boolean;
  blocked: boolean;
  constructor(message: string, status: number, code: string, movedToArchive: boolean, blocked: boolean) {
    super(message);
    this.status = status;
    this.code = code;
    this.movedToArchive = movedToArchive;
    this.blocked = blocked;
  }
}

/** Lease перехвачен другим исполнителем: текущий прогон молча останавливается. */
class LeaseLostError extends Error {
  constructor(opId: string) {
    super(`lifecycle operation ${opId}: lease lost`);
  }
}

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === '23505');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ─── Открытие операций ───

interface IEmployeeLockRow {
  employment_status: string;
  lifecycle_revision: number;
  org_department_id: string | null;
  sigur_employee_id: number | null;
  dismissal_date: string | null;
}

async function lockEmployee(client: PoolClient, employeeId: number): Promise<IEmployeeLockRow | null> {
  const res = await client.query<IEmployeeLockRow>(
    `SELECT employment_status, lifecycle_revision, org_department_id, sigur_employee_id,
            dismissal_date::text AS dismissal_date
       FROM employees WHERE id = $1 FOR UPDATE`,
    [employeeId],
  );
  return res.rows[0] ?? null;
}

async function findPendingOperation(client: PoolClient, employeeId: number): Promise<ILifecycleOperation | null> {
  const res = await client.query<ILifecycleOperation>(
    `SELECT ${OPERATION_COLUMNS} FROM employee_lifecycle_operations
      WHERE employee_id = $1 AND status = 'pending' FOR UPDATE`,
    [employeeId],
  );
  return res.rows[0] ?? null;
}

interface IInsertOperationInput {
  employeeId: number;
  kind: TLifecycleOperationKind;
  source: TLifecycleOperationSource;
  baseRevision: number;
  sigurEmployeeId: number | null;
  fromDepartmentId: string | null;
  targetDepartmentId: string;
  targetSigurDepartmentId: number | null;
  effectiveDate: string;
  dismissalDate: string | null;
  sigurMoveRequired: boolean;
  sigurAccessRequired: boolean;
  createdBy: string | null;
}

async function insertOperation(client: PoolClient, input: IInsertOperationInput): Promise<ILifecycleOperation> {
  try {
    const res = await client.query<ILifecycleOperation>(
      `INSERT INTO employee_lifecycle_operations
         (employee_id, kind, status, source, base_revision, sigur_employee_id, from_department_id,
          target_department_id, target_sigur_department_id, effective_date, dismissal_date,
          sigur_move_required, sigur_access_required, created_by)
       VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING ${OPERATION_COLUMNS}`,
      [
        input.employeeId, input.kind, input.source, input.baseRevision, input.sigurEmployeeId,
        input.fromDepartmentId, input.targetDepartmentId, input.targetSigurDepartmentId,
        input.effectiveDate, input.dismissalDate, input.sigurMoveRequired, input.sigurAccessRequired,
        input.createdBy,
      ],
    );
    return res.rows[0];
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new LifecycleOperationError(409, 'Операция по сотруднику уже выполняется — повторите позже', 'OPERATION_IN_PROGRESS');
    }
    throw error;
  }
}

export interface IOpenDismissInput {
  employeeId: number;
  dismissalDate: string;
  source: TLifecycleOperationSource;
  createdBy: string | null;
  connection?: ConnectionType;
  /** Планировщик уже держит claim `dismissal_apply_started_at` — не перезахватывать. */
  claimedAt?: string | null;
  /** Синк: CAS по версии, увиденной в fresh-чтении непосредственно перед решением. */
  expectedRevision?: number;
  /**
   * Дата перехода в «Уволенные». Ручное увольнение: D+1 (день D — рабочий).
   * Синк по архивной папке Sigur: сегодня (карточка уже в архиве).
   */
  effectiveDate?: string;
  /**
   * Какие шаги Sigur нужны: 'full' — перенос в архив + блокировка (ручное увольнение);
   * 'access_only' — карточка уже в архивной папке, нужна только блокировка;
   * 'none' — карточки в Sigur нет (удалена) либо сотрудник не связан с Sigur.
   */
  sigurSteps: 'full' | 'access_only' | 'none';
}

/**
 * Открывает операцию увольнения: claim + запись pending-операции одной транзакцией.
 * До внешних мутаций. 409 — если увольнение уже применяется/сотрудник не active/версия ушла.
 */
export async function openDismissOperation(input: IOpenDismissInput): Promise<ILifecycleOperation> {
  const localArchive = await ensureLocalArchiveDepartment(input.createdBy, { connection: input.connection });

  return withTransaction(async (client) => {
    const emp = await lockEmployee(client, input.employeeId);
    if (!emp) throw new LifecycleOperationError(404, 'Employee not found', 'NOT_FOUND');
    if (emp.employment_status !== 'active') {
      throw new LifecycleOperationError(409, 'Сотрудник уже уволен', 'NOT_ACTIVE');
    }
    if (input.expectedRevision != null && emp.lifecycle_revision !== input.expectedRevision) {
      throw new LifecycleOperationError(409, 'Состояние сотрудника изменилось — обновите страницу', 'STATE_CHANGED');
    }
    const pending = await findPendingOperation(client, input.employeeId);
    if (pending) {
      throw new LifecycleOperationError(409, 'Операция по сотруднику уже выполняется — повторите позже', 'OPERATION_IN_PROGRESS');
    }

    if (!input.claimedAt) {
      // CAS-claim: маркер «увольнением владеет lifecycle» для Sigur-синка + dismissal_date,
      // чтобы при падении между шагами сотрудник не остался «active без даты».
      const claimed = await client.query(
        `UPDATE employees
            SET dismissal_apply_started_at = now(), dismissal_date = $2
          WHERE id = $1
            AND employment_status = 'active'
            AND (dismissal_apply_started_at IS NULL
                 OR dismissal_apply_started_at < now() - ($3 || ' minutes')::interval)
          RETURNING id`,
        [input.employeeId, input.dismissalDate, String(LIFECYCLE_LEASE_MINUTES)],
      );
      if (claimed.rowCount === 0) {
        throw new LifecycleOperationError(409, 'Увольнение сотрудника уже применяется другим процессом — повторите позже', 'OPERATION_IN_PROGRESS');
      }
    }

    const hasSigur = emp.sigur_employee_id != null && input.sigurSteps !== 'none';
    return insertOperation(client, {
      employeeId: input.employeeId,
      kind: 'dismiss',
      source: input.source,
      baseRevision: emp.lifecycle_revision,
      sigurEmployeeId: emp.sigur_employee_id,
      fromDepartmentId: emp.org_department_id && emp.org_department_id !== localArchive.id ? emp.org_department_id : null,
      targetDepartmentId: localArchive.id,
      targetSigurDepartmentId: null,
      effectiveDate: input.effectiveDate ?? addDaysIso(input.dismissalDate, 1),
      dismissalDate: input.dismissalDate,
      sigurMoveRequired: hasSigur && input.sigurSteps === 'full',
      sigurAccessRequired: hasSigur,
      createdBy: input.createdBy,
    });
  });
}

export interface IOpenRehireInput {
  employeeId: number;
  targetDepartmentId: string;
  targetSigurDepartmentId: number | null;
  createdBy: string | null;
}

/**
 * Открывает операцию восстановления ДО обращения к Sigur. Повторный запрос при уже
 * открытой rehire-операции с тем же отделом продолжает её; с другим отделом — 409.
 */
export async function openRehireOperation(input: IOpenRehireInput): Promise<ILifecycleOperation> {
  return withTransaction(async (client) => {
    const emp = await lockEmployee(client, input.employeeId);
    if (!emp) throw new LifecycleOperationError(404, 'Employee not found', 'NOT_FOUND');

    const pending = await findPendingOperation(client, input.employeeId);
    if (pending) {
      if (pending.kind === 'rehire' && pending.target_department_id === input.targetDepartmentId) {
        return pending;
      }
      if (pending.kind === 'rehire') {
        throw new LifecycleOperationError(
          409,
          'Восстановление в другой отдел уже выполняется — дождитесь завершения или повторите с тем же отделом',
          'OPERATION_IN_PROGRESS',
        );
      }
      throw new LifecycleOperationError(409, 'Увольнение сотрудника ещё применяется — повторите позже', 'OPERATION_IN_PROGRESS');
    }

    if (emp.employment_status !== 'fired') {
      throw new LifecycleOperationError(409, 'Сотрудник не уволен', 'NOT_FIRED');
    }

    const hasSigur = emp.sigur_employee_id != null;
    return insertOperation(client, {
      employeeId: input.employeeId,
      kind: 'rehire',
      source: 'manual',
      baseRevision: emp.lifecycle_revision,
      sigurEmployeeId: emp.sigur_employee_id,
      fromDepartmentId: emp.org_department_id,
      targetDepartmentId: input.targetDepartmentId,
      targetSigurDepartmentId: input.targetSigurDepartmentId,
      effectiveDate: moscowTodayIso(),
      dismissalDate: emp.dismissal_date,
      sigurMoveRequired: hasSigur,
      sigurAccessRequired: hasSigur,
      createdBy: input.createdBy,
    });
  });
}

export interface IOpenRepairInput {
  employeeId: number;
  targetDepartmentId: string;
  targetSigurDepartmentId: number;
  createdBy: string | null;
}

/**
 * Durable-компенсация: активный сотрудник, чья карточка в Sigur оказалась в архиве
 * (перенос fired→archive обогнал rehire). Возвращает null, если у сотрудника уже есть
 * pending-операция — её исполнитель сам доведёт карточку до цели.
 */
export async function openRepairOperation(input: IOpenRepairInput): Promise<ILifecycleOperation | null> {
  return withTransaction(async (client) => {
    const emp = await lockEmployee(client, input.employeeId);
    if (!emp || emp.employment_status !== 'active' || emp.sigur_employee_id == null) return null;
    const pending = await findPendingOperation(client, input.employeeId);
    if (pending) return null;
    return insertOperation(client, {
      employeeId: input.employeeId,
      kind: 'repair_sigur',
      source: 'sigur_compensation',
      baseRevision: emp.lifecycle_revision,
      sigurEmployeeId: emp.sigur_employee_id,
      fromDepartmentId: emp.org_department_id,
      targetDepartmentId: input.targetDepartmentId,
      targetSigurDepartmentId: input.targetSigurDepartmentId,
      effectiveDate: moscowTodayIso(),
      dismissalDate: null,
      sigurMoveRequired: true,
      sigurAccessRequired: false,
      createdBy: input.createdBy,
    });
  });
}

/**
 * Pending rehire, чью карточку наш batchMove успел вернуть в архив: сбросить шаг PUT —
 * исполнитель операции повторит перенос в цель операции.
 */
export async function resetPendingRehireSigurMove(operationId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `UPDATE employee_lifecycle_operations
        SET sigur_moved = false, updated_at = now()
      WHERE id = $1 AND status = 'pending' AND kind = 'rehire'
      RETURNING id`,
    [operationId],
  );
  return row != null;
}

// ─── Lease и исполнение ───

export async function acquireLease(operationId: string, owner: string): Promise<ILifecycleOperation | null> {
  const row = await queryOne<ILifecycleOperation>(
    `UPDATE employee_lifecycle_operations
        SET lease_owner = $2,
            lease_expires_at = now() + ($3 || ' minutes')::interval,
            attempts = attempts + 1,
            updated_at = now()
      WHERE id = $1
        AND status = 'pending'
        AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at < now())
      RETURNING ${OPERATION_COLUMNS}`,
    [operationId, owner, String(LIFECYCLE_LEASE_MINUTES)],
  );
  return row ?? null;
}

type TStepPatch = Partial<Pick<ILifecycleOperation,
  | 'sigur_moved' | 'sigur_access_toggled' | 'sigur_detached'
  | 'sigur_move_required' | 'sigur_access_required'
  | 'target_sigur_department_id' | 'target_department_id'
>>;

/** Запись шага под lease: 0 строк — lease перехвачен, дальше идти нельзя. */
async function writeStep(op: ILifecycleOperation, owner: string, patch: TStepPatch): Promise<void> {
  const keys = Object.keys(patch) as (keyof TStepPatch)[];
  if (keys.length === 0) return;
  const setParts: string[] = [];
  const params: unknown[] = [];
  for (const key of keys) {
    params.push(patch[key]);
    setParts.push(`${key} = $${params.length}`);
  }
  params.push(op.id, owner);
  const row = await queryOne<{ id: string }>(
    `UPDATE employee_lifecycle_operations
        SET ${setParts.join(', ')}, updated_at = now()
      WHERE id = $${params.length - 1} AND lease_owner = $${params.length} AND status = 'pending'
      RETURNING id`,
    params,
  );
  if (!row) throw new LeaseLostError(op.id);
  Object.assign(op, patch);
}

async function recordFailure(op: ILifecycleOperation, owner: string, error: unknown): Promise<void> {
  try {
    await execute(
      `UPDATE employee_lifecycle_operations
          SET last_error = $3, updated_at = now()
        WHERE id = $1 AND lease_owner = $2 AND status = 'pending'`,
      [op.id, owner, errorText(error).slice(0, 2000)],
    );
  } catch (writeErr) {
    console.error(`[lifecycle-ops] failed to record error for ${op.id}:`, writeErr);
  }
  if (op.attempts >= LIFECYCLE_MAX_ATTEMPTS_ALERT) {
    Sentry.captureMessage(`lifecycle operation ${op.id} (${op.kind}, employee ${op.employee_id}) stuck after ${op.attempts} attempts`, {
      level: 'error',
      tags: { service: 'lifecycle-ops', kind: op.kind },
      extra: { operationId: op.id, employeeId: op.employee_id, lastError: errorText(error) },
    });
  }
}

/**
 * CAS по сотруднику не прошёл. Если событие с этим operation_id уже есть — операцию
 * успешно финализировал параллельный исполнитель: считаем applied. Иначе состояние
 * сотрудника изменили в обход операций (ручной SQL) — cancelled + Sentry.
 */
async function resolveCasConflict(
  client: PoolClient,
  op: ILifecycleOperation,
  owner: string,
): Promise<'applied_elsewhere' | 'cancelled'> {
  const evt = await client.query<{ id: string }>(
    `SELECT id FROM employee_dismissal_events WHERE operation_id = $1 LIMIT 1`,
    [op.id],
  );
  if ((evt.rowCount ?? 0) > 0) return 'applied_elsewhere';
  await client.query(
    `UPDATE employee_lifecycle_operations
        SET status = 'cancelled', last_error = $3, lease_owner = NULL, updated_at = now()
      WHERE id = $1 AND lease_owner = $2 AND status = 'pending'`,
    [op.id, owner, `lifecycle_revision mismatch: expected ${op.base_revision}`],
  );
  Sentry.captureMessage(`lifecycle operation ${op.id} cancelled: revision mismatch`, {
    level: 'warning',
    tags: { service: 'lifecycle-ops', kind: op.kind },
    extra: { operationId: op.id, employeeId: op.employee_id, baseRevision: op.base_revision },
  });
  return 'cancelled';
}

async function markApplied(client: PoolClient, op: ILifecycleOperation, owner: string): Promise<void> {
  const res = await client.query(
    `UPDATE employee_lifecycle_operations
        SET status = 'applied', applied_at = now(), lease_owner = NULL, last_error = NULL, updated_at = now()
      WHERE id = $1 AND lease_owner = $2 AND status = 'pending'`,
    [op.id, owner],
  );
  if (res.rowCount === 0) throw new LeaseLostError(op.id);
}

async function loadEmployeeRow(employeeId: number): Promise<EmployeeEncrypted | null> {
  return queryOne<EmployeeEncrypted>(
    `SELECT ${EMPLOYEE_LIFECYCLE_COLUMNS} FROM employees WHERE id = $1`,
    [employeeId],
  );
}

function isSigurNotFound(error: unknown): boolean {
  return error instanceof AxiosError && error.response?.status === 404;
}

async function runDismiss(op: ILifecycleOperation, owner: string, connection?: ConnectionType): Promise<EmployeeEncrypted> {
  if (op.sigur_employee_id != null && (op.sigur_move_required || op.sigur_access_required)) {
    if (!(await sigurService.isConfigured())) {
      throw new LifecycleOperationError(503, 'Sigur не настроен', 'SIGUR_NOT_CONFIGURED');
    }
    try {
      if (op.sigur_move_required && !op.sigur_moved) {
        const archive = await ensureArchiveSigurDepartment(op.created_by, connection);
        await writeStep(op, owner, {
          target_sigur_department_id: archive.sigurDepartmentId,
          target_department_id: archive.localDepartmentId || op.target_department_id,
        });
        await sigurService.updateEmployee(op.sigur_employee_id, { departmentId: archive.sigurDepartmentId }, connection);
        await writeStep(op, owner, { sigur_moved: true });
      }
      if (op.sigur_access_required && !op.sigur_access_toggled) {
        await sigurService.blockEmployee(op.sigur_employee_id, connection);
        await writeStep(op, owner, { sigur_access_toggled: true });
      }
    } catch (error) {
      if (error instanceof LeaseLostError || error instanceof LifecycleOperationError) throw error;
      const moved = op.sigur_moved;
      throw new DismissalSigurError(
        (moved
          ? 'Сотрудник уже перемещён в архивный отдел Sigur, но блокировка не выполнена. Операция сохранена и будет повторена автоматически'
          : 'Не удалось выполнить увольнение сотрудника в Sigur. Операция сохранена и будет повторена автоматически')
        + ` (${errorText(error)})`,
        moved ? 502 : 500,
        moved ? 'SIGUR_PARTIAL_FAILURE' : 'SIGUR_WRITE_FAILED',
        moved,
        op.sigur_access_toggled,
      );
    }
  }

  if (op.from_department_id && op.from_department_id !== op.target_department_id) {
    await employeeChangesService.changeDepartment(op.employee_id, op.target_department_id, {
      reason: 'Увольнение — перевод в папку "Уволенные"',
      lockDepartment: false,
      createdBy: op.created_by,
      effectiveDate: op.effective_date,
      forceHistory: true,
      skipIfScheduledToTarget: true,
    });
  }

  await deactivateAllDepartmentAccessForEmployee(op.employee_id);

  const dismissalDate = op.dismissal_date ?? op.effective_date;
  const exclusionDate = addDaysIso(dismissalDate, 1);

  const result = await withTransaction<EmployeeEncrypted | 'applied_elsewhere'>(async (client) => {
    const updated = await client.query<EmployeeEncrypted>(
      `UPDATE employees
          SET employment_status = 'fired',
              org_department_id = $1,
              department_locked = false,
              dismissal_date = $2,
              excluded_from_timesheet = true,
              excluded_from_timesheet_date = $3,
              dismissal_apply_started_at = NULL,
              lifecycle_revision = lifecycle_revision + 1,
              updated_at = now()
        WHERE id = $4
          AND employment_status = 'active'
          AND lifecycle_revision = $5
      RETURNING ${EMPLOYEE_LIFECYCLE_COLUMNS}`,
      [op.target_department_id, dismissalDate, exclusionDate, op.employee_id, op.base_revision],
    );
    const row = updated.rows[0] ?? null;
    if (!row) {
      const outcome = await resolveCasConflict(client, op, owner);
      if (outcome === 'applied_elsewhere') return 'applied_elsewhere';
      throw new LifecycleOperationError(409, 'Состояние сотрудника изменилось — увольнение не применено', 'STATE_CHANGED');
    }
    await client.query(
      `INSERT INTO employee_dismissal_events
         (employee_id, dismissal_date, scheduled, cancelled, rehired, applied_from_scheduled,
          prev_date, reason, created_by, from_department_id, operation_id)
       VALUES ($1, $2, false, false, false, $3, NULL, NULL, $4, $5, $6)`,
      [op.employee_id, dismissalDate, op.source === 'scheduler', op.created_by, op.from_department_id, op.id],
    );
    await markApplied(client, op, owner);
    return row;
  });

  employeeCache.invalidate(op.employee_id);
  if (result === 'applied_elsewhere') {
    const row = await loadEmployeeRow(op.employee_id);
    if (!row) throw new LifecycleOperationError(404, 'Employee not found', 'NOT_FOUND');
    return row;
  }
  return result;
}

async function runRehire(op: ILifecycleOperation, owner: string, connection?: ConnectionType): Promise<EmployeeEncrypted> {
  if (op.sigur_employee_id != null && (op.sigur_move_required || op.sigur_access_required)) {
    if (!(await sigurService.isConfigured())) {
      throw new LifecycleOperationError(503, 'Sigur не настроен', 'SIGUR_NOT_CONFIGURED');
    }
    if (op.target_sigur_department_id == null) {
      throw new LifecycleOperationError(409, 'У выбранного отдела нет привязки к Sigur', 'SIGUR_DEPARTMENT_MISSING');
    }
    if (op.sigur_move_required && !op.sigur_moved) {
      try {
        await sigurService.updateEmployee(op.sigur_employee_id, { departmentId: op.target_sigur_department_id }, connection);
        await writeStep(op, owner, { sigur_moved: true });
      } catch (error) {
        if (!isSigurNotFound(error)) throw error;
        // 404: карточка удалена в Sigur или удалён отдел. Отдел жив → отвязываем сотрудника
        // и восстанавливаем локально; иначе — ошибка наружу, операция ждёт синка структуры.
        let departmentAlive = false;
        try {
          await sigurService.getDepartmentById(op.target_sigur_department_id, connection);
          departmentAlive = true;
        } catch (probeErr) {
          console.warn('[lifecycle-ops] rehire: department probe failed', {
            operationId: op.id, sigurDepartmentId: op.target_sigur_department_id, message: errorText(probeErr),
          });
        }
        if (!departmentAlive) {
          throw new LifecycleOperationError(
            409,
            `Sigur вернул 404: вероятно, отдел (sigur_department_id=${op.target_sigur_department_id}) удалён в Sigur. Запустите синхронизацию структуры и повторите восстановление.`,
            'SIGUR_DEPARTMENT_MISSING',
          );
        }
        console.warn('[lifecycle-ops] rehire: auto-detach sigur_employee_id', {
          operationId: op.id, employeeId: op.employee_id, sigurEmployeeId: op.sigur_employee_id,
        });
        await writeStep(op, owner, { sigur_detached: true, sigur_move_required: false, sigur_access_required: false });
      }
    }
    if (op.sigur_access_required && !op.sigur_access_toggled) {
      await sigurService.unblockEmployee(op.sigur_employee_id, connection);
      await writeStep(op, owner, { sigur_access_toggled: true });
    }
    // Выгрузка сотрудников в памяти могла быть снята до переноса — синк не должен
    // увидеть карточку в архиве уже после восстановления.
    sigurService.invalidateEmployeeCache();
    if (!op.sigur_detached) {
      await syncLinkedEmployeeFromSigur(op.employee_id, connection);
    }
  }

  await employeeChangesService.changeDepartment(op.employee_id, op.target_department_id, {
    reason: op.sigur_detached
      ? 'Восстановление (отвязка от Sigur — сотрудник удалён в Sigur)'
      : 'Восстановление на работу',
    lockDepartment: op.sigur_detached,
    createdBy: op.created_by,
    effectiveDate: op.effective_date,
    forceHistory: true,
    skipIfScheduledToTarget: true,
  });

  await upsertTechnicalDepartmentAccess(
    op.employee_id,
    op.target_department_id,
    null,
    op.sigur_employee_id != null && !op.sigur_detached ? 'sigur_sync' : 'portal_lifecycle',
  );

  const result = await withTransaction<EmployeeEncrypted | 'applied_elsewhere'>(async (client) => {
    const updated = await client.query<EmployeeEncrypted>(
      `UPDATE employees
          SET employment_status = 'active',
              org_department_id = $1,
              department_locked = $2,
              sigur_employee_id = CASE WHEN $2 THEN NULL ELSE sigur_employee_id END,
              dismissal_date = NULL,
              dismissal_apply_started_at = NULL,
              excluded_from_timesheet = false,
              excluded_from_timesheet_date = NULL,
              lifecycle_revision = lifecycle_revision + 1,
              updated_at = now()
        WHERE id = $3
          AND employment_status = 'fired'
          AND lifecycle_revision = $4
      RETURNING ${EMPLOYEE_LIFECYCLE_COLUMNS}`,
      [op.target_department_id, op.sigur_detached, op.employee_id, op.base_revision],
    );
    const row = updated.rows[0] ?? null;
    if (!row) {
      const outcome = await resolveCasConflict(client, op, owner);
      if (outcome === 'applied_elsewhere') return 'applied_elsewhere';
      throw new LifecycleOperationError(409, 'Состояние сотрудника изменилось — восстановление не применено', 'STATE_CHANGED');
    }
    await client.query(
      `INSERT INTO employee_dismissal_events
         (employee_id, dismissal_date, scheduled, cancelled, rehired, applied_from_scheduled,
          prev_date, reason, created_by, from_department_id, operation_id)
       VALUES ($1, $2, false, false, true, false, $3, NULL, $4, NULL, $5)`,
      [op.employee_id, op.dismissal_date ?? op.effective_date, op.dismissal_date, op.created_by, op.id],
    );
    await markApplied(client, op, owner);
    return row;
  });

  employeeCache.invalidate(op.employee_id);
  if (result === 'applied_elsewhere') {
    const row = await loadEmployeeRow(op.employee_id);
    if (!row) throw new LifecycleOperationError(404, 'Employee not found', 'NOT_FOUND');
    return row;
  }
  return result;
}

async function runRepair(op: ILifecycleOperation, owner: string, connection?: ConnectionType): Promise<EmployeeEncrypted> {
  if (op.sigur_employee_id == null || op.target_sigur_department_id == null) {
    throw new LifecycleOperationError(409, 'repair_sigur: нет карточки или целевого отдела Sigur', 'STATE_CHANGED');
  }
  if (!op.sigur_moved) {
    await sigurService.updateEmployee(op.sigur_employee_id, { departmentId: op.target_sigur_department_id }, connection);
    await writeStep(op, owner, { sigur_moved: true });
  }
  sigurService.invalidateEmployeeCache();

  const archiveDeptId = (await settingsService.getSigurConnectionSettings()).archiveDepartmentId ?? null;
  const probe = await probeSigurCard(op.sigur_employee_id, archiveDeptId, connection);
  if (probe.state !== 'working') {
    throw new Error(`repair_sigur: карточка ещё не в рабочем отделе (${probe.state})`);
  }

  const result = await withTransaction<EmployeeEncrypted | 'applied_elsewhere'>(async (client) => {
    const updated = await client.query<EmployeeEncrypted>(
      `UPDATE employees
          SET lifecycle_revision = lifecycle_revision + 1, updated_at = now()
        WHERE id = $1 AND employment_status = 'active' AND lifecycle_revision = $2
      RETURNING ${EMPLOYEE_LIFECYCLE_COLUMNS}`,
      [op.employee_id, op.base_revision],
    );
    const row = updated.rows[0] ?? null;
    if (!row) {
      // У repair нет события истории: любое изменение версии = кто-то другой уже владеет
      // состоянием (rehire/dismiss через операции) — отменяем без шума.
      await client.query(
        `UPDATE employee_lifecycle_operations
            SET status = 'cancelled', last_error = 'revision changed', lease_owner = NULL, updated_at = now()
          WHERE id = $1 AND lease_owner = $2 AND status = 'pending'`,
        [op.id, owner],
      );
      return 'applied_elsewhere';
    }
    await markApplied(client, op, owner);
    return row;
  });

  employeeCache.invalidate(op.employee_id);
  if (result === 'applied_elsewhere') {
    const row = await loadEmployeeRow(op.employee_id);
    if (!row) throw new LifecycleOperationError(404, 'Employee not found', 'NOT_FOUND');
    return row;
  }
  return result;
}

/**
 * Выполняет операцию под уже захваченным lease. Ошибка шага сохраняется в last_error,
 * операция остаётся pending (повтор по lease); исключение уходит вызывающему.
 * Потеря lease — тихий выход (операцию довёл другой исполнитель).
 */
export async function runOperation(
  op: ILifecycleOperation,
  owner: string,
  connection?: ConnectionType,
): Promise<{ employee: EmployeeEncrypted | null; outcome: 'applied' | 'lease_lost' }> {
  try {
    let employee: EmployeeEncrypted;
    if (op.kind === 'dismiss') employee = await runDismiss(op, owner, connection);
    else if (op.kind === 'rehire') employee = await runRehire(op, owner, connection);
    else employee = await runRepair(op, owner, connection);
    console.log(`[lifecycle-ops] applied ${op.kind} op=${op.id} employee=${op.employee_id} source=${op.source} attempts=${op.attempts}`);
    return { employee, outcome: 'applied' };
  } catch (error) {
    if (error instanceof LeaseLostError) {
      console.warn(`[lifecycle-ops] ${error.message} — другой исполнитель довёл операцию`);
      return { employee: null, outcome: 'lease_lost' };
    }
    await recordFailure(op, owner, error);
    throw error;
  }
}

/** acquireLease + runOperation. 409, если операцию уже выполняет другой исполнитель. */
export async function executeOperation(
  operation: ILifecycleOperation,
  connection?: ConnectionType,
): Promise<EmployeeEncrypted> {
  const owner = newLeaseOwner();
  const leased = await acquireLease(operation.id, owner);
  if (!leased) {
    throw new LifecycleOperationError(409, 'Операция уже выполняется — повторите позже', 'OPERATION_IN_PROGRESS');
  }
  const { employee, outcome } = await runOperation(leased, owner, connection);
  if (outcome === 'lease_lost' || !employee) {
    const row = await loadEmployeeRow(operation.employee_id);
    if (!row) throw new LifecycleOperationError(404, 'Employee not found', 'NOT_FOUND');
    return row;
  }
  return employee;
}

/**
 * Повтор бесхозных/просроченных операций — из тика dismissal-scheduler.
 * Каждая операция — под своим lease; ошибки не прерывают обход.
 */
export async function resumeExpiredOperations(limit = 50): Promise<{ resumed: number; applied: number; failed: number }> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM employee_lifecycle_operations
      WHERE status = 'pending'
        AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at < now())
      ORDER BY created_at
      LIMIT $1`,
    [limit],
  );
  let resumed = 0;
  let applied = 0;
  let failed = 0;
  for (const row of rows ?? []) {
    const owner = newLeaseOwner();
    const op = await acquireLease(row.id, owner);
    if (!op) continue;
    resumed += 1;
    try {
      const { outcome } = await runOperation(op, owner);
      if (outcome === 'applied') applied += 1;
    } catch (error) {
      failed += 1;
      console.error(`[lifecycle-ops] resume failed op=${op.id} kind=${op.kind} employee=${op.employee_id}:`, errorText(error));
    }
  }
  if (resumed > 0) {
    console.log(`[lifecycle-ops] resumed=${resumed} applied=${applied} failed=${failed}`);
  }
  return { resumed, applied, failed };
}

// ─── Гарды для синка ───

export interface ILifecycleGuard {
  employee_id: number;
  employment_status: string;
  lifecycle_revision: number;
  pending_kind: TLifecycleOperationKind | null;
  pending_operation_id: string | null;
  pending_target_sigur_department_id: number | null;
  last_rehire_applied_at: string | null;
  last_rehire_target_department_id: string | null;
  last_rehire_target_sigur_department_id: number | null;
  absence_revision: number | null;
  absence_first_seen_at: string | null;
  absence_strikes: number | null;
}

export async function getLifecycleGuards(employeeIds: number[]): Promise<Map<number, ILifecycleGuard>> {
  const result = new Map<number, ILifecycleGuard>();
  const ids = Array.from(new Set(employeeIds.filter(id => Number.isFinite(id))));
  if (ids.length === 0) return result;
  const rows = await query<ILifecycleGuard>(
    `SELECT e.id AS employee_id, e.employment_status, e.lifecycle_revision,
            p.kind AS pending_kind, p.id AS pending_operation_id,
            p.target_sigur_department_id AS pending_target_sigur_department_id,
            r.applied_at::text AS last_rehire_applied_at,
            r.target_department_id AS last_rehire_target_department_id,
            r.target_sigur_department_id AS last_rehire_target_sigur_department_id,
            m.lifecycle_revision AS absence_revision,
            m.first_seen_at::text AS absence_first_seen_at,
            m.strikes AS absence_strikes
       FROM employees e
       LEFT JOIN employee_lifecycle_operations p
         ON p.employee_id = e.id AND p.status = 'pending'
       LEFT JOIN LATERAL (
         SELECT o.applied_at, o.target_department_id, o.target_sigur_department_id
           FROM employee_lifecycle_operations o
          WHERE o.employee_id = e.id AND o.kind = 'rehire' AND o.status = 'applied'
          ORDER BY o.applied_at DESC
          LIMIT 1
       ) r ON true
       LEFT JOIN employee_sigur_absence_marks m ON m.employee_id = e.id
      WHERE e.id = ANY($1::bigint[])`,
    [ids],
  );
  for (const row of rows ?? []) {
    result.set(Number(row.employee_id), {
      ...row,
      employee_id: Number(row.employee_id),
      lifecycle_revision: Number(row.lifecycle_revision),
    });
  }
  return result;
}

/**
 * true — синку нельзя увольнять/переносить сотрудника: незавершённая операция (без срока)
 * либо недавнее восстановление (REHIRE_GRACE_MINUTES — лаг Sigur между PUT и выгрузкой).
 */
export function isLifecycleProtected(guard: ILifecycleGuard | undefined, now: Date = new Date()): boolean {
  if (!guard) return false;
  if (guard.pending_kind != null) return true;
  if (guard.last_rehire_applied_at) {
    const appliedAt = new Date(guard.last_rehire_applied_at).getTime();
    if (Number.isFinite(appliedAt) && now.getTime() - appliedAt < REHIRE_GRACE_MINUTES * 60_000) return true;
  }
  return false;
}

// ─── Точечная проба карточки Sigur ───

export type TSigurCardState = 'working' | 'archived' | 'deleted' | 'unknown';

export interface ISigurCardProbe {
  state: TSigurCardState;
  departmentId: number | null;
  error?: string;
}

/**
 * Свежее состояние карточки, минуя постраничную выгрузку (offset-пагинация без сортировки
 * теряет карточки на границах страниц). Исходы определены явно: только 'deleted' (404)
 * разрешает auto-fire, только 'archived' — увольнение по архивной папке; 'unknown'
 * (timeout/5xx/невалидное тело) — консервативный skip.
 */
export async function probeSigurCard(
  sigurEmployeeId: number,
  archiveDepartmentId: number | null,
  connection?: ConnectionType,
): Promise<ISigurCardProbe> {
  try {
    const raw = await sigurService.getEmployeeById(sigurEmployeeId, connection);
    if (!raw || typeof raw !== 'object') {
      return { state: 'unknown', departmentId: null, error: 'empty body' };
    }
    const card = normalizeEmployee(raw as Record<string, unknown>);
    if (card.id !== sigurEmployeeId) {
      return { state: 'unknown', departmentId: null, error: `unexpected id ${String(card.id)}` };
    }
    const departmentId = card.departmentId ?? null;
    if (archiveDepartmentId != null && departmentId === archiveDepartmentId) {
      return { state: 'archived', departmentId };
    }
    return { state: 'working', departmentId };
  } catch (error) {
    if (isSigurNotFound(error)) return { state: 'deleted', departmentId: null };
    return { state: 'unknown', departmentId: null, error: errorText(error) };
  }
}

/** Ограниченный параллелизм для точечных проб (кандидатов может быть до 5 % активных). */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}
