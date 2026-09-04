import { Response } from 'express';
import { AxiosError } from 'axios';
import * as Sentry from '@sentry/node';
import type { PoolClient } from 'pg';
import { query, queryOne, execute, withTransaction } from '../config/postgres.js';
import { auditService } from '../services/audit.service.js';
import { loadEmployeeFullName } from '../services/audit-context.helpers.js';
import { DomainValidationError, employeeChangesService } from '../services/employee-changes.service.js';
import { loadStructureCache, decryptEmployee } from '../services/employee-mapper.service.js';
import { employeeCache } from '../services/employee-cache.service.js';
import { isProtectedArchiveDepartment } from '../services/employee-archive-department.service.js';
import { syncLinkedEmployeeFromSigur } from '../services/sigur-linked-employees.service.js';
import { sigurService } from '../services/sigur.service.js';
import type { AuthenticatedRequest, EmployeeEncrypted } from '../types/index.js';
import {
  canAccessDepartmentInScope,
  canAccessEmployeeInScope,
  resolveRequestDataScope,
} from '../services/data-scope.service.js';
import { upsertTechnicalDepartmentAccess } from '../services/employee-department-access.service.js';
import {
  DismissalSigurError,
  EMPLOYEE_LIFECYCLE_COLUMNS,
  executeOperation,
  openDismissOperation,
  openRehireOperation,
  type TLifecycleOperationSource,
} from '../services/employee-lifecycle-operations.service.js';
import { emitDomainChange } from '../services/realtime-broadcast.service.js';
import { getEmployeeOwnerAndSupervisor, getUserIdsByEmployeeIds } from '../services/recipients.service.js';
import { DISMISSAL_CUTOFF_HM, getMoscowDismissalTiming } from '../utils/date.utils.js';

async function emitEmployeeChanged(employeeId: number, action: string): Promise<void> {
  try {
    const recipients = await getEmployeeOwnerAndSupervisor(employeeId);
    if (recipients.length === 0) return;
    emitDomainChange({
      event: 'employee:changed',
      targetUserIds: recipients,
      payload: { entityId: employeeId, employeeId, action },
    });
  } catch (e) {
    console.error('[employee-lifecycle] emit realtime error:', e);
  }
}

async function emitEmployeeChangedBatch(employeeIds: number[], action: string): Promise<void> {
  try {
    const recipients = await getUserIdsByEmployeeIds(employeeIds);
    if (recipients.length === 0) return;
    emitDomainChange({
      event: 'employee:changed',
      targetUserIds: recipients,
      payload: { action },
    });
  } catch (e) {
    console.error('[employee-lifecycle] emit batch realtime error:', e);
  }
}

// EMPLOYEE_LIFECYCLE_COLUMNS — в employee-lifecycle-operations.service (общий с исполнителем операций).

interface IHttpError extends Error {
  status?: number;
  code?: string;
}

export interface ITargetDepartmentRow {
  id: string;
  sigur_department_id: number | null;
  name: string;
}

function createHttpError(status: number, message: string, code?: string): IHttpError {
  const error = new Error(message) as IHttpError;
  error.status = status;
  error.code = code;
  return error;
}

export function getHttpErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const status = 'status' in error ? Number(error.status) : Number.NaN;
  return Number.isFinite(status) ? status : null;
}

export function getHttpErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}

export function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>;
    const parts = [e.message, e.details, e.hint, e.code].filter(v => typeof v === 'string' && v);
    if (parts.length > 0) return parts.join(' | ');
    try { return JSON.stringify(error); } catch { return fallback; }
  }
  return typeof error === 'string' && error ? error : fallback;
}

/**
 * Триггер ensure_no_overlapping_employee_assignments (миграция 020) кидает
 * "Overlapping employee_assignments period for employee_id=...". Корневой путь
 * (слепой INSERT с hire_date) закрыт в коммите 6d96c6f, но остаточные
 * пересечения возможны на грязных исторических данных. Это data-condition,
 * а не краш сервера: отвечаем 409 с понятным текстом и НЕ шумим в Sentry.
 */
function isOverlappingAssignmentError(error: unknown): boolean {
  return getErrorMessage(error, '').includes('Overlapping employee_assignments period');
}

