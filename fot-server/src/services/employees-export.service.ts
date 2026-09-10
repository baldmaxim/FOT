/**
 * Выгрузка «Управление кадрами → Экспорт сотрудников»: выборка людей по скоупу
 * пользователя и сборка иерархии подразделений для xlsx.
 *
 * Охват фиксирован: все НЕ уволенные сотрудники в пределах прав. Фильтры экрана
 * (отдел, поиск, график, статус) на выгрузку не влияют — так решено заказчиком.
 */
import { query } from '../config/postgres.js';
import type { IEmployeeScopeFilter } from './employee-scope-filter.service.js';

/** Предел строк: защита от случайной выгрузки на сотни тысяч человек. */
export const MAX_EXPORT_EMPLOYEES = 50000;

export const DIRECT_REPORTS_GROUP_NAME = 'Непосредственные подчинённые';
export const NO_DEPARTMENT_GROUP_NAME = 'Без подразделения';

export interface IExportEmployeeRow {
  id: number;
  full_name: string;
  org_department_id: string | null;
}

export interface IExportDepartmentRow {
  id: string;
  parent_id: string | null;
  name: string;
  sort_order: number | null;
  kind?: string | null;
}

export interface IExportNode {
  /** null — синтетическая группа («Непосредственные подчинённые», «Без подразделения»). */
  id: string | null;
  name: string;
  depth: number;
  /** Сотрудники непосредственно в этом узле. */
  ownCount: number;
  /** ownCount + сумма total детей. */
  total: number;
  employees: IExportEmployeeRow[];
  children: IExportNode[];
}

export class EmployeesExportError extends Error {
  constructor(public readonly code: 'NO_DATA' | 'EXPORT_TOO_LARGE', message: string) {
    super(message);
    this.name = 'EmployeesExportError';
  }
}

/** Сотрудники по скоупу. mode='none' — запрос не выполняется вовсе. */
export async function loadExportEmployees(
  scope: IEmployeeScopeFilter,
): Promise<IExportEmployeeRow[]> {
  if (scope.mode === 'none') return [];

  const params: unknown[] = [];
  const whereParts = [`is_archived = false`, `employment_status <> 'fired'`];

  if (scope.mode === 'self') {
    params.push(scope.selfEmployeeId);
    whereParts.push(`id = $${params.length}`);
  } else if (scope.mode === 'departments') {
    params.push(scope.departmentIds);
    const deptIdx = params.length;
    if (scope.directEmployeeIds.length > 0) {
      params.push(scope.directEmployeeIds);
      whereParts.push(`(org_department_id = ANY($${deptIdx}::uuid[]) OR id = ANY($${params.length}::int[]))`);
    } else {
      whereParts.push(`org_department_id = ANY($${deptIdx}::uuid[])`);
    }
  } else if (scope.mode === 'employees') {
    params.push(scope.directEmployeeIds);
    whereParts.push(`id = ANY($${params.length}::int[])`);
  }

  params.push(MAX_EXPORT_EMPLOYEES + 1);
  const rows = await query<IExportEmployeeRow>(
    `SELECT id, full_name, org_department_id
       FROM employees
      WHERE ${whereParts.join(' AND ')}
      ORDER BY full_name
      LIMIT $${params.length}`,
    params,
  );

  if (rows.length > MAX_EXPORT_EMPLOYEES) {
    throw new EmployeesExportError(
      'EXPORT_TOO_LARGE',
      `Слишком много сотрудников для выгрузки (более ${MAX_EXPORT_EMPLOYEES}).`,
    );
  }
  return rows;
}

/** Все подразделения, включая неактивные: дерево строится из полного набора. */
export async function loadExportDepartments(): Promise<IExportDepartmentRow[]> {
  return query<IExportDepartmentRow>(
    'SELECT id, parent_id, name, sort_order, kind FROM org_departments',
  );
}

const collator = new Intl.Collator('ru');

/** Синтетический корень структуры («Объект»), под которым лежат компании. */
function isTechnicalRoot(dept: IExportDepartmentRow): boolean {
  return dept.parent_id === null && dept.kind === 'object';
}

/**
 * Порядок сиблингов: sort_order, затем имя. Вторичный ключ обязателен —
 * в проде sort_order у всех подразделений одинаковый, и без него порядок
 * строк менялся бы от выгрузки к выгрузке (как вернёт PostgreSQL).
 */
function compareDeptRows(a: IExportDepartmentRow, b: IExportDepartmentRow): number {
  const orderDiff = (a.sort_order ?? 0) - (b.sort_order ?? 0);
  if (orderDiff !== 0) return orderDiff;
  return collator.compare(a.name || '', b.name || '');
}

