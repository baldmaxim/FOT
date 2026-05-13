import { execute, query } from '../config/postgres.js';
import { getRolePageAccess } from './access-control.service.js';
import { loadManagedDepartmentMap } from './department-access.service.js';
import { getRoleById } from './roles-cache.service.js';

export type TimesheetResponsibleRole = 'primary' | 'backup';

export interface ITimesheetResponsible {
  department_id: string;
  user_id: string;
  role: TimesheetResponsibleRole;
  is_active: boolean;
  full_name: string | null;
  role_code: string | null;
  employee_id: number | null;
}

export interface ITimesheetResponsibleCandidate {
  user_id: string;
  full_name: string | null;
  role_code: string | null;
  employee_id: number | null;
}

interface IUserProfileLite {
  id: string;
  full_name: string | null;
  system_role_id: string;
  employee_id: number | null;
}

const RESPONSIBLE_ROLES: TimesheetResponsibleRole[] = ['primary', 'backup'];

async function resolveRoleCode(systemRoleId: string | null | undefined): Promise<string | null> {
  if (!systemRoleId) return null;
  const role = await getRoleById(systemRoleId);
  return role?.code ?? null;
}

export const timesheetResponsiblesService = {
  async getByDepartment(departmentId: string): Promise<ITimesheetResponsible[]> {
    const data = await query<{ department_id: string; user_id: string; role: string; is_active: boolean }>(
      `SELECT department_id, user_id, role, is_active
         FROM timesheet_responsibles
        WHERE department_id = $1
          AND is_active = true`,
      [departmentId],
    );

    const userIds = [...new Set(data.map(item => item.user_id))];
    if (userIds.length === 0) return [];

    const profiles = await query<IUserProfileLite>(
      'SELECT id, full_name, system_role_id, employee_id FROM user_profiles WHERE id = ANY($1::uuid[])',
      [userIds],
    );

    const profileMap = new Map(profiles.map(p => [p.id, p]));

    const rows = data.filter(item => RESPONSIBLE_ROLES.includes(item.role as TimesheetResponsibleRole));
    const result: ITimesheetResponsible[] = [];

    for (const item of rows) {
      const profile = profileMap.get(item.user_id);
      const role_code = profile ? await resolveRoleCode(profile.system_role_id) : null;
      result.push({
        department_id: item.department_id,
        user_id: item.user_id,
        role: item.role as TimesheetResponsibleRole,
        is_active: !!item.is_active,
        full_name: profile?.full_name ?? null,
        role_code,
        employee_id: profile?.employee_id ?? null,
      });
    }

    return result.sort((a, b) => a.role.localeCompare(b.role, 'en'));
  },

  async setDepartmentResponsibles(input: {
    departmentId: string;
    primaryUserId: string | null;
    backupUserId: string | null;
  }): Promise<ITimesheetResponsible[]> {
    if (input.primaryUserId && input.primaryUserId === input.backupUserId) {
      throw new Error('Основной и резервный ответственные должны отличаться');
    }

    const allowedCandidateIds = new Set(
      (await this.getCandidateUsersByDepartment(input.departmentId)).map(c => c.user_id),
    );

    if (input.primaryUserId && !allowedCandidateIds.has(input.primaryUserId)) {
      throw new Error('Основной ответственный должен быть одобренным пользователем выбранного отдела');
    }

    if (input.backupUserId && !allowedCandidateIds.has(input.backupUserId)) {
      throw new Error('Резервный ответственный должен быть одобренным пользователем выбранного отдела');
    }

    const rows = [
      { role: 'primary' as const, userId: input.primaryUserId },
      { role: 'backup' as const, userId: input.backupUserId },
    ];

    const upsertRows = rows
      .filter(row => !!row.userId)
      .map(row => ({
        department_id: input.departmentId,
        user_id: row.userId as string,
        role: row.role,
        is_active: true,
        updated_at: new Date().toISOString(),
      }));

    for (const r of upsertRows) {
      await execute(
        `INSERT INTO timesheet_responsibles (department_id, user_id, role, is_active, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (department_id, role) DO UPDATE SET
           user_id = EXCLUDED.user_id,
           is_active = EXCLUDED.is_active,
           updated_at = EXCLUDED.updated_at`,
        [r.department_id, r.user_id, r.role, r.is_active, r.updated_at],
      );
    }

    const rolesToDelete = rows.filter(row => !row.userId).map(row => row.role);

    if (rolesToDelete.length > 0) {
      await execute(
        'DELETE FROM timesheet_responsibles WHERE department_id = $1 AND role = ANY($2::text[])',
        [input.departmentId, rolesToDelete],
      );
    }

    return this.getByDepartment(input.departmentId);
  },

  async getCandidateUsersByDepartment(departmentId: string): Promise<ITimesheetResponsibleCandidate[]> {
    const typedProfiles = await query<IUserProfileLite>(
      'SELECT id, full_name, system_role_id, employee_id FROM user_profiles WHERE is_approved = true',
    );

    const employeeIds = typedProfiles
      .map(p => p.employee_id)
      .filter((id): id is number => Number.isInteger(id));

    const departmentByEmployeeId = new Map<number, string | null>();
    if (employeeIds.length > 0) {
      const employees = await query<{
        id: number;
        org_department_id: string | null;
        employment_status: string;
        is_archived: boolean;
        excluded_from_timesheet: boolean;
      }>(
        `SELECT id, org_department_id, employment_status, is_archived, excluded_from_timesheet
           FROM employees
          WHERE id = ANY($1::int[])`,
        [employeeIds],
      );

      for (const employee of employees) {
        if (employee.is_archived || employee.excluded_from_timesheet || employee.employment_status !== 'active') continue;
        departmentByEmployeeId.set(Number(employee.id), employee.org_department_id ?? null);
      }
    }

    const managedDepartmentMap = await loadManagedDepartmentMap(
      typedProfiles.map(p => ({
        user_id: p.id,
        employee_id: p.employee_id,
        primary_department_id: p.employee_id != null ? (departmentByEmployeeId.get(p.employee_id) ?? null) : null,
      })),
    );

    const filtered = typedProfiles.filter(
      p => (managedDepartmentMap.get(p.id)?.managed_department_ids || []).includes(departmentId),
    );

    const result: ITimesheetResponsibleCandidate[] = [];
    for (const p of filtered) {
      const role_code = await resolveRoleCode(p.system_role_id);
      result.push({
        user_id: p.id,
        full_name: p.full_name ?? null,
        role_code,
        employee_id: p.employee_id ?? null,
      });
    }

    return result.sort((a, b) => (a.full_name || '').localeCompare(b.full_name || '', 'ru'));
  },

  async getReminderRecipientsByDepartment(departmentId: string): Promise<{
    primary: string[];
    backup: string[];
  }> {
    const responsibles = await this.getByDepartment(departmentId);
    return {
      primary: responsibles.filter(item => item.role === 'primary').map(item => item.user_id),
      backup: responsibles.filter(item => item.role === 'backup').map(item => item.user_id),
    };
  },

  async getHrRecipientsForDepartment(departmentId: string): Promise<string[]> {
    const typedProfiles = await query<IUserProfileLite>(
      'SELECT id, full_name, system_role_id, employee_id FROM user_profiles WHERE is_approved = true',
    );

    const employeeIds = typedProfiles
      .map(p => p.employee_id)
      .filter((id): id is number => Number.isInteger(id));

    const departmentByEmployeeId = new Map<number, string | null>();
    if (employeeIds.length > 0) {
      const employees = await query<{ id: number; org_department_id: string | null }>(
        'SELECT id, org_department_id FROM employees WHERE id = ANY($1::int[])',
        [employeeIds],
      );

      for (const employee of employees) {
        departmentByEmployeeId.set(Number(employee.id), employee.org_department_id ?? null);
      }
    }

    const managedDepartmentMap = await loadManagedDepartmentMap(
      typedProfiles.map(p => ({
        user_id: p.id,
        employee_id: p.employee_id,
        primary_department_id: p.employee_id != null ? (departmentByEmployeeId.get(p.employee_id) ?? null) : null,
      })),
    );

    const checks = await Promise.all(typedProfiles.map(async (p) => {
      if (!p.system_role_id) return null;
      const role = await getRoleById(p.system_role_id);
      if (!role) return null;

      const pageAccess = await getRolePageAccess(role.code);
      if (pageAccess['/timesheet-hr']?.can_view !== true) return null;

      if (role.is_admin) return p.id;

      const managedDepartmentIds = managedDepartmentMap.get(p.id)?.managed_department_ids || [];
      return managedDepartmentIds.includes(departmentId) ? p.id : null;
    }));

    return [...new Set(checks.filter((v): v is string => typeof v === 'string' && v.length > 0))];
  },
};
