import { supabase } from '../config/database.js';
import { getRolePageAccess, resolveRoleDataScope } from './access-control.service.js';

export type TimesheetResponsibleRole = 'primary' | 'backup';

export interface ITimesheetResponsible {
  department_id: string;
  user_id: string;
  role: TimesheetResponsibleRole;
  is_active: boolean;
  full_name: string | null;
  position_type: string | null;
  employee_id: number | null;
}

export interface ITimesheetResponsibleCandidate {
  user_id: string;
  full_name: string | null;
  position_type: string | null;
  employee_id: number | null;
}

interface IUserProfileLite {
  id: string;
  full_name: string | null;
  position_type: string | null;
  system_role_id?: string | null;
  employee_id: number | null;
}

const RESPONSIBLE_ROLES: TimesheetResponsibleRole[] = ['primary', 'backup'];

export const timesheetResponsiblesService = {
  async getByDepartment(departmentId: string): Promise<ITimesheetResponsible[]> {
    const { data, error } = await supabase
      .from('timesheet_responsibles')
      .select('department_id, user_id, role, is_active')
      .eq('department_id', departmentId)
      .eq('is_active', true);

    if (error) {
      throw error;
    }

    const userIds = [...new Set((data || []).map(item => item.user_id as string))];
    if (userIds.length === 0) return [];

    const { data: profiles, error: profilesError } = await supabase
      .from('user_profiles')
      .select('id, full_name, position_type, employee_id')
      .in('id', userIds);

    if (profilesError) {
      throw profilesError;
    }

    const profileMap = new Map(
      (profiles || []).map(profile => [profile.id as string, profile]),
    );

    return (data || [])
      .filter(item => RESPONSIBLE_ROLES.includes(item.role as TimesheetResponsibleRole))
      .map(item => {
        const profile = profileMap.get(item.user_id as string);
        return {
          department_id: item.department_id as string,
          user_id: item.user_id as string,
          role: item.role as TimesheetResponsibleRole,
          is_active: !!item.is_active,
          full_name: (profile?.full_name as string | null) ?? null,
          position_type: (profile?.position_type as string | null) ?? null,
          employee_id: (profile?.employee_id as number | null) ?? null,
        };
      })
      .sort((a, b) => a.role.localeCompare(b.role, 'en'));
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
      (await this.getCandidateUsersByDepartment(input.departmentId)).map(candidate => candidate.user_id),
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
        user_id: row.userId,
        role: row.role,
        is_active: true,
        updated_at: new Date().toISOString(),
      }));

    if (upsertRows.length > 0) {
      const { error } = await supabase
        .from('timesheet_responsibles')
        .upsert(upsertRows, { onConflict: 'department_id,role' });

      if (error) {
        throw error;
      }
    }

    const rolesToDelete = rows
      .filter(row => !row.userId)
      .map(row => row.role);

    if (rolesToDelete.length > 0) {
      const { error } = await supabase
        .from('timesheet_responsibles')
        .delete()
        .eq('department_id', input.departmentId)
        .in('role', rolesToDelete);

      if (error) {
        throw error;
      }
    }

    return this.getByDepartment(input.departmentId);
  },

  async getCandidateUsersByDepartment(departmentId: string): Promise<ITimesheetResponsibleCandidate[]> {
    const { data: employees, error: employeesError } = await supabase
      .from('employees')
      .select('id')
      .eq('org_department_id', departmentId)
      .eq('employment_status', 'active')
      .eq('is_archived', false);

    if (employeesError) {
      throw employeesError;
    }

    const employeeIds = (employees || []).map(item => item.id as number);
    if (employeeIds.length === 0) return [];

    const { data: profiles, error: profilesError } = await supabase
      .from('user_profiles')
      .select('id, full_name, position_type, employee_id')
      .eq('is_approved', true)
      .in('employee_id', employeeIds);

    if (profilesError) {
      throw profilesError;
    }

    return (profiles || [])
      .map(profile => ({
        user_id: profile.id as string,
        full_name: (profile.full_name as string | null) ?? null,
        position_type: (profile.position_type as string | null) ?? null,
        employee_id: (profile.employee_id as number | null) ?? null,
      }))
      .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || '', 'ru'));
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
    const { data: profiles, error } = await supabase
      .from('user_profiles')
      .select('id, full_name, position_type, system_role_id, employee_id')
      .eq('is_approved', true);

    if (error) {
      throw error;
    }

    const typedProfiles = (profiles || []) as IUserProfileLite[];
    const employeeIds = typedProfiles
      .map(profile => profile.employee_id)
      .filter((employeeId): employeeId is number => Number.isInteger(employeeId));

    const departmentByEmployeeId = new Map<number, string | null>();
    if (employeeIds.length > 0) {
      const { data: employees, error: employeesError } = await supabase
        .from('employees')
        .select('id, org_department_id')
        .in('id', employeeIds);

      if (employeesError) {
        throw employeesError;
      }

      for (const employee of employees || []) {
        departmentByEmployeeId.set(employee.id as number, (employee.org_department_id as string | null) ?? null);
      }
    }

    const checks = await Promise.all(typedProfiles.map(async (profile) => {
      const roleRef = profile.system_role_id || profile.position_type;
      if (!roleRef) return null;

      const [pageAccess, dataScope] = await Promise.all([
        getRolePageAccess(roleRef),
        resolveRoleDataScope(roleRef),
      ]);

      if (pageAccess['/timesheet-hr']?.can_view !== true) {
        return null;
      }

      if (dataScope === 'all') {
        return profile.id;
      }

      if (dataScope === 'department' && profile.employee_id != null) {
        const employeeDepartmentId = departmentByEmployeeId.get(profile.employee_id) ?? null;
        if (employeeDepartmentId === departmentId) {
          return profile.id;
        }
      }

      return null;
    }));

    return [...new Set(checks.filter((value): value is string => typeof value === 'string' && value.length > 0))];
  },
};