export interface IBuildTreeParams {
  employees: IExportEmployeeRow[];
  departments: IExportDepartmentRow[];
  /**
   * Отделы скоупа. Сотрудник вне них попал в выборку как прямой подчинённый —
   * его уводим в отдельную группу, чтобы не раскрывать чужую ветку структуры.
   * Пустой набор = ограничения нет (mode 'all').
   */
  scopeDepartmentIds?: string[];
}

/**
 * Собирает иерархию: подразделение → вложенные подразделения → сотрудники.
 * Пустые узлы (total === 0) в результат не попадают.
 */
export function buildExportTree({
  employees,
  departments,
  scopeDepartmentIds = [],
}: IBuildTreeParams): IExportNode[] {
  const byId = new Map<string, IExportDepartmentRow>();
  for (const dept of departments) byId.set(dept.id, dept);

  const childrenByParent = new Map<string, IExportDepartmentRow[]>();
  for (const dept of departments) {
    if (dept.parent_id === null || !byId.has(dept.parent_id)) continue;
    const siblings = childrenByParent.get(dept.parent_id);
    if (siblings) siblings.push(dept);
    else childrenByParent.set(dept.parent_id, [dept]);
  }
  for (const siblings of childrenByParent.values()) siblings.sort(compareDeptRows);

  const scopeSet = new Set(scopeDepartmentIds);
  const employeesByDept = new Map<string, IExportEmployeeRow[]>();
  const outsideScope: IExportEmployeeRow[] = [];
  const noDepartment: IExportEmployeeRow[] = [];

  for (const employee of employees) {
    const deptId = employee.org_department_id;
    if (!deptId || !byId.has(deptId)) {
      noDepartment.push(employee);
      continue;
    }
    if (scopeSet.size > 0 && !scopeSet.has(deptId)) {
      // Прямой подчинённый из отдела вне скоупа: ветку его отдела не раскрываем.
      outsideScope.push(employee);
      continue;
    }
    const bucket = employeesByDept.get(deptId);
    if (bucket) bucket.push(employee);
    else employeesByDept.set(deptId, [employee]);
  }

  const visited = new Set<string>();

  const buildNode = (dept: IExportDepartmentRow, depth: number): IExportNode | null => {
    if (visited.has(dept.id)) return null; // разрыв цикла parent_id
    visited.add(dept.id);

    const own = employeesByDept.get(dept.id) ?? [];
    const children: IExportNode[] = [];
    for (const child of childrenByParent.get(dept.id) ?? []) {
      const node = buildNode(child, depth + 1);
      if (node) children.push(node);
    }

    const total = own.length + children.reduce((sum, child) => sum + child.total, 0);
    if (total === 0) return null; // пустые подразделения в файл не выводим

    return {
      id: dept.id,
      name: dept.name || '(без названия)',
      depth,
      ownCount: own.length,
      total,
      employees: [...own].sort((a, b) => collator.compare(a.full_name, b.full_name)),
      children,
    };
  };

  const roots: IExportNode[] = [];
  const rootDepts = departments
    .filter(dept => dept.parent_id === null || !byId.has(dept.parent_id))
    .sort(compareDeptRows);
  for (const dept of rootDepts) {
    // Корень «Объект» (kind='object') — техническая обёртка всей структуры, а не
    // подразделение: показали бы его — верхним уровнем файла была бы одна
    // бессмысленная строка. Поднимаем компании (его детей) на верхний уровень.
    if (isTechnicalRoot(dept)) {
      visited.add(dept.id);
      for (const child of childrenByParent.get(dept.id) ?? []) {
        const node = buildNode(child, 0);
        if (node) roots.push(node);
      }
      continue;
    }
    const node = buildNode(dept, 0);
    if (node) roots.push(node);
  }

  // Второй проход: узлы в циклах parent_id недостижимы от корней. Без него
  // их сотрудники молча пропали бы из файла.
  for (const dept of departments) {
    if (visited.has(dept.id)) continue;
    console.warn(`[employees-export] Отдел ${dept.id} недостижим от корня (цикл parent_id?)`);
    const node = buildNode(dept, 0);
    if (node) roots.push(node);
  }

  const appendSyntheticGroup = (name: string, rows: IExportEmployeeRow[]): void => {
    if (rows.length === 0) return;
    roots.push({
      id: null,
      name,
      depth: 0,
      ownCount: rows.length,
      total: rows.length,
      employees: [...rows].sort((a, b) => collator.compare(a.full_name, b.full_name)),
      children: [],
    });
  };

  appendSyntheticGroup(DIRECT_REPORTS_GROUP_NAME, outsideScope);
  appendSyntheticGroup(NO_DEPARTMENT_GROUP_NAME, noDepartment);

  return roots;
}

/** Суммарное число сотрудников в дереве (для шапки книги и аудита). */
export function countTreeEmployees(nodes: IExportNode[]): number {
  return nodes.reduce((sum, node) => sum + node.total, 0);
}
