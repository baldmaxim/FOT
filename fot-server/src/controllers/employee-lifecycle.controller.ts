import { Response } from 'express';
import { AxiosError } from 'axios';
import * as Sentry from '@sentry/node';
import { query, queryOne, execute } from '../config/postgres.js';
import { auditService } from '../services/audit.service.js';
import { loadEmployeeFullName } from '../services/audit-context.helpers.js';
import { DomainValidationError, employeeChangesService } from '../services/employee-changes.service.js';
import { loadStructureCache, decryptEmployee } from '../services/employee-mapper.service.js';
import { employeeCache } from '../services/employee-cache.service.js';
import {
  assignEmployeesToArchiveDepartment,
  ensureLocalArchiveDepartment,
  isProtectedArchiveDepartment,
} from '../services/employee-archive-department.service.js';
import {
  ensureArchiveSigurDepartment,
  syncLinkedEmployeeFromSigur,
} from '../services/sigur-linked-employees.service.js';
import { sigurService } from '../services/sigur.service.js';
import type { AuthenticatedRequest, EmployeeEncrypted } from '../types/index.js';
import {
  canAccessDepartmentInScope,
  canAccessEmployeeInScope,
  resolveRequestDataScope,
} from '../services/data-scope.service.js';
import {
  upsertTechnicalDepartmentAccess,
  deactivateAllDepartmentAccessForEmployee,
} from '../services/employee-department-access.service.js';

const EMPLOYEE_LIFECYCLE_COLUMNS = 'id, full_name, last_name, first_name, middle_name, current_salary, salary_actual, salary_calculated, staff_units, birth_date, hire_date, country, pension_number, patent_issue_date, patent_expiry_date, email, org_department_id, position_id, sigur_employee_id, tab_number, current_status, permit_expiry_date, registration_cat1, registration_cat4, doc_receipt_date, work_object, employment_status, department_locked, is_archived, archived_at, created_at, updated_at';

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

export async function loadEmployeeLifecycleRow(employeeId: number): Promise<EmployeeEncrypted | null> {
  const data = await queryOne<EmployeeEncrypted>(
    `SELECT ${EMPLOYEE_LIFECYCLE_COLUMNS} FROM employees WHERE id = $1`,
    [employeeId],
  );
  return data;
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

export async function archive(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    if (!(await canAccessEmployeeInScope(req, Number(id)))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }

    const data = await queryOne<EmployeeEncrypted>(
      `UPDATE employees
          SET is_archived = true, archived_at = $1
        WHERE id = $2
      RETURNING ${EMPLOYEE_LIFECYCLE_COLUMNS}`,
      [new Date().toISOString(), id],
    );

    if (!data) {
      res.status(404).json({ success: false, error: 'Employee not found' });
      return;
    }

    await deactivateAllDepartmentAccessForEmployee(Number(id));

    employeeCache.invalidate(id);

    await auditService.logFromRequest(req, req.user.id, 'ARCHIVE_EMPLOYEE', {
      entityType: 'employee',
      entityId: id,
    });

    const structureCache = await loadStructureCache();
    const employee = decryptEmployee(data as EmployeeEncrypted, structureCache);
    res.json({ success: true, data: employee });
  } catch (error) {
    console.error('Archive employee error:', error);
    res.status(500).json({ success: false, error: 'Failed to archive employee' });
  }
}

export async function restore(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    if (!(await canAccessEmployeeInScope(req, Number(id)))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }

    const data = await queryOne<EmployeeEncrypted>(
      `UPDATE employees
          SET is_archived = false, archived_at = NULL
        WHERE id = $1
      RETURNING ${EMPLOYEE_LIFECYCLE_COLUMNS}`,
      [id],
    );

    if (!data) {
      res.status(404).json({ success: false, error: 'Employee not found' });
      return;
    }

    if (data.org_department_id) {
      await upsertTechnicalDepartmentAccess(
        Number(id),
        data.org_department_id as string,
        null,
        data.sigur_employee_id ? 'sigur_sync' : 'portal_lifecycle',
      );
    }

    employeeCache.invalidate(id);

    const structureCache = await loadStructureCache();
    const employee = decryptEmployee(data as EmployeeEncrypted, structureCache);

    await auditService.logFromRequest(req, req.user.id, 'RESTORE_EMPLOYEE', {
      entityType: 'employee',
      entityId: id,
    });

    res.json({ success: true, data: employee });
  } catch (error) {
    console.error('Restore employee error:', error);
    res.status(500).json({ success: false, error: 'Failed to restore employee' });
  }
}

