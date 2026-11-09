/**
 * Группы отделов «Расчётов» в списке «Все отделы», под деревом отделов: ИТР — ЛИНИЯ, ЛИНИЯ-Общестрой и остальные отделы
 * СУ-10 (бывший «Офис» влит в ИТР 09.11.2026), Рабочие — все бригады; по отделу, не по табелю (табель — у «Свода»).
 * Отбор считает сервер (?group). Группа и отдел взаимоисключающие: выбор одного снимает другое.
 */
import type { PayrollDepartmentGroup } from '../services/payrollService';

export const PAYROLL_GROUP_LABELS: Record<PayrollDepartmentGroup, string> = { itr: 'ИТР', worker: 'Рабочие' };

/** Значение группы в списке отделов — с префиксом, чтобы не совпасть с id отдела. */
const GROUP_PREFIX = 'group:';

export const payrollGroupValue = (group: PayrollDepartmentGroup): string => `${GROUP_PREFIX}${group}`;

export const PAYROLL_GROUP_OPTIONS: ReadonlyArray<{ value: string; label: string }> = (['itr', 'worker'] as const)
  .map(group => ({ value: payrollGroupValue(group), label: PAYROLL_GROUP_LABELS[group] }));

/** Значение списка → группа; отдел или «Все отделы» — null. */
export const payrollGroupOfValue = (value: string): PayrollDepartmentGroup | null => {
  const group = value.startsWith(GROUP_PREFIX) ? value.slice(GROUP_PREFIX.length) : null;
  return group === 'itr' || group === 'worker' ? group : null;
};

/** Выбор в списке → новые группа и отдел. */
export const pickDepartmentOrGroup = (value: string): { group: PayrollDepartmentGroup | null; departmentId: string } => {
  const group = payrollGroupOfValue(value);
  return { group, departmentId: group ? '' : value };
};
