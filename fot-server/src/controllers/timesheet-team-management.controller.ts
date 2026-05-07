/**
 * Контроллер управления составом табеля и переводов/исключений сотрудников.
 *
 * Извлечён из timesheet.controller.ts (Волна 3 декомпозиции). Содержит endpoints
 * под `/api/timesheet/team-management/*` и `/api/timesheet/admin/transfers`.
 *
 * Общие хелперы (resolveTimesheetScope, hasManagedTimesheetAccess) импортируются
 * из основного timesheet.controller — они нужны и другим endpoints.
 */
import { Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/database.js';
import { auditService } from '../services/audit.service.js';
import { escapeLike } from '../utils/search.utils.js';
import { employeeCache } from '../services/employee-cache.service.js';
import { hasPageEdit } from '../services/access-control.service.js';
import {
  formatDateShift,
  isEmployeeAssignedToDepartmentOnDate,
} from '../services/timesheet-department-assignments.service.js';
import {
  deleteExclusion,
  deleteTransfer,
  listAllTransfersAndExclusions,
  listDepartmentTransfers,
  loadAssignmentEmployeeId,
  updateExclusionDate,
  updateTransfer,
} from '../services/timesheet-transfers.service.js';
import {
  getErrorMessage,
  getHttpErrorCode,
  getHttpErrorStatus,
  loadEmployeeLifecycleRow,
  loadTargetDepartment,
  moveEmployeeToDepartmentInternal,
} from './employee-lifecycle.controller.js';
import {
  loadEmployeeFullName as loadEmployeeFullNameForAudit,
  loadDepartmentName as loadDepartmentNameForAudit,
} from '../services/audit-context.helpers.js';
import {
  hasManagedTimesheetAccess,
  resolveTimesheetScope,
  resolveTimesheetScopedDepartmentId,
} from './timesheet.controller.js';
import { resolveCompanyScope } from '../services/data-scope.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Низкоуровневые ручки управления переводами/исключениями доступны только
 * системному админу (без company-scope). Админу компании эти операции
 * недоступны напрямую — он управляет назначениями через /admin/users.
 */
async function requireSystemAdmin(req: AuthenticatedRequest): Promise<boolean> {
  if (!req.user.is_admin) return false;
  const scope = await resolveCompanyScope(req);
  return scope.roots === 'all';
}

const TIMESHEET_TEAM_MANAGEMENT_PAGE_KEY = 'timesheet-team-management';

// ─── Schemas ──────────────────────────────────────────────────────────────

const teamManagementSearchSchema = z.object({
  q: z.string().trim().min(2).max(100),
  department_id: z.string().uuid(),
});

const teamManagementMutationSchema = z.object({
  employee_id: z.number().int().positive(),
  department_id: z.string().uuid(),
});

const teamManagementAddEmployeeSchema = teamManagementMutationSchema.extend({
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const teamManagementExcludeSchema = teamManagementMutationSchema.extend({
  effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const transfersListQuerySchema = z.object({
  department_id: z.string().uuid(),
});

const adminTransfersListQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  department_id: z.string().uuid().optional(),
  employee_query: z.string().trim().max(100).optional(),
});

const transferUpdateSchema = z.object({
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to_department_id: z.string().uuid().optional(),
  from_department_id: z.string().uuid().optional(),
  assignment_old_id: z.string().uuid().optional(),
}).refine(
  data => data.effective_from !== undefined || data.to_department_id !== undefined || data.from_department_id !== undefined,
  { message: 'Должно быть указано хотя бы одно поле для изменения' },
);

const exclusionUpdateSchema = z.object({
  effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const uuidParamSchema = z.string().uuid();

// ─── Helpers ──────────────────────────────────────────────────────────────

async function isTimesheetTeamManagementAvailable(req: AuthenticatedRequest): Promise<boolean> {
  if (req.user.is_admin) {
    return true;
  }

  if (await hasPageEdit(req.user.role_code, TIMESHEET_TEAM_MANAGEMENT_PAGE_KEY)) {
    return hasManagedTimesheetAccess(req, 'view');
  }

  return hasManagedTimesheetAccess(req, 'edit');
}

async function resolveManagedDepartmentId(
  req: AuthenticatedRequest,
  requestedDepartmentId: string,
): Promise<string | null> {
  const scope = await resolveTimesheetScope(req);
  if (!scope || scope === 'self') return null;
  return resolveTimesheetScopedDepartmentId(req, requestedDepartmentId);
}

// ─── Endpoints ────────────────────────────────────────────────────────────

export const timesheetTeamManagementController = {
  /** GET /api/timesheet/team-management-config */
  async getTeamManagementConfig(req: AuthenticatedRequest, res: Response) {
    try {
      const enabled = await isTimesheetTeamManagementAvailable(req);
      const scope = await resolveTimesheetScope(req);
      res.json({
        success: true,
        data: {
          enabled,
          scope,
          can_manage: enabled && scope !== 'self',
        },
      });
    } catch (err) {
      console.error('timesheet.getTeamManagementConfig error:', err);
      res.status(500).json({ success: false, error: 'Ошибка загрузки настроек управления составом табеля' });
    }
  },

  /** GET /api/timesheet/team-management/search-employees?q=...&department_id=... */
  async searchTeamEmployees(req: AuthenticatedRequest, res: Response) {
    try {
      const enabled = await isTimesheetTeamManagementAvailable(req);
      if (!enabled) {
        return res.status(403).json({ success: false, error: 'Недостаточно прав для управления составом табеля' });
      }

      const parsed = teamManagementSearchSchema.parse({
        q: typeof req.query.q === 'string' ? req.query.q : '',
        department_id: typeof req.query.department_id === 'string' ? req.query.department_id : '',
      });

      const targetDepartmentId = await resolveManagedDepartmentId(req, parsed.department_id);
      if (!targetDepartmentId) {
        return res.status(403).json({ success: false, error: 'Нет доступа к управлению составом этого отдела' });
      }

      const { data: employees, error } = await supabase
        .from('employees')
        .select('id, full_name, org_department_id, excluded_from_timesheet')
        .ilike('full_name', `%${escapeLike(parsed.q)}%`)
        .eq('employment_status', 'active')
        .eq('is_archived', false)
        .neq('org_department_id', targetDepartmentId)
        .order('full_name')
        .limit(20);

      if (error) throw error;

      const departmentIds = [...new Set((employees || [])
        .map(employee => employee.org_department_id)
        .filter((value): value is string => Boolean(value)))];

      const departmentNameById = new Map<string, string>();
      if (departmentIds.length > 0) {
        const { data: departments, error: departmentsError } = await supabase
          .from('org_departments')
          .select('id, name')
          .in('id', departmentIds);

        if (departmentsError) throw departmentsError;
        for (const department of departments || []) {
          departmentNameById.set(String(department.id), String(department.name || ''));
        }
      }

      res.json({
        success: true,
        data: (employees || []).map(employee => ({
          id: Number(employee.id),
          full_name: String(employee.full_name || ''),
          org_department_id: (employee.org_department_id as string | null) ?? null,
          department_name: employee.org_department_id
            ? departmentNameById.get(String(employee.org_department_id)) || null
            : null,
          excluded_from_timesheet: Boolean(employee.excluded_from_timesheet),
        })),
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ success: false, error: 'Ошибка валидации', details: err.errors });
      }
      console.error('timesheet.searchTeamEmployees error:', err);
      res.status(500).json({ success: false, error: 'Ошибка поиска сотрудников для табеля' });
    }
  },

  /** POST /api/timesheet/team-management/add-employee */
  async addEmployeeToDepartment(req: AuthenticatedRequest, res: Response) {
    try {
      const enabled = await isTimesheetTeamManagementAvailable(req);
      if (!enabled) {
        return res.status(403).json({ success: false, error: 'Недостаточно прав для управления составом табеля' });
      }

      const parsed = teamManagementAddEmployeeSchema.parse(req.body);
      const targetDepartmentId = await resolveManagedDepartmentId(req, parsed.department_id);
      if (!targetDepartmentId) {
        return res.status(403).json({ success: false, error: 'Нет доступа к управлению составом этого отдела' });
      }

      const [employeeRow, targetDepartment, excludedFlagRow] = await Promise.all([
        loadEmployeeLifecycleRow(parsed.employee_id),
        loadTargetDepartment(targetDepartmentId),
        supabase
          .from('employees')
          .select('excluded_from_timesheet')
          .eq('id', parsed.employee_id)
          .maybeSingle(),
      ]);

      if (!employeeRow) {
        return res.status(404).json({ success: false, error: 'Сотрудник не найден' });
      }
      if (!targetDepartment) {
        return res.status(400).json({ success: false, error: 'Целевой отдел не найден' });
      }
      if (employeeRow.employment_status !== 'active') {
        return res.status(409).json({ success: false, error: 'Можно добавлять только активных сотрудников' });
      }
      if (await isEmployeeAssignedToDepartmentOnDate(parsed.employee_id, targetDepartmentId, parsed.effective_from)) {
        return res.status(409).json({ success: false, error: 'Сотрудник уже находится в выбранном отделе' });
      }

      const fromDepartmentId = employeeRow.org_department_id;
      const restoredFromExclusion = Boolean(excludedFlagRow.data?.excluded_from_timesheet);

      const moveResult = await moveEmployeeToDepartmentInternal({
        req,
        employee: employeeRow,
        targetDepartment,
        reason: 'Перевод из табеля',
        effectiveDate: parsed.effective_from,
      });

      if (restoredFromExclusion) {
        const { error: unexcludeError } = await supabase
          .from('employees')
          .update({
            excluded_from_timesheet: false,
            excluded_from_timesheet_at: null,
            excluded_from_timesheet_date: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', parsed.employee_id);
        if (unexcludeError) throw unexcludeError;
      }

      employeeCache.invalidate(parsed.employee_id);

      await auditService.logFromRequest(req, req.user.id, 'MOVE_EMPLOYEE_DEPARTMENT', {
        entityType: 'employee',
        entityId: String(parsed.employee_id),
        details: {
          source: 'timesheet_team_management',
          move_result: moveResult,
          from_department_id: fromDepartmentId,
          to_department_id: targetDepartmentId,
          effective_from: parsed.effective_from,
          restored_from_exclusion: restoredFromExclusion,
        },
      });

      res.json({
        success: true,
        data: {
          employee_id: parsed.employee_id,
          department_id: targetDepartmentId,
          effective_from: parsed.effective_from,
          move_result: moveResult,
        },
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ success: false, error: 'Ошибка валидации', details: err.errors });
      }
      const status = getHttpErrorStatus(err);
      if (status) {
        const code = getHttpErrorCode(err);
        return res.status(status).json({
          success: false,
          error: getErrorMessage(err, 'Ошибка добавления сотрудника в отдел табеля'),
          ...(code ? { code } : {}),
        });
      }
      console.error('timesheet.addEmployeeToDepartment error:', err);
      res.status(500).json({ success: false, error: 'Ошибка добавления сотрудника в отдел табеля' });
    }
  },

  /** POST /api/timesheet/team-management/exclude-employee */
  async excludeEmployeeFromDepartment(req: AuthenticatedRequest, res: Response) {
    try {
      const enabled = await isTimesheetTeamManagementAvailable(req);
      if (!enabled) {
        return res.status(403).json({ success: false, error: 'Недостаточно прав для управления составом табеля' });
      }

      const parsed = teamManagementExcludeSchema.parse(req.body);
      const targetDepartmentId = await resolveManagedDepartmentId(req, parsed.department_id);
      if (!targetDepartmentId) {
        return res.status(403).json({ success: false, error: 'Нет доступа к управлению составом этого отдела' });
      }

      const { data: employee, error } = await supabase
        .from('employees')
        .select('id, full_name, org_department_id, employment_status, excluded_from_timesheet')
        .eq('id', parsed.employee_id)
        .single();
      if (error || !employee) {
        return res.status(404).json({ success: false, error: 'Сотрудник не найден' });
      }
      if (employee.org_department_id !== targetDepartmentId) {
        return res.status(409).json({ success: false, error: 'Сотрудник не относится к выбранному отделу' });
      }
      if (employee.excluded_from_timesheet) {
        return res.status(409).json({ success: false, error: 'Сотрудник уже исключён из табеля' });
      }
      if (employee.employment_status !== 'active') {
        return res.status(409).json({ success: false, error: 'Можно исключать только активных сотрудников' });
      }

      const excludedAt = new Date().toISOString();
      const effectiveDate = parsed.effective_date;
      const previousDay = formatDateShift(effectiveDate, -1);

      const { error: updateError } = await supabase
        .from('employees')
        .update({
          excluded_from_timesheet: true,
          excluded_from_timesheet_at: excludedAt,
          excluded_from_timesheet_date: effectiveDate,
          updated_at: excludedAt,
        })
        .eq('id', parsed.employee_id);
      if (updateError) throw updateError;

      const { error: closeAssignmentError } = await supabase
        .from('employee_assignments')
        .update({ effective_to: previousDay, updated_at: excludedAt })
        .eq('employee_id', parsed.employee_id)
        .eq('org_department_id', targetDepartmentId)
        .is('effective_to', null);
      if (closeAssignmentError) throw closeAssignmentError;

      employeeCache.invalidate(parsed.employee_id);

      const auditDeptName = await loadDepartmentNameForAudit(targetDepartmentId);

      await auditService.logFromRequest(req, req.user.id, 'EXCLUDE_FROM_TIMESHEET', {
        entityType: 'employee',
        entityId: String(parsed.employee_id),
        details: {
          source: 'timesheet_team_management',
          employee_id: parsed.employee_id,
          employee_full_name: (employee.full_name as string | null) ?? null,
          department_id: targetDepartmentId,
          department_name: auditDeptName,
          effective_date: effectiveDate,
        },
      });

      res.json({
        success: true,
        data: {
          employee_id: parsed.employee_id,
          excluded_from_timesheet_at: excludedAt,
          excluded_from_timesheet_date: effectiveDate,
        },
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ success: false, error: 'Ошибка валидации', details: err.errors });
      }
      console.error('timesheet.excludeEmployeeFromDepartment error:', err);
      res.status(500).json({ success: false, error: 'Ошибка исключения сотрудника из табеля' });
    }
  },

  /** GET /api/timesheet/admin/transfers?from=&to=&department_id=&employee_query= */
  async listAdminTransfers(req: AuthenticatedRequest, res: Response) {
    try {
      if (!(await requireSystemAdmin(req))) {
        return res.status(403).json({ success: false, error: 'Доступно только системному администратору' });
      }
      const parsed = adminTransfersListQuerySchema.parse(req.query);
      const data = await listAllTransfersAndExclusions(parsed);
      res.json({ success: true, data });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ success: false, error: 'Ошибка валидации', details: err.errors });
      }
      console.error('timesheet.listAdminTransfers error:', err);
      res.status(500).json({ success: false, error: 'Ошибка загрузки списка переводов и исключений' });
    }
  },

  /** GET /api/timesheet/team-management/transfers?department_id=... */
  async listTransfers(req: AuthenticatedRequest, res: Response) {
    try {
      if (!(await requireSystemAdmin(req))) {
        return res.status(403).json({ success: false, error: 'Доступно только системному администратору' });
      }
      const parsed = transfersListQuerySchema.parse(req.query);
      const data = await listDepartmentTransfers(parsed.department_id);
      res.json({ success: true, data });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ success: false, error: 'Ошибка валидации', details: err.errors });
      }
      console.error('timesheet.listTransfers error:', err);
      res.status(500).json({ success: false, error: 'Ошибка загрузки списка переводов' });
    }
  },

  /** PATCH /api/timesheet/team-management/transfers/:assignmentId */
  async patchTransfer(req: AuthenticatedRequest, res: Response) {
    try {
      if (!(await requireSystemAdmin(req))) {
        return res.status(403).json({ success: false, error: 'Доступно только системному администратору' });
      }
      const assignmentId = uuidParamSchema.parse(req.params.assignmentId);
      const parsed = transferUpdateSchema.parse(req.body);

      const result = await updateTransfer(assignmentId, {
        effective_from: parsed.effective_from,
        to_department_id: parsed.to_department_id,
        from_department_id: parsed.from_department_id,
        assignment_old_id: parsed.assignment_old_id,
      });
      employeeCache.invalidate(result.employee_id);

      const auditFullName = await loadEmployeeFullNameForAudit(result.employee_id);
      await auditService.logFromRequest(req, req.user.id, 'UPDATE_TRANSFER', {
        entityType: 'employee',
        entityId: String(result.employee_id),
        details: {
          source: 'timesheet_team_management',
          employee_id: result.employee_id,
          employee_full_name: auditFullName,
          assignment_new_id: result.assignment_new_id,
          assignment_old_id: result.assignment_old_id,
          new_effective_from: result.effective_from,
          new_effective_to_old: result.effective_to_old,
          to_department_id: result.to_department_id,
          from_department_id: result.from_department_id,
          changed: result.changed,
        },
      });

      res.json({ success: true, data: result });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ success: false, error: 'Ошибка валидации', details: err.errors });
      }
      const message = err instanceof Error ? err.message : 'Ошибка изменения даты перевода';
      console.error('timesheet.patchTransfer error:', err);
      res.status(400).json({ success: false, error: message });
    }
  },

  /** DELETE /api/timesheet/team-management/transfers/:assignmentId */
  async deleteTransferEntry(req: AuthenticatedRequest, res: Response) {
    try {
      if (!(await requireSystemAdmin(req))) {
        return res.status(403).json({ success: false, error: 'Доступно только системному администратору' });
      }
      const assignmentId = uuidParamSchema.parse(req.params.assignmentId);
      const employeeIdBefore = await loadAssignmentEmployeeId(assignmentId);

      const result = await deleteTransfer(assignmentId);
      employeeCache.invalidate(result.employee_id);

      const auditFullName = await loadEmployeeFullNameForAudit(result.employee_id);
      await auditService.logFromRequest(req, req.user.id, 'REVERT_TRANSFER_LOCAL_ONLY', {
        entityType: 'employee',
        entityId: String(result.employee_id),
        details: {
          source: 'timesheet_team_management',
          employee_id: result.employee_id,
          employee_full_name: auditFullName,
          removed_assignment_id: result.removed_assignment_id,
          reopened_assignment_id: result.reopened_assignment_id,
          restored_department_id: result.restored_department_id,
          assignment_employee_id_before: employeeIdBefore,
        },
      });

      res.json({ success: true, data: result });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ success: false, error: 'Ошибка валидации', details: err.errors });
      }
      const message = err instanceof Error ? err.message : 'Ошибка отмены перевода';
      console.error('timesheet.deleteTransferEntry error:', err);
      res.status(400).json({ success: false, error: message });
    }
  },

  /** PATCH /api/timesheet/team-management/exclusions/:employeeId */
  async patchExclusion(req: AuthenticatedRequest, res: Response) {
    try {
      if (!(await requireSystemAdmin(req))) {
        return res.status(403).json({ success: false, error: 'Доступно только системному администратору' });
      }
      const employeeId = Number(req.params.employeeId);
      if (!Number.isFinite(employeeId) || employeeId <= 0) {
        return res.status(400).json({ success: false, error: 'Некорректный id сотрудника' });
      }
      const parsed = exclusionUpdateSchema.parse(req.body);

      const result = await updateExclusionDate(employeeId, parsed.effective_date);
      employeeCache.invalidate(employeeId);

      const auditFullName = await loadEmployeeFullNameForAudit(employeeId);
      await auditService.logFromRequest(req, req.user.id, 'UPDATE_EXCLUSION', {
        entityType: 'employee',
        entityId: String(employeeId),
        details: {
          source: 'timesheet_team_management',
          employee_id: employeeId,
          employee_full_name: auditFullName,
          excluded_from_timesheet_date: result.excluded_from_timesheet_date,
        },
      });

      res.json({ success: true, data: result });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ success: false, error: 'Ошибка валидации', details: err.errors });
      }
      const message = err instanceof Error ? err.message : 'Ошибка изменения даты исключения';
      console.error('timesheet.patchExclusion error:', err);
      res.status(400).json({ success: false, error: message });
    }
  },

  /** DELETE /api/timesheet/team-management/exclusions/:employeeId */
  async deleteExclusionEntry(req: AuthenticatedRequest, res: Response) {
    try {
      if (!(await requireSystemAdmin(req))) {
        return res.status(403).json({ success: false, error: 'Доступно только системному администратору' });
      }
      const employeeId = Number(req.params.employeeId);
      if (!Number.isFinite(employeeId) || employeeId <= 0) {
        return res.status(400).json({ success: false, error: 'Некорректный id сотрудника' });
      }

      const result = await deleteExclusion(employeeId);
      employeeCache.invalidate(employeeId);

      const auditFullName = await loadEmployeeFullNameForAudit(employeeId);
      await auditService.logFromRequest(req, req.user.id, 'REVERT_EXCLUSION', {
        entityType: 'employee',
        entityId: String(employeeId),
        details: {
          source: 'timesheet_team_management',
          employee_id: employeeId,
          employee_full_name: auditFullName,
          reopened_assignment_id: result.reopened_assignment_id,
        },
      });

      res.json({ success: true, data: result });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Ошибка отмены исключения';
      console.error('timesheet.deleteExclusionEntry error:', err);
      res.status(400).json({ success: false, error: message });
    }
  },
};
