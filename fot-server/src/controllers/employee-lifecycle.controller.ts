import { Response } from 'express';
import { AxiosError } from 'axios';
import { supabase } from '../config/database.js';
import { auditService } from '../services/audit.service.js';
import { employeeChangesService } from '../services/employee-changes.service.js';
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

const EMPLOYEE_LIFECYCLE_COLUMNS = 'id, full_name, last_name, first_name, middle_name, current_salary, salary_actual, salary_calculated, staff_units, birth_date, hire_date, country, pension_number, patent_issue_date, patent_expiry_date, email, org_department_id, position_id, sigur_employee_id, tab_number, current_status, permit_expiry_date, registration_cat1, registration_cat4, doc_receipt_date, work_object, employment_status, department_locked, is_archived, archived_at, created_at, updated_at, work_category';

interface IHttpError extends Error {
  status?: number;
  code?: string;
}

interface ITargetDepartmentRow {
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

function getHttpErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const status = 'status' in error ? Number(error.status) : Number.NaN;
  return Number.isFinite(status) ? status : null;
}

function getHttpErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>;
    const parts = [e.message, e.details, e.hint, e.code].filter(v => typeof v === 'string' && v);
    if (parts.length > 0) return parts.join(' | ');
    try { return JSON.stringify(error); } catch { return fallback; }
  }
  return typeof error === 'string' && error ? error : fallback;
}

async function loadEmployeeLifecycleRow(employeeId: number): Promise<EmployeeEncrypted | null> {
  const { data, error } = await supabase
    .from('employees')
    .select(EMPLOYEE_LIFECYCLE_COLUMNS)
    .eq('id', employeeId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data as EmployeeEncrypted | null) ?? null;
}

async function loadTargetDepartment(id: string): Promise<ITargetDepartmentRow | null> {
  const { data, error } = await supabase
    .from('org_departments')
    .select('id, sigur_department_id, name')
    .eq('id', id)
    .eq('is_active', true)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data as ITargetDepartmentRow | null) ?? null;
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

async function moveEmployeeToDepartmentInternal(params: {
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

    const { data, error } = await supabase
      .from('employees')
      .update({ is_archived: true, archived_at: new Date().toISOString() })
      .eq('id', id)
      .select(EMPLOYEE_LIFECYCLE_COLUMNS)
      .single();

    if (error || !data) {
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

    const { data, error } = await supabase
      .from('employees')
      .update({ is_archived: false, archived_at: null })
      .eq('id', id)
      .select(EMPLOYEE_LIFECYCLE_COLUMNS)
      .single();

    if (error || !data) {
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

    const { data, error } = await supabase
      .from('employees')
      .update({
        employment_status: 'fired',
        org_department_id: targetDepartmentId,
        department_locked: false,
      })
      .eq('id', id)
      .select(EMPLOYEE_LIFECYCLE_COLUMNS)
      .single();

    if (error || !data) {
      res.status(500).json({ success: false, error: 'Failed to update employee status' });
      return;
    }

    employeeCache.invalidate(id);

    await supabase
      .from('employee_assignments')
      .update({ effective_to: today })
      .eq('employee_id', id)
      .is('effective_to', null);

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
    res.status(500).json({ success: false, error: 'Failed to fire employee' });
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

    if (existing.org_department_id !== targetDepartment.id) {
      await employeeChangesService.changeDepartment(employeeId, targetDepartment.id, {
        reason: sigurDetached
          ? 'Восстановление (отвязка от Sigur — сотрудник удалён в Sigur)'
          : 'Восстановление — перевод в отдел',
        lockDepartment: sigurDetached,
        createdBy: req.user.id,
        effectiveDate: today,
      });
    }

    await upsertTechnicalDepartmentAccess(
      employeeId,
      targetDepartment.id,
      null,
      existing.sigur_employee_id && !sigurDetached ? 'sigur_sync' : 'portal_lifecycle',
    );

    const { data, error } = await supabase
      .from('employees')
      .update({
        employment_status: 'active',
        org_department_id: targetDepartment.id,
        department_locked: sigurDetached,
        ...(sigurDetached ? { sigur_employee_id: null } : {}),
      })
      .eq('id', id)
      .select(EMPLOYEE_LIFECYCLE_COLUMNS)
      .single();

    if (error || !data) {
      console.error('[rehire] DB update failed:', error);
      res.status(404).json({ success: false, error: 'Employee not found' });
      return;
    }

    employeeCache.invalidate(id);

    try {
      const { error: closeErr } = await supabase
        .from('employee_assignments')
        .update({ effective_to: today })
        .eq('employee_id', employeeId)
        .is('effective_to', null);
      if (closeErr) {
        console.warn('[rehire] close previous assignments failed (non-critical):', closeErr);
      }

      const { error: assignError } = await supabase
        .from('employee_assignments')
        .insert({
          employee_id: employeeId,
          org_department_id: targetDepartment.id,
          position_id: data.position_id || null,
          effective_from: today,
          is_primary: true,
          assignment_type: 'main',
          change_reason: 'Восстановление на работу',
          created_by: req.user.id,
        });

      if (assignError) {
        console.warn('[rehire] employee_assignments insert failed (non-critical):', assignError);
      }
    } catch (assignCatch) {
      console.warn('[rehire] assignment block threw (non-critical):', assignCatch);
    }

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

    const connection = (req.body.connection as 'external' | 'internal') || undefined;
    const source = await moveEmployeeToDepartmentInternal({
      req,
      employee: employeeRow,
      targetDepartment,
      connection,
      reason: 'Перевод в другой отдел',
    });

    employeeCache.invalidate(id);

    await auditService.logFromRequest(req, req.user.id, 'MOVE_EMPLOYEE_DEPARTMENT', {
      entityType: 'employee',
      entityId: id,
      details: {
        org_department_id,
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
    } = req.body as {
      employee_ids?: number[];
      org_department_id?: string;
      connection?: 'external' | 'internal';
    };

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

      try {
        const source = await moveEmployeeToDepartmentInternal({
          req,
          employee: employeeRow,
          targetDepartment,
          connection,
          reason: 'Массовый перевод в другой отдел',
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
            org_department_id,
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

    const { data: emp } = await supabase.from('employees').select('id').eq('id', id).single();
    if (!emp) {
      res.status(404).json({ success: false, error: 'Employee not found' });
      return;
    }

    const { data, error } = await supabase
      .from('employee_history')
      .select('*')
      .eq('employee_id', id)
      .order('event_date', { ascending: false });

    if (error) {
      console.error('Get employee history error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch history' });
      return;
    }

    const structureCache = await loadStructureCache();

    const events = (data || []).map((row: Record<string, unknown>) => {
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
    if (eventId.startsWith('sal_')) {
      const historyId = Number(eventId.replace('sal_', ''));
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
    res.status(500).json({ success: false, error: 'Failed to update history event' });
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
    if (eventId.startsWith('sal_')) {
      const historyId = Number(eventId.replace('sal_', ''));
      await employeeChangesService.deleteSalaryHistory(historyId, employeeId);
    } else {
      await employeeChangesService.deleteAssignment(eventId, employeeId);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Delete history event error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete history event' });
  }
}