export async function fire(req: AuthenticatedRequest, res: Response): Promise<void> {
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

    const today = new Date().toISOString().slice(0, 10);
    const connection = (req.body.connection as 'external' | 'internal') || undefined;
    let targetDepartmentId = existing.org_department_id || null;

    if (existing.sigur_employee_id) {
      if (!(await sigurService.isConfigured())) {
        res.status(503).json({ success: false, error: 'Sigur не настроен' });
        return;
      }

      const archive = await ensureArchiveSigurDepartment(req.user.id, connection);
      let movedToArchive = false;
      let blocked = false;

      try {
        await sigurService.updateEmployee(existing.sigur_employee_id, {
          departmentId: archive.sigurDepartmentId,
        }, connection);
        movedToArchive = true;

        await sigurService.blockEmployee(existing.sigur_employee_id, connection);
        blocked = true;
      } catch (error) {
        await auditService.logFromRequest(req, req.user.id, 'FIRE_EMPLOYEE', {
          entityType: 'employee',
          entityId: id,
          details: {
            source: 'sigur',
            partial_failure: true,
            movedToArchive,
            blocked,
            error: getErrorMessage(error, 'Unknown Sigur error'),
          },
        });

        res.status(movedToArchive ? 502 : 500).json({
          success: false,
          error: movedToArchive
            ? 'Сотрудник уже перемещён в архивный отдел Sigur, но блокировка не выполнена. Локальный статус не изменён.'
            : 'Не удалось выполнить увольнение сотрудника в Sigur',
          code: movedToArchive ? 'SIGUR_PARTIAL_FAILURE' : 'SIGUR_WRITE_FAILED',
        });
        return;
      }

      const localArchive = await ensureLocalArchiveDepartment(req.user.id, { connection });
      targetDepartmentId = archive.localDepartmentId || localArchive.id;
    } else {
      const archive = await ensureLocalArchiveDepartment(req.user.id, { connection });
      targetDepartmentId = archive.id;
    }

    if (targetDepartmentId && existing.org_department_id !== targetDepartmentId) {
      await employeeChangesService.changeDepartment(employeeId, targetDepartmentId, {
        reason: 'Увольнение — перевод в папку "Уволенные"',
        lockDepartment: false,
        createdBy: req.user.id,
        effectiveDate: today,
      });
    }

    if (targetDepartmentId) {
      await assignEmployeesToArchiveDepartment([employeeId], req.user.id, {
        connection,
        effectiveDate: today,
      });
    }

    const data = await queryOne<EmployeeEncrypted>(
      `UPDATE employees
          SET employment_status = 'fired',
              org_department_id = $1,
              department_locked = false
        WHERE id = $2
      RETURNING ${EMPLOYEE_LIFECYCLE_COLUMNS}`,
      [targetDepartmentId, employeeId],
    );

    if (!data) {
      res.status(500).json({ success: false, error: 'Failed to update employee status' });
      return;
    }

    employeeCache.invalidate(employeeId);

    await execute(
      `UPDATE employee_assignments
          SET effective_to = $1
        WHERE employee_id = $2 AND effective_to IS NULL`,
      [today, employeeId],
    );

    await auditService.logFromRequest(req, req.user.id, 'FIRE_EMPLOYEE', {
      entityType: 'employee',
      entityId: id,
      details: {
        source: existing.sigur_employee_id ? 'sigur' : 'portal',
        target_department_id: targetDepartmentId,
      },
    });

    const structureCache = await loadStructureCache();
    const updatedEmployee = decryptEmployee(data as EmployeeEncrypted, structureCache);
    res.json({ success: true, data: updatedEmployee });
  } catch (error) {
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

    if (await isProtectedArchiveDepartment(targetDepartment.id, connection)) {
      res.status(409).json({
        success: false,
        error: 'Нельзя восстановить в архивный отдел «Уволенные». Выберите другой отдел.',
      });
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    let sigurDetached = false;

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

      try {
        await sigurService.updateEmployee(existing.sigur_employee_id, {
          departmentId: targetDepartment.sigur_department_id,
        }, connection);

        await sigurService.unblockEmployee(existing.sigur_employee_id, connection);
        await syncLinkedEmployeeFromSigur(existing.id, connection);
      } catch (error) {
        if (error instanceof AxiosError) {
          const status = error.response?.status;
          console.error('[rehire] Sigur error', {
            status,
            url: error.config?.url,
            method: error.config?.method,
            employeeId: existing.id,
            sigurEmployeeId: existing.sigur_employee_id,
            targetSigurDepartmentId: targetDepartment.sigur_department_id,
            responseData: error.response?.data,
            message: error.message,
          });
          if (status === 404) {
            // Разграничиваем: 404 на сотрудника (удалён в Sigur) vs 404 на отдел.
            let departmentAlive = false;
            try {
              await sigurService.getDepartmentById(targetDepartment.sigur_department_id, connection);
              departmentAlive = true;
            } catch (departmentProbeError) {
              console.warn('[rehire] department probe failed', {
                sigurDepartmentId: targetDepartment.sigur_department_id,
                message: departmentProbeError instanceof Error ? departmentProbeError.message : String(departmentProbeError),
              });
            }

            if (departmentAlive) {
              // Сотрудник удалён в Sigur — отвязываем и продолжаем локальное восстановление.
              sigurDetached = true;
              console.warn('[rehire] auto-detach sigur_employee_id', {
                employeeId: existing.id,
                sigurEmployeeId: existing.sigur_employee_id,
                reason: 'employee not found in Sigur',
              });
            } else {
              res.status(409).json({
                success: false,
                error: `Sigur вернул 404 на ${error.config?.method?.toUpperCase() || 'запросе'} ${error.config?.url || ''}. Вероятно, отдел «${targetDepartment.name}» (sigur_department_id=${targetDepartment.sigur_department_id}) удалён в Sigur. Запустите синхронизацию структуры и попробуйте снова.`,
              });
              return;
            }
          } else {
            throw error;
          }
        } else {
          throw error;
        }
      }
    }

    await employeeChangesService.changeDepartment(employeeId, targetDepartment.id, {
      reason: sigurDetached
        ? 'Восстановление (отвязка от Sigur — сотрудник удалён в Sigur)'
        : 'Восстановление на работу',
      lockDepartment: sigurDetached,
      createdBy: req.user.id,
      effectiveDate: today,
    });

    await upsertTechnicalDepartmentAccess(
      employeeId,
      targetDepartment.id,
      null,
      existing.sigur_employee_id && !sigurDetached ? 'sigur_sync' : 'portal_lifecycle',
    );

    let data: EmployeeEncrypted | null;
    try {
      const updateFields = sigurDetached
        ? `employment_status = 'active',
             org_department_id = $1,
             department_locked = $2,
             sigur_employee_id = NULL`
        : `employment_status = 'active',
             org_department_id = $1,
             department_locked = $2`;
      data = await queryOne<EmployeeEncrypted>(
        `UPDATE employees
            SET ${updateFields}
          WHERE id = $3
        RETURNING ${EMPLOYEE_LIFECYCLE_COLUMNS}`,
        [targetDepartment.id, sigurDetached, id],
      );
    } catch (updateErr) {
      console.error('[rehire] DB update failed:', updateErr);
      res.status(404).json({ success: false, error: 'Employee not found' });
      return;
    }

    if (!data) {
      console.error('[rehire] DB update failed: no row returned');
      res.status(404).json({ success: false, error: 'Employee not found' });
      return;
    }

    employeeCache.invalidate(id);

    try {
      await auditService.logFromRequest(req, req.user.id, 'REHIRE_EMPLOYEE', {
        entityType: 'employee',
        entityId: id,
        details: {
          source: existing.sigur_employee_id && !sigurDetached ? 'sigur' : 'portal',
          target_department_id: targetDepartment.id,
          detached_from_sigur: sigurDetached,
          previous_sigur_employee_id: sigurDetached ? existing.sigur_employee_id : undefined,
        },
      });
    } catch (auditErr) {
      console.warn('[rehire] audit log failed (non-critical):', auditErr);
    }

    try {
      const structureCache = await loadStructureCache();
      const employee = decryptEmployee(data as EmployeeEncrypted, structureCache);
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
