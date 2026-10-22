import { filterByFio } from './fioSearch';

/**
 * Люди «Аналитики дисциплины» по отделам и поиску ФИО — тем же правилом, что выгрузка
 * (fot-server/src/services/discipline-export-filter.service.ts; случаи в тестах совпадают). Точных среди людей
 * выбранных отделов нет — с одной ошибкой. Вкладки и «только с нарушениями» — виды поверх этого набора.
 */
export const filterDisciplineEmployees = <T extends { name: string; departmentId: string | null }>(
  employees: T[],
  departmentIds: ReadonlySet<string> | null,
  search: string,
): T[] => {
  const inDepartments = departmentIds
    ? employees.filter(employee => employee.departmentId !== null && departmentIds.has(employee.departmentId))
    : employees;
  return filterByFio(inDepartments, employee => employee.name, search);
};
