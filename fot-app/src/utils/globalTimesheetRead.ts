import type { UserProfile } from '../types/auth';

/**
 * Зеркало backend-guard hasGlobalDepartmentReadScope (data-scope.service.ts):
 * флаг роли view_all_departments действует только для не-админа и не-табельщицы.
 * Всегда проверять через эту функцию, а не сырое поле профиля.
 */
export const hasGlobalTimesheetReadScope = (profile: UserProfile | null | undefined): boolean =>
  profile?.view_all_departments === true
  && profile.is_admin !== true
  && profile.role_code !== 'timekeeper';
