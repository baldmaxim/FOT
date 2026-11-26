import type { Employee } from '../types';

/** «Перевести в неактивные» / «Вернуть в активные» (миграция 381). */
export type StaffInactiveAction = 'deactivate' | 'reactivate';

/**
 * Какое действие доступно строке: уволенному — никакого; с ручной меткой — вернуть (даже если отдел «Декрет»/«Архив»:
 * снимается только метка, окно об этом предупреждает); «Декрет»/«Архив» без метки — никакого (неактивен по отделу);
 * иначе — перевести.
 */
export const staffInactiveActionFor = (
  emp: Pick<Employee, 'employment_status' | 'staff_inactive_at' | 'inactive_department_name'>,
): StaffInactiveAction | null => {
  if (emp.employment_status === 'fired') return null;
  if (emp.staff_inactive_at) return 'reactivate';
  if (emp.inactive_department_name) return null;
  return 'deactivate';
};
