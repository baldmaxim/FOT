import { Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/database.js';
import { auditService } from '../services/audit.service.js';
import type { AuthenticatedRequest, ChatInboundMode, UserProfile } from '../types/index.js';
import { logSupabaseError } from './admin-helpers.js';
import { getRoleByCode } from '../services/roles-cache.service.js';
import { ensureCriticalAdminAccess } from '../services/critical-admin-access.service.js';
import { loadExplicitDepartmentMap, loadEmployeeAccessMap } from '../services/department-access.service.js';
import { notificationService } from '../services/notification.service.js';
import { pushService } from '../services/push.service.js';
import {
  buildManagerDepartmentImportPreviewFromBuffer,
  saveManagerDepartmentImportAliases,
} from '../services/manager-department-import.service.js';

const approveUserSchema = z.object({
  position_type: z.string().min(1),
  employee_id: z.number().int().positive().optional(),
});

const updateDepartmentAccessSchema = z.object({
  department_ids: z.array(z.string().uuid()).default([]),
});

const applyDepartmentAccessImportSchema = z.object({
  assignments: z.array(z.object({
    employee_id: z.number().int().positive(),
    department_ids: z.array(z.string().uuid()).default([]),
    source_groups: z.array(z.string()).default([]),
  })).default([]),
  group_assignments: z.array(z.object({
    section_name: z.string().nullable().optional(),
    manager_name: z.string().min(1),
    employee_id: z.number().int().positive(),
  })).default([]),
  brigade_aliases: z.array(z.object({
    section_name: z.string().nullable().optional(),
    brigade_name: z.string().min(1),
    department_id: z.string().uuid(),
  })).default([]),
});

function uniqueStringValues(values: Array<string | null | undefined>): string[] {
  return [...new Set(
    values
      .map(value => String(value || '').trim())
      .filter(Boolean),
  )];
}

async function resolveActiveRoleAssignment(positionType: string): Promise<{ id: string; code: string } | null> {
  const role = await getRoleByCode(positionType);
  if (!role || !role.is_active) {
    return null;
  }

  return {
    id: role.id,
    code: role.code,
  };
}

async function getPrimaryDepartmentIdForEmployee(employeeId: number | null): Promise<string | null> {
  if (!employeeId) return null;
  const { data: employee, error: employeeError } = await supabase
    .from('employees')
    .select('org_department_id')
    .eq('id', employeeId)
    .single();

  if (employeeError) {
    throw employeeError;
  }

  return employee?.org_department_id || null;
}

async function validateDepartmentIds(departmentIds: string[]): Promise<{ missingIds: string[] }> {
  const normalizedDepartmentIds = uniqueStringValues(departmentIds);
  if (normalizedDepartmentIds.length === 0) {
    return { missingIds: [] };
  }

  const { data: departments, error: departmentError } = await supabase
    .from('org_departments')
    .select('id')
    .in('id', normalizedDepartmentIds);

  if (departmentError) {
    throw departmentError;
  }

  const foundIds = new Set((departments || []).map(department => department.id as string));
  return {
    missingIds: normalizedDepartmentIds.filter(departmentId => !foundIds.has(departmentId)),
  };
}

async function replaceExplicitDepartmentAccess(params: {
  targetTable: 'employee_department_access' | 'user_department_access';
  targetField: 'employee_id' | 'user_id';
  targetValue: number | string;
  primaryDepartmentId: string | null;
  departmentIds: string[];
  actorUserId: string;
  source: string;
}): Promise<string[]> {
  const explicitDepartmentIds = uniqueStringValues(params.departmentIds)
    .filter(departmentId => departmentId !== params.primaryDepartmentId);

  const { data: existingAccessRows, error: existingAccessError } = await supabase
    .from(params.targetTable)
    .select('department_id, is_active')
    .eq(params.targetField, params.targetValue);

  if (existingAccessError) {
    throw existingAccessError;
  }

  const nextDepartmentSet = new Set(explicitDepartmentIds);
  const activeDepartmentIds = (existingAccessRows || [])
    .filter(row => row.is_active)
    .map(row => row.department_id as string)
    .filter(Boolean);
  const departmentIdsToDeactivate = activeDepartmentIds
    .filter(departmentId => !nextDepartmentSet.has(departmentId));

  const now = new Date().toISOString();

  if (explicitDepartmentIds.length > 0) {
    const rows = explicitDepartmentIds.map(departmentId => ({
      [params.targetField]: params.targetValue,
      department_id: departmentId,
      source: params.source,
      is_active: true,
      created_by: params.actorUserId,
      updated_at: now,
    }));

    const { error: upsertError } = await supabase
      .from(params.targetTable)
      .upsert(rows, {
        onConflict: params.targetField === 'employee_id' ? 'employee_id,department_id' : 'user_id,department_id',
      });

    if (upsertError) {
      throw upsertError;
    }
  }

  if (departmentIdsToDeactivate.length > 0) {
    const { error: deactivateError } = await supabase
      .from(params.targetTable)
      .update({
        is_active: false,
        updated_at: now,
      })
      .eq(params.targetField, params.targetValue)
      .in('department_id', departmentIdsToDeactivate);

    if (deactivateError) {
      throw deactivateError;
    }
  }

  return explicitDepartmentIds;
}

async function loadEmployeeExplicitDepartmentMap(employeeIds: number[]): Promise<Map<number, string[]>> {
  const uniqueEmployeeIds = [...new Set(employeeIds.filter(employeeId => Number.isInteger(employeeId)))];
  const result = new Map<number, string[]>(
    uniqueEmployeeIds.map(employeeId => [employeeId, []]),
  );

  if (uniqueEmployeeIds.length === 0) {
    return result;
  }

  const { data, error } = await supabase
    .from('employee_department_access')
    .select('employee_id, department_id')
    .in('employee_id', uniqueEmployeeIds)
    .eq('is_active', true);

  if (error) {
    throw error;
  }

  for (const row of data || []) {
    const employeeId = row.employee_id as number;
    const departmentId = row.department_id as string | null;
    if (!departmentId || !result.has(employeeId)) continue;
    result.set(employeeId, uniqueStringValues([
      ...(result.get(employeeId) || []),
      departmentId,
    ]));
  }

  return result;
}

async function upsertEmployeeDepartmentAccess(params: {
  employeeId: number;
  departmentIds: string[];
  actorUserId: string;
  source: string;
}): Promise<string[]> {
  const primaryDepartmentId = await getPrimaryDepartmentIdForEmployee(params.employeeId);
  const additionalDepartmentIds = [...new Set(params.departmentIds.map(value => value.trim()))]
    .filter(departmentId => departmentId && departmentId !== primaryDepartmentId);

  if (additionalDepartmentIds.length === 0) {
    return [];
  }

  const now = new Date().toISOString();
  const rows = additionalDepartmentIds.map(departmentId => ({
    employee_id: params.employeeId,
    department_id: departmentId,
    source: params.source,
    is_active: true,
    created_by: params.actorUserId,
    updated_at: now,
  }));

  const { error: upsertError } = await supabase
    .from('employee_department_access')
    .upsert(rows, {
      onConflict: 'employee_id,department_id',
    });

  if (upsertError) {
    throw upsertError;
  }

  return additionalDepartmentIds;
}

export const adminUsersController = {
  async getAllUsers(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { data: users, error: usersError } = await supabase
        .from('user_profiles')
        .select('*')
        .order('created_at', { ascending: false });

      if (usersError) {
        logSupabaseError('GetUsers', usersError);
        res.status(500).json({ success: false, error: 'Failed to fetch users' });
        return;
      }

      // Подгружаем department_id из employees для пользователей с employee_id
      const empIds = users
        .filter((u: UserProfile) => u.employee_id)
        .map((u: UserProfile) => u.employee_id);

      let empDeptMap: Record<number, string | null> = {};
      if (empIds.length > 0) {
        const { data: emps } = await supabase
          .from('employees')
          .select('id, org_department_id')
          .in('id', empIds);
        if (emps) {
          empDeptMap = emps.reduce((acc, e) => {
            acc[e.id] = e.org_department_id || null;
            return acc;
          }, {} as Record<number, string | null>);
        }
      }

      // Подгружаем названия отделов
      const deptIds = Object.values(empDeptMap).filter(Boolean) as string[];
      let deptNameMap: Record<string, string> = {};
      if (deptIds.length > 0) {
        const { data: depts } = await supabase
          .from('org_departments')
          .select('id, name')
          .in('id', deptIds);
        if (depts) {
          deptNameMap = depts.reduce((acc, d) => {
            acc[d.id] = d.name;
            return acc;
          }, {} as Record<string, string>);
        }
      }

      const additionalDepartmentMap = await loadExplicitDepartmentMap(
        users.map((u: UserProfile) => ({
          user_id: u.id,
          employee_id: u.employee_id,
        })),
      );

      // Подгружаем email и статус подтверждения из Supabase Auth
      const authEmailMap: Record<string, { email: string; email_confirmed: boolean }> = {};
      try {
        const perPage = 1000;
        let page = 1;
        let hasMore = true;
        while (hasMore) {
          const { data: authData, error: authError } = await supabase.auth.admin.listUsers({ page, perPage });
          if (authError) {
            console.error('[GetUsers] listUsers error:', authError);
            break;
          }
          if (authData?.users) {
            for (const au of authData.users) {
              authEmailMap[au.id] = {
                email: au.email || '',
                email_confirmed: !!au.email_confirmed_at,
              };
            }
            hasMore = authData.users.length === perPage;
            page++;
          } else {
            hasMore = false;
          }
        }
      } catch (err) {
        console.error('[GetUsers] Auth fetch error:', err);
      }

      const sanitizedUsers = users.map((u: UserProfile) => {
        const deptId = u.employee_id ? empDeptMap[u.employee_id] || null : null;
        const additionalDepartmentIds = (additionalDepartmentMap.get(u.id) || [])
          .filter(accessDepartmentId => accessDepartmentId !== deptId);
        const authInfo = authEmailMap[u.id];
        return {
          id: u.id,
          email: authInfo?.email || '',
          email_confirmed: authInfo?.email_confirmed ?? false,
          full_name: u.full_name,
          department_id: deptId,
          department_name: deptId ? (deptNameMap[deptId] || null) : null,
          additional_department_ids: additionalDepartmentIds,
          managed_department_ids: [...new Set(
            [deptId, ...additionalDepartmentIds].filter((value): value is string => Boolean(value)),
          )],
          position_type: u.position_type,
          imported_position: u.imported_position,
          employee_id: u.employee_id,
          supervisor_id: u.supervisor_id,
          chat_inbound_mode: (u.chat_inbound_mode || 'open') as ChatInboundMode,
          is_approved: u.is_approved,
          two_factor_enabled: u.two_factor_enabled,
          approved_at: u.approved_at,
          created_at: u.created_at,
        };
      });

      res.json({ success: true, data: sanitizedUsers });
    } catch (error) {
      console.error('[GetUsers-Catch] Error:', error instanceof Error ? error.stack : error);
      res.status(500).json({ success: false, error: 'Failed to fetch users' });
    }
  },

  async getEmployeeDepartmentAssignments(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { data: employees, error: employeesError } = await supabase
        .from('employees')
        .select('id, full_name, org_department_id')
        .eq('employment_status', 'active')
        .eq('is_archived', false)
        .order('full_name', { ascending: true });

      if (employeesError) {
        logSupabaseError('GetEmployeeDepartmentAssignments', employeesError);
        res.status(500).json({ success: false, error: 'Не удалось загрузить назначения сотрудников' });
        return;
      }

      const employeeIds = (employees || []).map(employee => employee.id as number);
      const explicitDepartmentMap = await loadEmployeeExplicitDepartmentMap(employeeIds);

      const payload = (employees || []).map(employee => {
        const primaryDepartmentId = employee.org_department_id as string | null;
        const additionalDepartmentIds = (explicitDepartmentMap.get(employee.id as number) || [])
          .filter(departmentId => departmentId !== primaryDepartmentId);

        return {
          employee_id: employee.id,
          full_name: employee.full_name,
          department_id: primaryDepartmentId,
          additional_department_ids: additionalDepartmentIds,
          managed_department_ids: uniqueStringValues([primaryDepartmentId, ...additionalDepartmentIds]),
        };
      });

      res.json({ success: true, data: payload });
    } catch (error) {
      console.error('Get employee department assignments error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить назначения сотрудников' });
    }
  },

  async getPendingUsers(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { data: users, error: usersError } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('is_approved', false)
        .order('created_at', { ascending: false });

      if (usersError) {
        logSupabaseError('GetPendingUsers', usersError);
        res.status(500).json({ success: false, error: 'Failed to fetch pending users' });
        return;
      }

      if (!users || users.length === 0) {
        res.json({ success: true, data: [] });
        return;
      }

      const usersWithEmail = await Promise.all(
        users.map(async (u: UserProfile) => {
          let email = '';
          let emailConfirmed = false;
          try {
            const { data: authUser, error: authError } = await supabase.auth.admin.getUserById(u.id);
            if (authError) {
              console.error(`Failed to get email for user ${u.id}:`, authError);
            }
            email = authUser?.user?.email || '';
            emailConfirmed = !!authUser?.user?.email_confirmed_at;
          } catch (e) {
            console.error('Failed to get user email:', e);
          }

          return {
            id: u.id,
            email,
            email_confirmed: emailConfirmed,
            full_name: u.full_name,
            position_type: u.position_type,
            imported_position: u.imported_position,
            created_at: u.created_at,
          };
        })
      );

      res.json({ success: true, data: usersWithEmail });
    } catch (error) {
      console.error('[GetPendingUsers-Catch] Error:', error instanceof Error ? error.stack : error);
      res.status(500).json({ success: false, error: 'Failed to fetch pending users' });
    }
  },

  async previewDepartmentAccessImport(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const uploadedFile = (req as AuthenticatedRequest & { file?: Express.Multer.File }).file;
      if (!uploadedFile) {
        res.status(400).json({ success: false, error: 'Файл не загружен' });
        return;
      }

      const preview = await buildManagerDepartmentImportPreviewFromBuffer(uploadedFile.buffer);
      res.json({ success: true, data: preview });
    } catch (error) {
      console.error('Preview department access import error:', error);
      res.status(500).json({ success: false, error: 'Не удалось обработать Excel-файл' });
    }
  },

  async applyDepartmentAccessImport(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { assignments, group_assignments, brigade_aliases } = applyDepartmentAccessImportSchema.parse(req.body);
      const normalizedAssignments = assignments
        .map(assignment => ({
          employee_id: assignment.employee_id,
          department_ids: [...new Set(assignment.department_ids.map(value => value.trim()))],
          source_groups: [...new Set(assignment.source_groups.map(value => value.trim()).filter(Boolean))],
        }))
        .filter(assignment => assignment.department_ids.length > 0);
      const normalizedGroupAssignments = group_assignments
        .map(groupAssignment => ({
          section_name: groupAssignment.section_name?.trim() || null,
          manager_name: groupAssignment.manager_name.trim(),
          employee_id: groupAssignment.employee_id,
        }))
        .filter(groupAssignment => groupAssignment.manager_name.length > 0);
      const normalizedBrigadeAliases = brigade_aliases
        .map(brigadeAlias => ({
          section_name: brigadeAlias.section_name?.trim() || null,
          brigade_name: brigadeAlias.brigade_name.trim(),
          department_id: brigadeAlias.department_id.trim(),
        }))
        .filter(brigadeAlias => brigadeAlias.brigade_name.length > 0 && brigadeAlias.department_id.length > 0);

      if (normalizedAssignments.length === 0 && normalizedGroupAssignments.length === 0 && normalizedBrigadeAliases.length === 0) {
        res.status(400).json({ success: false, error: 'Нет данных для применения импорта' });
        return;
      }

      const employeeIds = [...new Set([
        ...normalizedAssignments.map(assignment => assignment.employee_id),
        ...normalizedGroupAssignments.map(groupAssignment => groupAssignment.employee_id),
      ])];
      const departmentIds = [...new Set([
        ...normalizedAssignments.flatMap(assignment => assignment.department_ids),
        ...normalizedBrigadeAliases.map(brigadeAlias => brigadeAlias.department_id),
      ])];

      if (employeeIds.length > 0) {
        const { data: employees, error: employeesError } = await supabase
          .from('employees')
          .select('id')
          .in('id', employeeIds);

        if (employeesError) {
          res.status(500).json({ success: false, error: 'Не удалось проверить выбранных сотрудников' });
          return;
        }

        const foundEmployeeIds = new Set((employees || []).map(employee => employee.id as number));
        const missingEmployeeIds = employeeIds.filter(employeeId => !foundEmployeeIds.has(employeeId));
        if (missingEmployeeIds.length > 0) {
          res.status(400).json({
            success: false,
            error: 'Некоторые сотрудники не найдены',
            details: { missing_employee_ids: missingEmployeeIds },
          });
          return;
        }
      }

      if (departmentIds.length > 0) {
        const { data: departments, error: departmentsError } = await supabase
          .from('org_departments')
          .select('id')
          .in('id', departmentIds);

        if (departmentsError) {
          res.status(500).json({ success: false, error: 'Не удалось проверить подразделения из импорта' });
          return;
        }

        const foundDepartmentIds = new Set((departments || []).map(department => department.id as string));
        const missingDepartmentIds = departmentIds.filter(departmentId => !foundDepartmentIds.has(departmentId));
        if (missingDepartmentIds.length > 0) {
          res.status(400).json({
            success: false,
            error: 'Некоторые подразделения из импорта не найдены',
            details: { missing_department_ids: missingDepartmentIds },
          });
          return;
        }
      }

      let appliedUsers = 0;
      let appliedLinks = 0;

      for (const assignment of normalizedAssignments) {
        const savedDepartmentIds = await upsertEmployeeDepartmentAccess({
          employeeId: assignment.employee_id,
          departmentIds: assignment.department_ids,
          actorUserId: req.user.id,
          source: 'excel_admin_ui',
        });

        if (savedDepartmentIds.length === 0) {
          continue;
        }

        appliedUsers += 1;
        appliedLinks += savedDepartmentIds.length;

        await auditService.logFromRequest(req, req.user.id, 'USER_DEPARTMENT_ACCESS_CHANGED', {
          entityType: 'employee',
          entityId: String(assignment.employee_id),
          details: {
            source: 'excel_admin_ui',
            import_groups: assignment.source_groups,
            imported_department_ids: savedDepartmentIds,
            imported_department_count: savedDepartmentIds.length,
            employee_id: assignment.employee_id,
          },
        });
      }

      await saveManagerDepartmentImportAliases({
        actor_user_id: req.user.id,
        employee_aliases: normalizedGroupAssignments,
        brigade_aliases: normalizedBrigadeAliases,
      });

      res.json({
        success: true,
        data: {
          applied_users: appliedUsers,
          applied_links: appliedLinks,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Apply department access import error:', error);
      res.status(500).json({ success: false, error: 'Не удалось применить импорт назначений' });
    }
  },

  async approveUser(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { position_type, employee_id } = approveUserSchema.parse(req.body);
      const roleAssignment = await resolveActiveRoleAssignment(position_type);
      if (!roleAssignment) {
        res.status(400).json({ success: false, error: 'Выбрана несуществующая или неактивная роль' });
        return;
      }

      const { data: profile, error: fetchError } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('id', id)
        .single();

      if (fetchError || !profile) {
        res.status(404).json({ success: false, error: 'User not found' });
        return;
      }

      const updateData: Record<string, unknown> = {
        is_approved: true,
        approved_by: req.user.id,
        approved_at: new Date().toISOString(),
        position_type: roleAssignment.code,
        system_role_id: roleAssignment.id,
      };

      if (employee_id) {
        updateData.employee_id = employee_id;
      }

      const { error: updateError } = await supabase
        .from('user_profiles')
        .update(updateData)
        .eq('id', id);

      if (updateError) {
        console.error('Approve user error:', updateError);
        res.status(500).json({ success: false, error: 'Failed to approve user' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'USER_APPROVED', {
        entityType: 'user',
        entityId: id,
        details: { position_type: roleAssignment.code },
      });

      if (employee_id) {
        try {
          const accessMap = await loadEmployeeAccessMap([employee_id]);
          const departmentIds = accessMap.get(employee_id) || [];

          if (departmentIds.length > 0) {
            const { data: departments } = await supabase
              .from('org_departments')
              .select('id, name')
              .in('id', departmentIds);

            const nameById = new Map<string, string>(
              (departments || []).map(d => [d.id as string, (d.name as string) || 'Без названия']),
            );
            const names = departmentIds
              .map(depId => nameById.get(depId) || 'Без названия')
              .filter(Boolean);
            const body = names.length === 1
              ? `Отдел: ${names[0]}`
              : `Отделы: ${names.join(', ')}`;
            const title = 'Вы назначены ответственным по табелям';

            await notificationService.createMany([{
              userId: id,
              type: 'timesheet_assigned_departments',
              title,
              body,
              metadata: { departmentIds, path: '/timesheet-hr' },
            }]);
            await pushService.sendGenericNotification([id], title, body, { path: '/timesheet-hr' });
          }
        } catch (notifyError) {
          console.error('approveUser: notify assigned departments error:', notifyError);
        }
      }

      res.json({ success: true, message: 'User approved successfully' });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Approve user error:', error);
      res.status(500).json({ success: false, error: 'Failed to approve user' });
    }
  },

  async rejectUser(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const { error: profileError } = await supabase
        .from('user_profiles')
        .delete()
        .eq('id', id);

      if (profileError) {
        console.error('Delete profile error:', profileError);
        res.status(500).json({ success: false, error: 'Failed to reject user' });
        return;
      }

      const { error: authError } = await supabase.auth.admin.deleteUser(id);

      if (authError) {
        console.error('Delete auth user error:', authError);
      }

      await auditService.logFromRequest(req, req.user.id, 'USER_REJECTED', {
        entityType: 'user',
        entityId: id,
      });

      res.json({ success: true, message: 'User rejected and removed' });
    } catch (error) {
      console.error('Reject user error:', error);
      res.status(500).json({ success: false, error: 'Failed to reject user' });
    }
  },

  async deleteUser(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      try {
        await ensureCriticalAdminAccess({
          removedUserIds: [id],
        });
      } catch (error) {
        res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : 'Нельзя удалить последнего администратора с критичными правами',
        });
        return;
      }

      const { error: profileError } = await supabase
        .from('user_profiles')
        .delete()
        .eq('id', id);

      if (profileError) {
        console.error('Delete profile error:', profileError);
        res.status(500).json({ success: false, error: 'Failed to delete user' });
        return;
      }

      const { error: authError } = await supabase.auth.admin.deleteUser(id);

      if (authError) {
        console.error('Delete auth user error:', authError);
      }

      await auditService.logFromRequest(req, req.user.id, 'USER_DELETED', {
        entityType: 'user',
        entityId: id,
      });

      res.json({ success: true, message: 'User deleted successfully' });
    } catch (error) {
      console.error('Delete user error:', error);
      res.status(500).json({ success: false, error: 'Failed to delete user' });
    }
  },

  async confirmUserEmail(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const { error } = await supabase.auth.admin.updateUserById(id, {
        email_confirm: true,
      });

      if (error) {
        console.error('Confirm email error:', error);
        res.status(500).json({ success: false, error: 'Failed to confirm email' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'EMAIL_CONFIRMED', {
        entityType: 'user',
        entityId: id,
      });

      res.json({ success: true, message: 'Email confirmed successfully' });
    } catch (error) {
      console.error('Confirm email error:', error);
      res.status(500).json({ success: false, error: 'Failed to confirm email' });
    }
  },

  async updateUserPosition(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { position_type } = z.object({
        position_type: z.string().min(1)
      }).parse(req.body);

      const roleAssignment = await resolveActiveRoleAssignment(position_type);
      if (!roleAssignment) {
        res.status(400).json({ success: false, error: 'Роль не найдена или неактивна' });
        return;
      }

      try {
        await ensureCriticalAdminAccess({
          userRoleById: { [id]: roleAssignment.code },
        });
      } catch (error) {
        res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : 'Нельзя снять последний критичный административный доступ',
        });
        return;
      }

      const { error } = await supabase
        .from('user_profiles')
        .update({
          position_type: roleAssignment.code,
          system_role_id: roleAssignment.id,
        })
        .eq('id', id);

      if (error) {
        console.error('Update position error:', error);
        res.status(500).json({ success: false, error: 'Failed to update position' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'POSITION_CHANGED', {
        entityType: 'user',
        entityId: id,
        details: { new_position_type: roleAssignment.code },
      });

      res.json({ success: true, message: 'Position updated successfully' });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Update position error:', error);
      res.status(500).json({ success: false, error: 'Failed to update position' });
    }
  },

  async updateUserName(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { full_name } = z.object({ full_name: z.string().min(2).max(255) }).parse(req.body);

      const { error } = await supabase
        .from('user_profiles')
        .update({ full_name: full_name.trim() })
        .eq('id', id);

      if (error) {
        console.error('Update name error:', error);
        res.status(500).json({ success: false, error: 'Failed to update name' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'NAME_CHANGED', {
        entityType: 'user',
        entityId: id,
        details: { full_name },
      });

      res.json({ success: true, message: 'Name updated successfully' });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Update name error:', error);
      res.status(500).json({ success: false, error: 'Failed to update name' });
    }
  },

  async updateUserEmployee(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { employee_id, department_id } = z.object({
        employee_id: z.number().int().positive().nullable(),
        department_id: z.string().uuid().nullable().optional(),
      }).parse(req.body);

      const { error } = await supabase
        .from('user_profiles')
        .update({ employee_id })
        .eq('id', id);

      if (error) {
        res.status(500).json({ success: false, error: 'Failed to update employee link' });
        return;
      }

      // Если указан отдел и сотрудник — обновляем org_department_id сотрудника
      if (employee_id && department_id) {
        await supabase
          .from('employees')
          .update({ org_department_id: department_id })
          .eq('id', employee_id);
      }

      res.json({ success: true });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Update employee error:', error);
      res.status(500).json({ success: false, error: 'Failed to update employee link' });
    }
  },

  async updateUserChatInboundMode(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { chat_inbound_mode } = z.object({
        chat_inbound_mode: z.enum(['open', 'requests_only', 'disabled']),
      }).parse(req.body);

      const { error } = await supabase
        .from('user_profiles')
        .update({ chat_inbound_mode })
        .eq('id', id);

      if (error) {
        console.error('Update chat inbound mode error:', error);
        res.status(500).json({ success: false, error: 'Failed to update chat inbound mode' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'CHAT_INBOUND_MODE_CHANGED', {
        entityType: 'user',
        entityId: id,
        details: { chat_inbound_mode },
      });

      res.json({ success: true, message: 'Chat inbound mode updated successfully' });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Update chat inbound mode error:', error);
      res.status(500).json({ success: false, error: 'Failed to update chat inbound mode' });
    }
  },

  /** Обновить отдел привязанного сотрудника */
  async updateEmployeeDepartment(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { department_id } = z.object({
        department_id: z.string().uuid(),
      }).parse(req.body);

      // Получаем employee_id пользователя
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('employee_id')
        .eq('id', id)
        .single();

      if (!profile?.employee_id) {
        res.status(400).json({ success: false, error: 'У пользователя нет привязки к сотруднику' });
        return;
      }

      const { error } = await supabase
        .from('employees')
        .update({ org_department_id: department_id })
        .eq('id', profile.employee_id);

      if (error) {
        res.status(500).json({ success: false, error: 'Failed to update department' });
        return;
      }

      res.json({ success: true });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Update employee department error:', error);
      res.status(500).json({ success: false, error: 'Failed to update department' });
    }
  },

  async updateUserDepartmentAccess(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { department_ids } = updateDepartmentAccessSchema.parse(req.body);
      const normalizedDepartmentIds = [...new Set(department_ids.map(value => value.trim()))];

      const { data: profile, error: profileError } = await supabase
        .from('user_profiles')
        .select('employee_id')
        .eq('id', id)
        .single();

      if (profileError || !profile) {
        res.status(404).json({ success: false, error: 'User not found' });
        return;
      }

      const primaryDepartmentId = await getPrimaryDepartmentIdForEmployee(profile.employee_id);
      const { missingIds } = await validateDepartmentIds(normalizedDepartmentIds);
      if (missingIds.length > 0) {
        res.status(400).json({
          success: false,
          error: 'Некоторые отделы не найдены',
          details: { missing_department_ids: missingIds },
        });
        return;
      }

      const explicitDepartmentIds = await replaceExplicitDepartmentAccess({
        targetTable: profile.employee_id ? 'employee_department_access' : 'user_department_access',
        targetField: profile.employee_id ? 'employee_id' : 'user_id',
        targetValue: profile.employee_id ?? id,
        primaryDepartmentId,
        departmentIds: normalizedDepartmentIds,
        actorUserId: req.user.id,
        source: 'manual_admin_ui',
      });

      await auditService.logFromRequest(req, req.user.id, 'USER_DEPARTMENT_ACCESS_CHANGED', {
        entityType: 'user',
        entityId: id,
        details: {
          primary_department_id: primaryDepartmentId,
          additional_department_ids: explicitDepartmentIds,
          additional_department_count: explicitDepartmentIds.length,
        },
      });

      res.json({
        success: true,
        data: {
          additional_department_ids: explicitDepartmentIds,
          managed_department_ids: [...new Set(
            [primaryDepartmentId, ...explicitDepartmentIds].filter((value): value is string => Boolean(value)),
          )],
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Update user department access error:', error);
      res.status(500).json({ success: false, error: 'Failed to update department access' });
    }
  },

  async updateEmployeeDepartmentAccess(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const employeeId = z.coerce.number().int().positive().parse(req.params.id);
      const { department_ids } = updateDepartmentAccessSchema.parse(req.body);
      const normalizedDepartmentIds = uniqueStringValues(department_ids);

      const { data: employee, error: employeeError } = await supabase
        .from('employees')
        .select('id, org_department_id, full_name')
        .eq('id', employeeId)
        .single();

      if (employeeError || !employee) {
        res.status(404).json({ success: false, error: 'Сотрудник не найден' });
        return;
      }

      const { missingIds } = await validateDepartmentIds(normalizedDepartmentIds);
      if (missingIds.length > 0) {
        res.status(400).json({
          success: false,
          error: 'Некоторые отделы не найдены',
          details: { missing_department_ids: missingIds },
        });
        return;
      }

      const explicitDepartmentIds = await replaceExplicitDepartmentAccess({
        targetTable: 'employee_department_access',
        targetField: 'employee_id',
        targetValue: employeeId,
        primaryDepartmentId: employee.org_department_id || null,
        departmentIds: normalizedDepartmentIds,
        actorUserId: req.user.id,
        source: 'manual_admin_ui',
      });

      await auditService.logFromRequest(req, req.user.id, 'USER_DEPARTMENT_ACCESS_CHANGED', {
        entityType: 'employee',
        entityId: String(employeeId),
        details: {
          employee_id: employeeId,
          employee_name: employee.full_name,
          primary_department_id: employee.org_department_id || null,
          additional_department_ids: explicitDepartmentIds,
          additional_department_count: explicitDepartmentIds.length,
        },
      });

      res.json({
        success: true,
        data: {
          additional_department_ids: explicitDepartmentIds,
          managed_department_ids: uniqueStringValues([employee.org_department_id || null, ...explicitDepartmentIds]),
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Update employee department access error:', error);
      res.status(500).json({ success: false, error: 'Не удалось обновить назначения сотрудника' });
    }
  },

  async searchUnlinkedEmployees(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const q = (req.query.q as string || '').trim();

      if (!q || q.length < 2) {
        res.json({ success: true, data: [] });
        return;
      }

      const { data: linkedProfiles } = await supabase
        .from('user_profiles')
        .select('employee_id')
        .not('employee_id', 'is', null);

      const linkedIds = (linkedProfiles || [])
        .map((p: { employee_id: number | null }) => p.employee_id)
        .filter((id): id is number => id !== null);

      let query = supabase
        .from('employees')
        .select('id, full_name, org_department_id')
        .ilike('full_name', `%${q}%`)
        .eq('employment_status', 'active')
        .limit(20);

      if (linkedIds.length > 0) {
        query = query.not('id', 'in', `(${linkedIds.join(',')})`);
      }

      const { data: employees, error } = await query;

      if (error) {
        logSupabaseError('SearchUnlinkedEmployees', error);
        res.status(500).json({ success: false, error: 'Failed to search employees' });
        return;
      }

      res.json({ success: true, data: employees || [] });
    } catch (error) {
      console.error('Search unlinked employees error:', error);
      res.status(500).json({ success: false, error: 'Failed to search employees' });
    }
  },
};
