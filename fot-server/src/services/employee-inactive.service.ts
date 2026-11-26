/**
 * Статус «Неактивный» в «Управлении кадрами» (миграция 381) — одно правило для списка, счётчиков, признака, экспорта
 * и входа на портал. Неактивен не уволенный сотрудник:
 *  - с ручной меткой employees.staff_inactive_at («Перевести в неактивные»);
 *  - или в отделе, который сам или через предка называется «Декрет»/«Архив» (employee-sign.ts).
 *
 * employment_status не меняется: табель, зарплата, 1С и Sigur неактивность не видят.
 *
 * Не путать с «архивным отделом» employee-archive-department.service.ts — это папка «Уволенные» в Sigur, — а также
 * с employees.is_archived и excluded_from_timesheet.
 */
import { getAllDepartmentsTree, type IDeptTreeRow } from './skud-shared.service.js';
import {
  buildSignDepartmentIndex,
  findAutoInactiveDepartmentName,
  type AutoInactiveDepartmentName,
} from '../utils/employee-sign.js';

export interface IAutoInactiveDepartments {
  /** id всех отделов веток «Декрет»/«Архив» (с самими узлами и потомками). */
  ids: string[];
  /** id отдела → название ветки («Декрет»/«Архив»). */
  nameById: ReadonlyMap<string, AutoInactiveDepartmentName>;
}

// Дерево отделов кэширует getAllDepartmentsTree (5 мин, сброс после синка). Пока массив тот же — список не
// пересчитываем: его читает и authenticate на каждом запросе.
let memo: { source: IDeptTreeRow[]; value: IAutoInactiveDepartments } | null = null;

export function computeAutoInactiveDepartments(departments: readonly IDeptTreeRow[]): IAutoInactiveDepartments {
  const index = buildSignDepartmentIndex(departments);
  const nameById = new Map<string, AutoInactiveDepartmentName>();
  for (const dept of departments) {
    const name = findAutoInactiveDepartmentName(dept.id, index);
    if (name) nameById.set(dept.id, name);
  }
  return { ids: [...nameById.keys()], nameById };
}

export async function loadAutoInactiveDepartments(): Promise<IAutoInactiveDepartments> {
  const tree = await getAllDepartmentsTree();
  if (memo?.source === tree) return memo.value;
  const value = computeAutoInactiveDepartments(tree);
  memo = { source: tree, value };
  return value;
}

export async function loadAutoInactiveDepartmentIds(): Promise<string[]> {
  return (await loadAutoInactiveDepartments()).ids;
}

const column = (alias: string, name: string): string => (alias ? `${alias}.${name}` : name);

/**
 * Карточка неактивна (без учёта увольнения). Никогда не NULL: org_department_id NULL или пустой список отделов дают
 * false, а не NULL — иначе NOT(...) выкинул бы сотрудника без отдела и из «Активных». Параметр дописывается в params.
 */
export function staffInactiveSql(alias: string, params: unknown[], autoInactiveIds: readonly string[]): string {
  params.push([...autoInactiveIds]);
  return `(${column(alias, 'staff_inactive_at')} IS NOT NULL`
    + ` OR COALESCE(${column(alias, 'org_department_id')} = ANY($${params.length}::uuid[]), false))`;
}

/** «Активные»: не уволен и не неактивен. */
export function workingConditionSql(alias: string, params: unknown[], autoInactiveIds: readonly string[]): string {
  return `(${column(alias, 'employment_status')} <> 'fired' AND NOT ${staffInactiveSql(alias, params, autoInactiveIds)})`;
}