export async function loadEmployeeLifecycleRow(employeeId: number): Promise<EmployeeEncrypted | null> {
  const data = await queryOne<EmployeeEncrypted>(
    `SELECT ${EMPLOYEE_LIFECYCLE_COLUMNS} FROM employees WHERE id = $1`,
    [employeeId],
  );
  return data;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export { DismissalSigurError };

interface IInsertDismissalHistoryOpts {
  scheduled: boolean;
  createdBy: string | null;
  cancelled?: boolean;
  rehired?: boolean;
  appliedFromScheduled?: boolean;
  prevDate?: string | null;
  reason?: string | null;
  /** Отдел, в котором сотрудник работал на момент увольнения (до перевода в «Уволенные»). */
  fromDepartmentId?: string | null;
}

export async function insertDismissalHistory(
  employeeId: number,
  dismissalDate: string,
  opts: IInsertDismissalHistoryOpts,
  /** Клиент транзакции: событие пишется тем же соединением, что и правка employees. */
  client?: PoolClient,
): Promise<void> {
  const sql = `INSERT INTO employee_dismissal_events
       (employee_id, dismissal_date, scheduled, cancelled, rehired, applied_from_scheduled, prev_date, reason, created_by, from_department_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;
  const params = [
    employeeId,
    dismissalDate,
    opts.scheduled,
    opts.cancelled === true,
    opts.rehired === true,
    opts.appliedFromScheduled === true,
    opts.prevDate ?? null,
    opts.reason ?? null,
    opts.createdBy,
    opts.fromDepartmentId ?? null,
  ];
  if (client) {
    await client.query(sql, params);
    return;
  }
  await execute(sql, params);
}

/**
 * Применяет полное увольнение немедленно через durable-операцию (миграция 261):
 * Sigur перенос в архив + блокировка, закрытие assignments, флаги в employees, событие
 * истории — всё внутри исполнителя операции с идемпотентными шагами и CAS по
 * lifecycle_revision. Используется веткой fire(), dismissal-scheduler-ом и contractor-admin.
 *
 * Claim: планировщик передаёт уже захваченный `claimedAt` — операция открывается без
 * перезахвата (иначе ложный 409). Ручные вызовы claim не передают — CAS-claim берётся
 * при открытии операции, до первого обращения к Sigur; при конфликте бросается 409.
 *
 * Ошибка Sigur: операция остаётся pending и будет повторена планировщиком по lease;
 * наружу — DismissalSigurError с признаками частичного применения.
 * Событие истории пишет операция — вызывающим insertDismissalHistory НЕ нужен.
 */
export async function applyDismissalImmediately(args: {
  employeeId: number;
  existing: EmployeeEncrypted;
  dismissalDate: string;
  userId: string | null;
  connection?: 'external' | 'internal';
  /** Уже захваченный claim (планировщик). Без него операция захватывает claim сама. */
  claimedAt?: string | null;
  source?: TLifecycleOperationSource;
}): Promise<{ employee: EmployeeEncrypted; fromDepartmentId: string | null }> {
  const { employeeId, dismissalDate, userId, connection } = args;
  const source: TLifecycleOperationSource = args.source ?? (args.claimedAt ? 'scheduler' : 'manual');

  const operation = await openDismissOperation({
    employeeId,
    dismissalDate,
    source,
    createdBy: userId,
    connection,
    claimedAt: args.claimedAt ?? null,
    sigurSteps: 'full',
  });

  const employee = await executeOperation(operation, connection);
  return { employee, fromDepartmentId: operation.from_department_id };
}

export async function loadTargetDepartment(id: string): Promise<ITargetDepartmentRow | null> {
  const data = await queryOne<ITargetDepartmentRow>(
    `SELECT id, sigur_department_id, name
       FROM org_departments
      WHERE id = $1 AND is_active = true`,
    [id],
  );
  return data;
}

async function assertDepartmentMoveAllowed(
  req: AuthenticatedRequest,
  targetDepartmentId: string,
): Promise<void> {
  const scope = await resolveRequestDataScope(req);
  if (!scope) {
    throw createHttpError(403, 'Data scope не настроен для роли');
  }

  if (scope === 'self') {
    throw createHttpError(403, 'Недостаточно прав для перевода сотрудников');
  }

  if (scope === 'department' && !(await canAccessDepartmentInScope(req, targetDepartmentId))) {
    throw createHttpError(403, 'Нельзя перевести сотрудника в другой отдел при department scope');
  }
}

export async function moveEmployeeToDepartmentInternal(params: {
  req: AuthenticatedRequest;
  employee: EmployeeEncrypted;
  targetDepartment: ITargetDepartmentRow;
  connection?: 'external' | 'internal';
  reason: string;
  effectiveDate?: string;
}): Promise<'sigur' | 'portal' | 'noop'> {
  const {
    req,
    employee,
    targetDepartment,
    connection,
    reason,
    effectiveDate,
  } = params;

  if (employee.org_department_id === targetDepartment.id) {
    return 'noop';
  }

  if (await isProtectedArchiveDepartment(targetDepartment.id, connection)) {
    throw createHttpError(409, 'Папка "Уволенные" доступна только через сценарий увольнения');
  }

  if (employee.sigur_employee_id) {
    if (!(await sigurService.isConfigured())) {
      throw createHttpError(503, 'Sigur не настроен');
    }

    if (!targetDepartment.sigur_department_id) {
      throw createHttpError(409, 'У выбранного отдела нет привязки к Sigur');
    }

    try {
      await sigurService.updateEmployee(employee.sigur_employee_id, {
        departmentId: targetDepartment.sigur_department_id,
      }, connection);

      await employeeChangesService.changeDepartment(employee.id, targetDepartment.id, {
        reason,
        lockDepartment: false,
        createdBy: req.user.id,
        effectiveDate,
      });

      await upsertTechnicalDepartmentAccess(
        employee.id,
        targetDepartment.id,
        employee.org_department_id || null,
        'sigur_sync',
      );

      await syncLinkedEmployeeFromSigur(employee.id, connection);
    } catch (error) {
      if (error instanceof AxiosError) {
        const status = error.response?.status;
        console.error('[moveDepartment] Sigur error', {
          status,
          url: error.config?.url,
          method: error.config?.method,
          employeeId: employee.id,
          sigurEmployeeId: employee.sigur_employee_id,
          targetSigurDepartmentId: targetDepartment.sigur_department_id,
          responseData: error.response?.data,
          message: error.message,
        });
        if (status === 404) {
          throw createHttpError(
            409,
            `Sigur вернул 404 на ${error.config?.method?.toUpperCase() || 'запросе'} ${error.config?.url || ''}. Вероятно, сотрудник (sigur_employee_id=${employee.sigur_employee_id}) или отдел «${targetDepartment.name}» (sigur_department_id=${targetDepartment.sigur_department_id}) удалены в Sigur. Запустите синхронизацию структуры и попробуйте снова.`,
          );
        }
      }
      throw error;
    }

    return 'sigur';
  }

  await employeeChangesService.changeDepartment(employee.id, targetDepartment.id, {
    reason,
    lockDepartment: true,
    createdBy: req.user.id,
    effectiveDate,
  });

  await upsertTechnicalDepartmentAccess(
    employee.id,
    targetDepartment.id,
    employee.org_department_id || null,
    'portal_lifecycle',
  );

  return 'portal';
}

async function sendUpdatedEmployee(res: Response, employeeId: number): Promise<void> {
  const updatedEmployee = await loadEmployeeLifecycleRow(employeeId);
  if (!updatedEmployee) {
    res.status(404).json({ success: false, error: 'Employee not found' });
    return;
  }

  const structureCache = await loadStructureCache();
  res.json({
    success: true,
    data: decryptEmployee(updatedEmployee, structureCache),
  });
}

export async function fire(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const employeeId = Number(id);
    if (!(await canAccessEmployeeInScope(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }

    const body = req.body as { dismissalDate?: string; connection?: 'external' | 'internal' };
    const dismissalDate = typeof body.dismissalDate === 'string' ? body.dismissalDate.slice(0, 10) : '';
    if (!isIsoDate(dismissalDate)) {
      res.status(400).json({ success: false, error: 'dismissalDate обязательная (формат YYYY-MM-DD)' });
      return;
    }

    const existing = await loadEmployeeLifecycleRow(employeeId);
    if (!existing) {
      res.status(404).json({ success: false, error: 'Employee not found' });
      return;
    }

    if (existing.employment_status === 'fired') {
      res.status(409).json({ success: false, error: 'Сотрудник уже уволен' });
      return;
    }

    if (existing.hire_date && dismissalDate < existing.hire_date) {
      res.status(400).json({ success: false, error: 'Дата увольнения раньше даты найма' });
      return;
    }

    // Календарь Europe/Moscow. Увольнение «на сегодня» откладывается до 23:00 МСК,
    // чтобы сотрудник доработал последний рабочий день с рабочим пропуском:
    // применит dismissal-scheduler. Бэкдейт применяется сразу.
    const { today, cutoffPassed } = getMoscowDismissalTiming();
    const connection = body.connection || undefined;
    const isDeferred = dismissalDate > today || (dismissalDate === today && !cutoffPassed);
    const structureCache = await loadStructureCache();

    if (isDeferred) {
      // CAS + одна транзакция: параллельное увольнение/применение планировщиком
      // не должно разъехаться с событием истории (и наоборот — событие без правки).
      // lifecycle_revision растёт на каждом переходе (миграция 261): решение синка Sigur,
      // принятое по снимку до назначения даты, станет noop по CAS.
      // Повтор с той же датой — идемпотентный noop: без события и без новой версии.
      const outcome = await withTransaction<{ row: EmployeeEncrypted; noop: boolean } | null>(async (client) => {
        const updated = await client.query<EmployeeEncrypted>(
          `UPDATE employees
              SET dismissal_date = $1,
                  lifecycle_revision = lifecycle_revision + 1
            WHERE id = $2
              AND employment_status = 'active'
              AND dismissal_apply_started_at IS NULL
              AND dismissal_date IS DISTINCT FROM $1::date
            RETURNING ${EMPLOYEE_LIFECYCLE_COLUMNS}`,
          [dismissalDate, employeeId],
        );
        const row = updated.rows[0] ?? null;
        if (!row) {
          const same = await client.query<EmployeeEncrypted>(
            `SELECT ${EMPLOYEE_LIFECYCLE_COLUMNS} FROM employees
              WHERE id = $1 AND employment_status = 'active'
                AND dismissal_date = $2::date AND dismissal_apply_started_at IS NULL`,
            [employeeId, dismissalDate],
          );
          const sameRow = same.rows[0] ?? null;
          return sameRow ? { row: sameRow, noop: true } : null;
        }

        await insertDismissalHistory(employeeId, dismissalDate, {
          scheduled: true,
          createdBy: req.user.id,
        }, client);

        return { row, noop: false };
      });

      if (!outcome) {
        res.status(409).json({
          success: false,
          error: 'Сотрудник уже уволен или его увольнение применяется — обновите страницу',
        });
        return;
      }
      if (outcome.noop) {
        res.json({ success: true, data: decryptEmployee(outcome.row, structureCache) });
        return;
      }
      const data = outcome.row;
      employeeCache.invalidate(employeeId);

      await auditService.logFromRequest(req, req.user.id, 'FIRE_EMPLOYEE_SCHEDULED', {
        entityType: 'employee',
        entityId: id,
        details: {
          dismissal_date: dismissalDate,
          source: existing.sigur_employee_id ? 'sigur' : 'portal',
          applies_after: `${DISMISSAL_CUTOFF_HM} MSK`,
        },
      });

      void emitEmployeeChanged(employeeId, 'fire_scheduled');

      res.json({ success: true, data: decryptEmployee(data, structureCache) });
      return;
    }

    try {
      const { employee: data, fromDepartmentId } = await applyDismissalImmediately({
        employeeId,
        existing,
        dismissalDate,
        userId: req.user.id,
        connection,
      });
      employeeCache.invalidate(employeeId);

      // Событие истории записала операция (одной транзакцией с правкой employees).
      await auditService.logFromRequest(req, req.user.id, 'FIRE_EMPLOYEE', {
        entityType: 'employee',
        entityId: id,
        details: {
          source: existing.sigur_employee_id ? 'sigur' : 'portal',
          target_department_id: data.org_department_id,
          from_department_id: fromDepartmentId,
          dismissal_date: dismissalDate,
        },
      });

      void emitEmployeeChanged(employeeId, 'fire');

      res.json({ success: true, data: decryptEmployee(data, structureCache) });
    } catch (innerErr) {
      if (innerErr instanceof DismissalSigurError) {
        await auditService.logFromRequest(req, req.user.id, 'FIRE_EMPLOYEE', {
          entityType: 'employee',
          entityId: id,
          details: {
            source: 'sigur',
            partial_failure: true,
            movedToArchive: innerErr.movedToArchive,
            blocked: innerErr.blocked,
            error: innerErr.message,
          },
        });
        res.status(innerErr.status).json({
          success: false,
          error: innerErr.message,
          code: innerErr.code,
        });
        return;
      }
      const httpStatus = getHttpErrorStatus(innerErr);
      if (httpStatus) {
        res.status(httpStatus).json({
          success: false,
          error: getErrorMessage(innerErr, 'Failed to fire employee'),
          ...(getHttpErrorCode(innerErr) ? { code: getHttpErrorCode(innerErr) } : {}),
        });
        return;
      }
      throw innerErr;
    }
  } catch (error) {
    if (isOverlappingAssignmentError(error)) {
      console.warn('[fire] overlapping assignment periods', { employeeId: req.params.id });
      res.status(409).json({
        success: false,
        error: 'У сотрудника пересекаются периоды назначений (employee_assignments). Исправьте историю назначений и повторите увольнение.',
        code: 'ASSIGNMENT_OVERLAP',
      });
      return;
    }
    console.error('Fire employee error:', error);
    Sentry.captureException(error, {
      tags: { route: 'employees.fire' },
      extra: { employeeId: req.params.id },
    });
    res.status(500).json({
      success: false,
      error: getErrorMessage(error, 'Failed to fire employee'),
    });
  }
}

export async function cancelDismissal(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const employeeId = Number(id);
    if (!(await canAccessEmployeeInScope(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }

    const existing = await loadEmployeeLifecycleRow(employeeId);
    if (!existing) {
      res.status(404).json({ success: false, error: 'Employee not found' });
      return;
    }

    if (existing.employment_status !== 'active' || !existing.dismissal_date) {
      res.status(409).json({ success: false, error: 'У сотрудника нет запланированного увольнения' });
      return;
    }

    const prevDate = existing.dismissal_date;
    // Отмена разрешена, пока планировщик не захватил запись (dismissal_apply_started_at IS NULL).
    // Условие в самом UPDATE — иначе гонка: отмена проходит уже после старта применения.
    const data = await queryOne<EmployeeEncrypted>(
      `UPDATE employees
          SET dismissal_date = NULL,
              lifecycle_revision = lifecycle_revision + 1
        WHERE id = $1
          AND employment_status = 'active'
          AND dismissal_date IS NOT NULL
          AND dismissal_apply_started_at IS NULL
      RETURNING ${EMPLOYEE_LIFECYCLE_COLUMNS}`,
      [employeeId],
    );
    if (!data) {
      res.status(409).json({
        success: false,
        error: 'Увольнение уже применяется или применено. Используйте «Восстановить».',
      });
      return;
    }
    employeeCache.invalidate(employeeId);

    await insertDismissalHistory(employeeId, prevDate, {
      scheduled: true,
      cancelled: true,
      createdBy: req.user.id,
      prevDate,
    });

    await auditService.logFromRequest(req, req.user.id, 'CANCEL_EMPLOYEE_DISMISSAL', {
      entityType: 'employee',
      entityId: id,
      details: { prev_dismissal_date: prevDate },
    });

    void emitEmployeeChanged(employeeId, 'cancel_dismissal');

    const structureCache = await loadStructureCache();
    res.json({ success: true, data: decryptEmployee(data, structureCache) });
  } catch (error) {
    console.error('Cancel dismissal error:', error);
    Sentry.captureException(error, {
      tags: { route: 'employees.cancelDismissal' },
      extra: { employeeId: req.params.id },
    });
    res.status(500).json({
      success: false,
      error: getErrorMessage(error, 'Failed to cancel dismissal'),
    });
  }
}

export async function rehire(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const employeeId = Number(id);
    if (!(await canAccessEmployeeInScope(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }

    const { org_department_id } = req.body as { org_department_id?: string };
    if (!org_department_id) {
      res.status(400).json({ success: false, error: 'org_department_id required' });
      return;
    }

    const connection = (req.body.connection as 'external' | 'internal') || undefined;

    await assertDepartmentMoveAllowed(req, org_department_id);

    const [existing, targetDepartment] = await Promise.all([
      loadEmployeeLifecycleRow(employeeId),
      loadTargetDepartment(org_department_id),
    ]);

    if (!existing) {
      res.status(404).json({ success: false, error: 'Employee not found' });
      return;
    }

    if (!targetDepartment) {
      res.status(400).json({ success: false, error: 'Целевой отдел не найден' });
      return;
    }

    // Только уволенный: повтор на уже активном не должен плодить rehired-события.
    if (existing.employment_status !== 'fired') {
      res.status(409).json({ success: false, error: 'Сотрудник не уволен', code: 'NOT_FIRED' });
      return;
    }

    if (await isProtectedArchiveDepartment(targetDepartment.id, connection)) {
      res.status(409).json({
        success: false,
        error: 'Нельзя восстановить в архивный отдел «Уволенные». Выберите другой отдел.',
      });
      return;
    }

    if (existing.sigur_employee_id) {
      if (!(await sigurService.isConfigured())) {
        res.status(503).json({ success: false, error: 'Sigur не настроен' });
        return;
      }
      if (!targetDepartment.sigur_department_id) {
        res.status(409).json({
          success: false,
          error: 'У выбранного отдела нет привязки к Sigur',
        });
        return;
      }
    }

    // Durable-операция ДО обращения к Sigur: пока она pending, синк Sigur сотрудника не
    // трогает, а crash/ошибка на любом шаге доводится планировщиком. Повторное нажатие
    // с тем же отделом продолжает ту же операцию (см. employee-lifecycle-operations.service).
    const operation = await openRehireOperation({
      employeeId,
      targetDepartmentId: targetDepartment.id,
      targetSigurDepartmentId: targetDepartment.sigur_department_id,
      createdBy: req.user.id,
    });

    let data: EmployeeEncrypted;
    try {
      data = await executeOperation(operation, connection);
    } catch (error) {
      const message = getErrorMessage(error, 'Ошибка Sigur');
      console.error('[rehire] operation step failed', {
        operationId: operation.id,
        employeeId,
        targetDepartmentId: targetDepartment.id,
        message,
      });
      try {
        await auditService.logFromRequest(req, req.user.id, 'REHIRE_EMPLOYEE', {
          entityType: 'employee',
          entityId: id,
          details: {
            operation_id: operation.id,
            target_department_id: targetDepartment.id,
            pending: true,
            error: message,
          },
        });
      } catch (auditErr) {
        console.warn('[rehire] audit log failed (non-critical):', auditErr);
      }
      const status = getHttpErrorStatus(error);
      if (status) {
        res.status(status).json({
          success: false,
          error: message,
          ...(getHttpErrorCode(error) ? { code: getHttpErrorCode(error) } : {}),
        });
        return;
      }
      res.status(502).json({
        success: false,
        error: `Не удалось завершить восстановление: ${message}. Операция сохранена и будет повторена автоматически; можно нажать «Восстановить» ещё раз.`,
        code: 'OPERATION_PENDING',
      });
      return;
    }

    employeeCache.invalidate(id);

    const detachedFromSigur = existing.sigur_employee_id != null && data.sigur_employee_id == null;
    try {
      await auditService.logFromRequest(req, req.user.id, 'REHIRE_EMPLOYEE', {
        entityType: 'employee',
        entityId: id,
        details: {
          source: existing.sigur_employee_id && !detachedFromSigur ? 'sigur' : 'portal',
          target_department_id: targetDepartment.id,
          detached_from_sigur: detachedFromSigur,
          previous_sigur_employee_id: detachedFromSigur ? existing.sigur_employee_id : undefined,
          prev_dismissal_date: existing.dismissal_date ?? null,
          operation_id: operation.id,
        },
      });
    } catch (auditErr) {
      console.warn('[rehire] audit log failed (non-critical):', auditErr);
    }

    void emitEmployeeChanged(employeeId, 'rehire');

    try {
      const structureCache = await loadStructureCache();
      const employee = decryptEmployee(data, structureCache);
      res.json({ success: true, data: employee });
    } catch (decryptErr) {
      console.warn('[rehire] decrypt/structure cache failed, returning raw row:', decryptErr);
      res.json({ success: true, data });
    }
  } catch (error) {
    const status = getHttpErrorStatus(error);
    if (status) {
      res.status(status).json({
        success: false,
        error: getErrorMessage(error, 'Не удалось восстановить сотрудника'),
        ...(getHttpErrorCode(error) ? { code: getHttpErrorCode(error) } : {}),
      });
      return;
    }

    if (isOverlappingAssignmentError(error)) {
      console.warn('[rehire] overlapping assignment periods', { employeeId: req.params.id });
      res.status(409).json({
        success: false,
        error: 'У сотрудника пересекаются периоды назначений (employee_assignments). Исправьте историю назначений и повторите восстановление.',
        code: 'ASSIGNMENT_OVERLAP',
      });
      return;
    }

    const message = getErrorMessage(error, 'Unknown error');
    const stack = error instanceof Error ? error.stack : undefined;
    console.error('[rehire] Unhandled error:', { employeeId: req.params.id, message, stack, error });
    Sentry.captureException(error, {
      tags: { route: 'employees.rehire' },
      extra: { employeeId: req.params.id },
    });
    res.status(500).json({ success: false, error: `Не удалось восстановить сотрудника: ${message}`, detail: message });
  }
}
export async function moveDepartment(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const employeeId = Number(id);
    if (!(await canAccessEmployeeInScope(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }

    const { org_department_id } = req.body as { org_department_id: string };
    if (!org_department_id) {
      res.status(400).json({ success: false, error: 'org_department_id required' });
      return;
    }

    await assertDepartmentMoveAllowed(req, org_department_id);

    const [employeeRow, targetDepartment] = await Promise.all([
      loadEmployeeLifecycleRow(employeeId),
      loadTargetDepartment(org_department_id),
    ]);

    if (!employeeRow) {
      res.status(404).json({ success: false, error: 'Employee not found' });
      return;
    }

    if (!targetDepartment) {
      res.status(400).json({ success: false, error: 'Целевой отдел не найден' });
      return;
    }

    const fromDepartmentId = employeeRow.org_department_id ?? null;
    const fromDepartmentName = fromDepartmentId
      ? (await loadTargetDepartment(fromDepartmentId))?.name ?? null
      : null;

    const connection = (req.body.connection as 'external' | 'internal') || undefined;
    const effectiveDate = typeof req.body.effective_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.effective_date)
      ? req.body.effective_date
      : undefined;
    const customReason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    const source = await moveEmployeeToDepartmentInternal({
      req,
      employee: employeeRow,
      targetDepartment,
      connection,
      reason: customReason || 'Перевод в другой отдел',
      effectiveDate,
    });

    employeeCache.invalidate(id);

    await auditService.logFromRequest(req, req.user.id, 'MOVE_EMPLOYEE_DEPARTMENT', {
      entityType: 'employee',
      entityId: id,
      details: {
        employee_full_name: employeeRow.full_name ?? null,
        from_department_id: fromDepartmentId,
        from_department_name: fromDepartmentName,
        to_department_id: targetDepartment.id,
        to_department_name: targetDepartment.name,
        source: source === 'noop' ? (employeeRow.sigur_employee_id ? 'sigur' : 'portal') : source,
      },
    });

    void emitEmployeeChanged(employeeId, 'transfer');

    await sendUpdatedEmployee(res, employeeId);
  } catch (error) {
    const status = getHttpErrorStatus(error);
    if (status) {
      res.status(status).json({
        success: false,
        error: getErrorMessage(error, 'Failed to move employee'),
        ...(getHttpErrorCode(error) ? { code: getHttpErrorCode(error) } : {}),
      });
      return;
    }

    console.error('Move department error:', error);
    res.status(500).json({ success: false, error: 'Failed to move employee' });
  }
}

export async function batchMoveEmployees(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const {
      employee_ids,
      org_department_id,
      connection,
      effective_date,
      reason: bodyReason,
    } = req.body as {
      employee_ids?: number[];
      org_department_id?: string;
      connection?: 'external' | 'internal';
      effective_date?: string;
      reason?: string;
    };

    const effectiveDate = typeof effective_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(effective_date)
      ? effective_date
      : undefined;
    const customReason = typeof bodyReason === 'string' ? bodyReason.trim() : '';

    const employeeIds = Array.from(
      new Set((employee_ids || []).map(value => Number(value)).filter(value => Number.isFinite(value) && value > 0)),
    );

    if (employeeIds.length === 0) {
      res.status(400).json({ success: false, error: 'employee_ids required' });
      return;
    }

    if (!org_department_id) {
      res.status(400).json({ success: false, error: 'org_department_id required' });
      return;
    }

    await assertDepartmentMoveAllowed(req, org_department_id);

    const targetDepartment = await loadTargetDepartment(org_department_id);
    if (!targetDepartment) {
      res.status(400).json({ success: false, error: 'Целевой отдел не найден' });
      return;
    }

    if (await isProtectedArchiveDepartment(org_department_id, connection)) {
      res.status(409).json({
        success: false,
        error: 'Папка "Уволенные" доступна только через сценарий увольнения',
      });
      return;
    }

    const failures: Array<{ employee_id: number; error: string }> = [];
    const movedIds: number[] = [];
    const skippedIds: number[] = [];

    for (const employeeId of employeeIds) {
      if (!(await canAccessEmployeeInScope(req, employeeId))) {
        failures.push({ employee_id: employeeId, error: 'Нет доступа к сотруднику' });
        continue;
      }

      const employeeRow = await loadEmployeeLifecycleRow(employeeId);
      if (!employeeRow) {
        failures.push({ employee_id: employeeId, error: 'Employee not found' });
        continue;
      }

      const fromDepartmentId = employeeRow.org_department_id ?? null;
      const fromDepartmentName = fromDepartmentId
        ? (await loadTargetDepartment(fromDepartmentId))?.name ?? null
        : null;

      try {
        const source = await moveEmployeeToDepartmentInternal({
          req,
          employee: employeeRow,
          targetDepartment,
          connection,
          reason: customReason || 'Массовый перевод в другой отдел',
          effectiveDate,
        });

        if (source === 'noop') {
          skippedIds.push(employeeId);
          continue;
        }

        movedIds.push(employeeId);
        await auditService.logFromRequest(req, req.user.id, 'MOVE_EMPLOYEE_DEPARTMENT', {
          entityType: 'employee',
          entityId: String(employeeId),
          details: {
            employee_full_name: employeeRow.full_name ?? null,
            from_department_id: fromDepartmentId,
            from_department_name: fromDepartmentName,
            to_department_id: targetDepartment.id,
            to_department_name: targetDepartment.name,
            source,
            batch: true,
          },
        });
      } catch (error) {
        failures.push({
          employee_id: employeeId,
          error: getErrorMessage(error, 'Failed to move employee'),
        });
      }
    }

    if (movedIds.length > 0) {
      void emitEmployeeChangedBatch(movedIds, 'batch_transfer');
    }

    res.json({
      success: true,
      data: {
        target_department_id: org_department_id,
        moved_count: movedIds.length,
        skipped_count: skippedIds.length,
        failed_count: failures.length,
        moved_ids: movedIds,
        skipped_ids: skippedIds,
        failures,
      },
    });
  } catch (error) {
    const status = getHttpErrorStatus(error);
    if (status) {
      res.status(status).json({ success: false, error: getErrorMessage(error, 'Failed to move employees') });
      return;
    }

    console.error('Batch move employees error:', error);
    res.status(500).json({ success: false, error: 'Failed to move employees' });
  }
}

export async function getHistory(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    if (!(await canAccessEmployeeInScope(req, Number(id)))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }

    const emp = await queryOne<{ id: number }>(
      `SELECT id FROM employees WHERE id = $1`,
      [id],
    );
    if (!emp) {
      res.status(404).json({ success: false, error: 'Employee not found' });
      return;
    }

    let data: Record<string, unknown>[];
    try {
      data = await query<Record<string, unknown>>(
        `SELECT * FROM employee_history
          WHERE employee_id = $1
          ORDER BY event_date DESC`,
        [id],
      );
    } catch (historyErr) {
      console.error('Get employee history error:', historyErr);
      res.status(500).json({ success: false, error: 'Failed to fetch history' });
      return;
    }

    const structureCache = await loadStructureCache();

    const events = data.map((row: Record<string, unknown>) => {
      const eventData = row.event_data as Record<string, unknown> || {};
      let decryptedData: Record<string, unknown> = {};

      if (row.event_type === 'salary') {
        decryptedData = {
          salary: eventData.salary ? parseFloat(String(eventData.salary)) : null,
          reason: eventData.reason,
          order_number: eventData.order_number,
          note: eventData.note || null,
        };
      } else if (row.event_type === 'assignment') {
        decryptedData = {
          department: eventData.department_id ? structureCache.departments.get(eventData.department_id as string) || null : null,
          department_id: eventData.department_id,
          position: eventData.position_id ? structureCache.positions.get(eventData.position_id as string) || null : null,
          position_id: eventData.position_id,
          site_id: eventData.site_id,
          is_primary: eventData.is_primary,
          type: eventData.type,
          reason: eventData.reason,
          order_number: eventData.order_number,
        };
      } else if (row.event_type === 'dismissal') {
        decryptedData = {
          dismissal_date: eventData.dismissal_date ?? null,
          scheduled: eventData.scheduled === true,
          cancelled: eventData.cancelled === true,
          rehired: eventData.rehired === true,
          applied_from_scheduled: eventData.applied_from_scheduled === true,
          prev_date: eventData.prev_date ?? null,
          reason: eventData.reason ?? null,
        };
      }

      return {
        employee_id: row.employee_id,
        event_type: row.event_type,
        event_id: row.event_id,
        event_date: row.event_date,
        event_end_date: row.event_end_date,
        event_data: decryptedData,
        created_at: row.created_at,
        created_by: row.created_by,
      };
    });

    res.json({ success: true, data: events });
  } catch (error) {
    console.error('Get employee history error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch history' });
  }
}

export async function updateHistoryEvent(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const employeeId = Number(req.params.id);
    if (!(await canAccessEmployeeInScope(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }

    const eventId = req.params.eventId;
    const eventType = req.body.event_type;
    if (eventType !== 'salary' && eventType !== 'assignment') {
      res.status(400).json({ success: false, error: 'event_type must be "salary" or "assignment"' });
      return;
    }

    if (eventType === 'salary') {
      const historyId = Number(eventId);
      if (!Number.isFinite(historyId)) {
        res.status(400).json({ success: false, error: 'Invalid salary event id' });
        return;
      }
      await employeeChangesService.updateSalaryHistory(historyId, employeeId, {
        salary: req.body.salary,
        effective_date: req.body.effective_date,
        change_reason: req.body.change_reason,
        note: req.body.note,
      });
    } else {
      await employeeChangesService.updateAssignment(eventId, employeeId, {
        position_id: req.body.position_id,
        org_department_id: req.body.org_department_id,
        effective_from: req.body.effective_date,
        change_reason: req.body.change_reason,
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Update history event error:', error);
    const message = error instanceof Error ? error.message : 'Failed to update history event';
    const status = error instanceof DomainValidationError ? 400 : 500;
    res.status(status).json({ success: false, error: message });
  }
}

export async function deleteHistoryEvent(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const employeeId = Number(req.params.id);
    if (!(await canAccessEmployeeInScope(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }

    const eventId = req.params.eventId;
    const eventType = req.query.event_type;
    if (eventType !== 'salary' && eventType !== 'assignment') {
      res.status(400).json({ success: false, error: 'event_type must be "salary" or "assignment"' });
      return;
    }

    if (eventType === 'salary') {
      const historyId = Number(eventId);
      if (!Number.isFinite(historyId)) {
        res.status(400).json({ success: false, error: 'Invalid salary event id' });
        return;
      }
      await employeeChangesService.deleteSalaryHistory(historyId, employeeId);
    } else {
      const { reverted } = await employeeChangesService.deleteAssignment(eventId, employeeId);
      if (reverted) {
        const auditFullName = await loadEmployeeFullName(reverted.employee_id);
        await auditService.logFromRequest(req, req.user.id, 'REVERT_TRANSFER_LOCAL_ONLY', {
          entityType: 'employee',
          entityId: String(reverted.employee_id),
          details: {
            source: 'employee_history',
            employee_id: reverted.employee_id,
            employee_full_name: auditFullName,
            removed_assignment_id: reverted.removed_assignment_id,
            reopened_assignment_id: reverted.reopened_assignment_id,
            restored_department_id: reverted.restored_department_id,
          },
        });
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Delete history event error:', error);
    const message = error instanceof Error ? error.message : 'Failed to delete history event';
    const status = error instanceof DomainValidationError ? 400 : 500;
    res.status(status).json({ success: false, error: message });
  }
}
