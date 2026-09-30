import type { IStaffSectionDepartments } from '../services/employeeService';

/**
 * Отделы, которые можно выбрать в окне «Режим табелирования»: разрешённые сервером (активные,
 * не подрядные, в скоупе записи) и лежащие в ветках компаний — СУ-10, СМ и их бригад.
 * Служебные корни («Уволенные», «test») сервер относит к «Прочим» — их в выборе нет.
 * undefined — ветки ещё не загружены: показывать дерево нельзя, иначе мелькнут служебные.
 */
export const selectableTimesheetOfficeDepartmentIds = (
  allowedIds: readonly string[],
  sectionIds: IStaffSectionDepartments | undefined,
): Set<string> | undefined => {
  if (!sectionIds) return undefined;
  const companies = new Set([...sectionIds.su10, ...sectionIds.sm, ...sectionIds.brigades]);
  return new Set(allowedIds.filter(id => companies.has(id)));
};
