/**
 * Связи «начальник участка → отделы / лично назначенные сотрудники» — единый источник для
 * «Табель → По участкам» (collectAssignedEmployees) и столбца «Участок» в «Управлении кадрами».
 * Правило одно: менять условия здесь — значит менять оба экрана.
 */
import { query } from '../config/postgres.js';
import { departmentManagerConditionSql } from './department-managers.service.js';

export interface ISiteSupervisorDepartmentLink {
  employee_id: number;
  department_id: string;
  full_name: string | null;
  email: string | null;
}

export interface ISiteSupervisorDirectLink {
  leader_employee_id: number;
  direct_employee_id: number;
  leader_full_name: string | null;
  leader_email: string | null;
  /** Текущий отдел подчинённого: «Участок» объединяет личных начальников с начальниками отдела. */
  direct_department_id: string | null;
}

export interface ISiteSupervisorLinks {
  departmentLinks: ISiteSupervisorDepartmentLink[];
  directLinks: ISiteSupervisorDirectLink[];
}

/**
 * departmentIds — область видимости: закреплённые отделы ∩ область, лично назначенные — по их
 * основному отделу. Без departmentIds — все связи.
 */
export async function loadSiteSupervisorLinks(
  options: { departmentIds?: string[] } = {},
): Promise<ISiteSupervisorLinks> {
  const { departmentIds } = options;

  // 1) Назначения отделов через employee_department_access.
  // Только пользователи с ролью site_supervisor («Начальник участка»).
  const edaWhere: string[] = [
    // Начальник участка — это full-назначение: заместитель (миграция 283) в выгрузку
    // и в exempt-список 1С попадать не должен.
    departmentManagerConditionSql('eda'),
    `e.employment_status = 'active'`,
    `e.is_archived = false`,
    `e.excluded_from_timesheet = false`,
    `od.is_active = true`,
    `sr.code = 'site_supervisor'`,
  ];
  const edaParams: unknown[] = [];
  if (departmentIds) {
    edaParams.push(departmentIds);
    edaWhere.push(`eda.department_id = ANY($${edaParams.length}::uuid[])`);
  }

  // 2) Прямые назначения сотрудников через user_employee_access (миграция 090).
  // leader = user_profile.employee_id, подчинённый = uea.employee_id.
  // Department-scope: подчинённый должен попадать по primary org_department_id.
  const ueaWhere: string[] = [
    'uea.is_active = true',
    `sr.code = 'site_supervisor'`,
    `leader.employment_status = 'active'`,
    `leader.is_archived = false`,
    `direct.employment_status = 'active'`,
    `direct.is_archived = false`,
    `direct.excluded_from_timesheet = false`,
  ];
  const ueaParams: unknown[] = [];
  if (departmentIds) {
    ueaParams.push(departmentIds);
    ueaWhere.push(`direct.org_department_id = ANY($${ueaParams.length}::uuid[])`);
  }

  const departmentLinks = await query<ISiteSupervisorDepartmentLink>(
    `SELECT eda.employee_id,
            eda.department_id,
            e.full_name,
            e.email
       FROM employee_department_access eda
       INNER JOIN employees e ON e.id = eda.employee_id
       INNER JOIN org_departments od ON od.id = eda.department_id
       INNER JOIN user_profiles up ON up.employee_id = e.id
       INNER JOIN system_roles sr ON sr.id = up.system_role_id
      WHERE ${edaWhere.join(' AND ')}`,
    edaParams,
  );

  const directLinks = await query<ISiteSupervisorDirectLink>(
    `SELECT leader.id   AS leader_employee_id,
            direct.id   AS direct_employee_id,
            leader.full_name AS leader_full_name,
            leader.email     AS leader_email,
            direct.org_department_id AS direct_department_id
       FROM user_employee_access uea
       INNER JOIN user_profiles up ON up.id = uea.user_id
       INNER JOIN system_roles sr ON sr.id = up.system_role_id
       INNER JOIN employees leader ON leader.id = up.employee_id
       INNER JOIN employees direct ON direct.id = uea.employee_id
      WHERE ${ueaWhere.join(' AND ')}`,
    ueaParams,
  );

  return { departmentLinks, directLinks };
}
