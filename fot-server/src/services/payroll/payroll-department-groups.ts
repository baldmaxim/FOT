/**
 * Группы отделов «Расчётов» (решение пользователя 09.11.2026) — пункты списка «Все отделы», не категория табеля:
 *   ИТР     — ЛИНИЯ и ЛИНИЯ-Общестрой с подотделами;
 *   Рабочие — все бригады (раздел «Бригады», СУ-10 и СМ);
 *   Офис    — остальные отделы СУ-10.
 * СМ в группы не входит — выбирается своим узлом дерева. «Свод» делит по режиму табелирования месяца (payroll-staff-category.ts).
 * Отделы — включая неактивные: у уволенного отдел мог уже закрыться.
 */
import { query } from '../../config/postgres.js';
import {
  listCompanyDepartmentIds,
  listSectionDepartmentIds,
  type IExportDepartmentRow,
} from '../employees-export.service.js';
import { createLiniaResolver } from './payroll-staff-category.js';
import type { StaffCategory } from './payroll-terms.service.js';

export type PayrollDepartmentGroup = StaffCategory;

export const PAYROLL_DEPARTMENT_GROUPS: readonly PayrollDepartmentGroup[] = ['itr', 'office', 'worker'];

/** id отделов каждой группы; группы не пересекаются. */
export const payrollDepartmentGroupIds = (
  departments: IExportDepartmentRow[],
): Record<PayrollDepartmentGroup, string[]> => {
  const isLinia = createLiniaResolver(departments);
  const worker = new Set(listSectionDepartmentIds(departments, 'brigades'));
  const itr = departments.filter(dept => isLinia(dept.id) && !worker.has(dept.id)).map(dept => dept.id);
  const itrSet = new Set(itr);
  const office = listCompanyDepartmentIds(departments, 'su10').filter(id => !worker.has(id) && !itrSet.has(id));
  return { itr, office, worker: [...worker] };
};

/** id отделов группы — по текущей структуре. */
export const loadPayrollDepartmentGroupIds = async (group: PayrollDepartmentGroup): Promise<string[]> => {
  const departments = await query<IExportDepartmentRow>('SELECT id, parent_id, name, kind FROM org_departments');
  return payrollDepartmentGroupIds(departments)[group];
};
