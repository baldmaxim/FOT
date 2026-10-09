/**
 * Категория персонала в условиях оплаты — не выбирается, а следует из отдела сотрудника:
 *   - бригады СУ-10 (раздел «Бригады» «Управления кадрами») — «Рабочие»;
 *   - «ЛИНИЯ» и «ЛИНИЯ-Общестрой» со всеми подотделами — «ИТР на объектах»;
 *   - остальные, в том числе Служба механизации и сотрудник без отдела, — «Офис».
 * Бригады СМ раздел «Бригады» тоже включает, но СМ по решению отдела кадров — «Офис».
 */
import { query, type DbExecutor } from '../../config/postgres.js';
import { normalizeDepartmentName } from '../../utils/employee-sign.js';
import { createDepartmentPlacer, type IExportDepartmentRow } from '../employees-export.service.js';
import type { StaffCategory } from './payroll-terms.service.js';

const ITR_DEPARTMENT_NAMES: ReadonlySet<string> = new Set(['линия', 'линия-общестрой']);

/** Отдел → категория. Структура читается один раз, ответ кэшируется по отделу. */
export const createStaffCategoryResolver = (
  departments: IExportDepartmentRow[],
): ((departmentId: string | null) => StaffCategory) => {
  const placer = createDepartmentPlacer(departments);
  const cache = new Map<string, StaffCategory>();

  const isItr = (departmentId: string): boolean => {
    const seen = new Set<string>();
    let current = placer.byId.get(departmentId);
    while (current && !seen.has(current.id)) {
      if (ITR_DEPARTMENT_NAMES.has(normalizeDepartmentName(current.name))) return true;
      seen.add(current.id);
      current = current.parent_id ? placer.byId.get(current.parent_id) : undefined;
    }
    return false;
  };

  return (departmentId) => {
    if (!departmentId || !placer.byId.has(departmentId)) return 'office';
    const cached = cache.get(departmentId);
    if (cached) return cached;
    const placement = placer.place(departmentId);
    const category: StaffCategory = placement.section === 'brigades' && placement.company === 'su10'
      ? 'worker'
      : isItr(departmentId) ? 'itr' : 'office';
    cache.set(departmentId, category);
    return category;
  };
};

/**
 * Резолвер по текущей структуре, включая неактивные отделы. exec — клиент транзакции:
 * структура читается тем же снимком, что и сотрудник.
 */
export const loadStaffCategoryResolver = async (
  exec?: DbExecutor,
): Promise<(departmentId: string | null) => StaffCategory> => {
  const sql = 'SELECT id, parent_id, name, kind FROM org_departments';
  const rows = exec
    ? (await exec.query<IExportDepartmentRow>(sql)).rows
    : await query<IExportDepartmentRow>(sql);
  return createStaffCategoryResolver(rows);
};

/**
 * Категории сотрудников по их текущим отделам: id → категория. Сотрудника нет в БД — «Офис»,
 * как у сотрудника без отдела. exec — клиент транзакции назначения.
 */
export const resolveEmployeeStaffCategories = async (
  employeeIds: number[],
  exec?: DbExecutor,
): Promise<Map<number, StaffCategory>> => {
  const categoryOf = await loadStaffCategoryResolver(exec);
  const sql = 'SELECT id, org_department_id FROM employees WHERE id = ANY($1::int[])';
  const rows = exec
    ? (await exec.query<{ id: number; org_department_id: string | null }>(sql, [employeeIds])).rows
    : await query<{ id: number; org_department_id: string | null }>(sql, [employeeIds]);
  const departmentById = new Map(rows.map(row => [row.id, row.org_department_id]));
  return new Map(employeeIds.map(id => [id, categoryOf(departmentById.get(id) ?? null)]));
};
