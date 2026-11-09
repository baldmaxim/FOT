/**
 * Группы отделов «Расчётов» — пункты списка «Все отделы», не категория табеля:
 *   ИТР     — ЛИНИЯ и ЛИНИЯ-Общестрой с подотделами и остальные отделы СУ-10 (бывшая группа «Офис» влита в ИТР 09.11.2026);
 *   Рабочие — все бригады (раздел «Бригады», СУ-10 и СМ).
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

export type PayrollDepartmentGroup = 'itr' | 'worker';

export const PAYROLL_DEPARTMENT_GROUPS: readonly PayrollDepartmentGroup[] = ['itr', 'worker'];

/** id отделов каждой группы; группы не пересекаются. */
export const payrollDepartmentGroupIds = (
  departments: IExportDepartmentRow[],
): Record<PayrollDepartmentGroup, string[]> => {
  const isLinia = createLiniaResolver(departments);
  const worker = new Set(listSectionDepartmentIds(departments, 'brigades'));
  const itr = new Set([
    ...departments.filter(dept => isLinia(dept.id)).map(dept => dept.id),
    ...listCompanyDepartmentIds(departments, 'su10'),
  ]);
  return { itr: [...itr].filter(id => !worker.has(id)), worker: [...worker] };
};

/** id отделов группы — по текущей структуре. */
export const loadPayrollDepartmentGroupIds = async (group: PayrollDepartmentGroup): Promise<string[]> => {
  const departments = await query<IExportDepartmentRow>('SELECT id, parent_id, name, kind FROM org_departments');
  return payrollDepartmentGroupIds(departments)[group];
};
