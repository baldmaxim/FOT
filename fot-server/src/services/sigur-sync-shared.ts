import { sigurService } from './sigur.service.js';
import { supabase } from '../config/database.js';

/** Системные папки Sigur — больше не фильтруем, синхронизируем все */
const SIGUR_SYSTEM_DEPARTMENTS: string[] = [];

// ─── Нормализация полей Sigur API ───

/** Ищет значение среди возможных имён поля (с case-insensitive fallback) */
export function resolveField<T = unknown>(
  obj: Record<string, unknown>,
  ...candidates: string[]
): T | undefined {
  for (const key of candidates) {
    if (obj[key] !== undefined) return obj[key] as T;
  }
  const lowerMap = new Map<string, string>();
  for (const k of Object.keys(obj)) {
    lowerMap.set(k.toLowerCase(), k);
  }
  for (const key of candidates) {
    const actualKey = lowerMap.get(key.toLowerCase());
    if (actualKey && obj[actualKey] !== undefined) return obj[actualKey] as T;
  }
  return undefined;
}

export interface INormalizedDept {
  id: number;
  name: string;
  parentId: number | null;
}

interface IDepartmentHierarchyCache {
  childIdsByParentId: Map<number, number[]>;
  parentIdById: Map<number, number | null>;
}

function buildDepartmentHierarchy(departments: INormalizedDept[]): IDepartmentHierarchyCache {
  const deptIds = new Set<number>(departments.map(dept => dept.id));
  const childIdsByParentId = new Map<number, number[]>();
  const parentIdById = new Map<number, number | null>();

  for (const dept of departments) {
    const parentId = typeof dept.parentId === 'number' && deptIds.has(dept.parentId)
      ? dept.parentId
      : null;
    parentIdById.set(dept.id, parentId);

    if (parentId === null) continue;
    const siblings = childIdsByParentId.get(parentId) || [];
    siblings.push(dept.id);
    childIdsByParentId.set(parentId, siblings);
  }

  return { childIdsByParentId, parentIdById };
}

export function expandDepartmentIdsToDescendants(
  selectedIds: Set<number>,
  departments: INormalizedDept[],
): Set<number> {
  if (selectedIds.size === 0) return new Set();

  const { childIdsByParentId } = buildDepartmentHierarchy(departments);
  const expanded = new Set<number>();
  const queue = [...selectedIds];

  while (queue.length > 0) {
    const currentId = queue.pop()!;
    if (expanded.has(currentId)) continue;

    expanded.add(currentId);
    const childIds = childIdsByParentId.get(currentId) || [];
    for (const childId of childIds) {
      if (!expanded.has(childId)) queue.push(childId);
    }
  }

  return expanded;
}

export function expandDepartmentIdsToAncestors(
  selectedIds: Set<number>,
  departments: INormalizedDept[],
): Set<number> {
  if (selectedIds.size === 0) return new Set();

  const { parentIdById } = buildDepartmentHierarchy(departments);
  const expanded = new Set<number>(selectedIds);

  for (const deptId of selectedIds) {
    let parentId = parentIdById.get(deptId) ?? null;
    while (parentId !== null && !expanded.has(parentId)) {
      expanded.add(parentId);
      parentId = parentIdById.get(parentId) ?? null;
    }
  }

  return expanded;
}

export function normalizeDepartment(raw: Record<string, unknown>): INormalizedDept {
  return {
    id: resolveField<number>(raw, 'id', 'ID', 'Id') ?? 0,
    name: (resolveField<string>(raw, 'name', 'title', 'NAME', 'Name', 'Title') ?? '').trim(),
    parentId: resolveField<number | null>(raw, 'parentId', 'parentDepartmentId', 'parent_id', 'PARENTID', 'ParentId') ?? null,
  };
}

export interface INormalizedEmployee {
  id: number | undefined;
  name: string;
  departmentId: number | undefined;
  positionId: number | undefined;
  position: string;
}

export function normalizeEmployee(raw: Record<string, unknown>): INormalizedEmployee {
  return {
    id: resolveField<number>(raw, 'id', 'ID', 'Id'),
    name: (resolveField<string>(raw, 'name', 'NAME', 'Name', 'fullName', 'full_name') ?? '').trim(),
    departmentId: resolveField<number>(raw, 'departmentId', 'department_id', 'DEPARTMENTID', 'DepartmentId'),
    positionId: resolveField<number>(raw, 'positionId', 'position_id', 'POSITIONID', 'PositionId'),
    position: (resolveField<string>(raw, 'position', 'positionName', 'position_name', 'POSITION', 'jobTitle') ?? '').trim(),
  };
}

/** Логирует образец данных и предупреждает о несовпадении полей */
export function logSampleAndWarn(label: string, sample: Record<string, unknown>, expectedFields: string[]) {
  const keys = Object.keys(sample);
  console.log(`[${label}] SAMPLE keys: [${keys.join(', ')}]`);
  console.log(`[${label}] SAMPLE data:`, JSON.stringify(sample, null, 2));
  const missing = expectedFields.filter(f => sample[f] === undefined);
  if (missing.length > 0) {
    console.warn(`[${label}] WARNING: expected fields missing: [${missing.join(', ')}]. Available: [${keys.join(', ')}]`);
  }
}

/** Нормализация ФИО: lowercase + trim + схлопывание множественных пробелов */
export function normalizePersonName(s: string): string {
  return (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

export function isSystemDepartment(name: string): boolean {
  return SIGUR_SYSTEM_DEPARTMENTS.includes(name.toLowerCase().trim());
}

/** Загружает whitelist отделов из skud_sync_department_filter. null = фильтр не задан (синхронизировать все) */
export async function getWhitelistedDepartmentIds(): Promise<Set<number> | null> {
  const { data } = await supabase
    .from('skud_sync_department_filter')
    .select('sigur_department_id');

  if (!data || data.length === 0) return null;
  return new Set(data.map(d => d.sigur_department_id));
}

export const SYNC_ALL_STEP_ORDER = [
  'departments',
  'positions',
  'employees',
] as const;

export type SyncAllStepName = typeof SYNC_ALL_STEP_ORDER[number];

export interface IWhitelistedEmployeesCache {
  data: Record<string, unknown>[];
  allowedNames: Set<string>;
  allowedSigurIds: Set<number>;
}

export interface ISyncContext {
  departmentsRaw?: Record<string, unknown>[];
  normalizedDepartments?: INormalizedDept[];
  departmentHierarchy?: IDepartmentHierarchyCache;
  positionsRaw?: Record<string, unknown>[] | null;
  whitelistDepartmentIds?: Set<number> | null;
  expandedWhitelistDepartmentIds?: Set<number> | null;
  whitelistedSigurEmployees?: IWhitelistedEmployeesCache | null;
}

export async function getDepartmentsRaw(
  connection?: 'external' | 'internal',
  context?: ISyncContext,
): Promise<Record<string, unknown>[]> {
  if (context?.departmentsRaw) {
    return context.departmentsRaw;
  }

  const departments = await sigurService.getDepartments(connection) as Record<string, unknown>[];
  if (context) {
    context.departmentsRaw = departments;
  }
  return departments;
}

export async function getPositionsRaw(
  connection?: 'external' | 'internal',
  context?: ISyncContext,
): Promise<Record<string, unknown>[] | null> {
  if (context && context.positionsRaw !== undefined) {
    return context.positionsRaw;
  }

  const positions = await sigurService.getPositions(connection);
  if (context) {
    context.positionsRaw = positions;
  }
  return positions;
}

async function getNormalizedDepartmentsCached(
  connection?: 'external' | 'internal',
  context?: ISyncContext,
): Promise<INormalizedDept[]> {
  if (context?.normalizedDepartments) {
    return context.normalizedDepartments;
  }

  const departments = (await getDepartmentsRaw(connection, context)).map(normalizeDepartment);
  if (context) {
    context.normalizedDepartments = departments;
  }
  return departments;
}

async function getDepartmentHierarchyCached(
  connection?: 'external' | 'internal',
  context?: ISyncContext,
): Promise<IDepartmentHierarchyCache> {
  if (context?.departmentHierarchy) {
    return context.departmentHierarchy;
  }

  const departments = await getNormalizedDepartmentsCached(connection, context);
  const hierarchy = buildDepartmentHierarchy(departments);
  if (context) {
    context.departmentHierarchy = hierarchy;
  }
  return hierarchy;
}

export async function getWhitelistedDepartmentIdsCached(
  connection?: 'external' | 'internal',
  context?: ISyncContext,
): Promise<Set<number> | null> {
  if (context && context.expandedWhitelistDepartmentIds !== undefined) {
    return context.expandedWhitelistDepartmentIds;
  }

  const whitelist = await getWhitelistedDepartmentIds();
  if (!whitelist || whitelist.size === 0) {
    if (context) {
      context.whitelistDepartmentIds = whitelist;
      context.expandedWhitelistDepartmentIds = whitelist;
    }
    return whitelist;
  }

  if (context) {
    context.whitelistDepartmentIds = whitelist;
  }

  const departments = await getNormalizedDepartmentsCached(connection, context);
  const expandedWhitelist = expandDepartmentIdsToDescendants(whitelist, departments);
  await getDepartmentHierarchyCached(connection, context);

  if (context) {
    context.expandedWhitelistDepartmentIds = expandedWhitelist;
  }
  return expandedWhitelist;
}

export function buildWhitelistedEmployeesCache(data: Record<string, unknown>[]): IWhitelistedEmployeesCache {
  const allowedNames = new Set<string>();
  const allowedSigurIds = new Set<number>();

  for (const emp of data) {
    const name = normalizePersonName((emp.name as string) || '');
    if (name) {
      allowedNames.add(name);
    }
    if (typeof emp.id === 'number') {
      allowedSigurIds.add(emp.id);
    }
  }

  return { data, allowedNames, allowedSigurIds };
}

export async function getWhitelistedDbEmployeeSets(
  whitelist: Set<number>,
): Promise<{ allowedNames: Set<string>; allowedSigurIds: Set<number> } | null> {
  const { data: dbDepartments } = await supabase
    .from('org_departments')
    .select('id, sigur_department_id')
    .in('sigur_department_id', [...whitelist]);

  const allowedDepartmentIds = (dbDepartments || []).map(dept => dept.id);
  if (allowedDepartmentIds.length === 0) {
    return null;
  }

  // Пагинация для обхода лимита Supabase (1000 строк)
  const PAGE = 1000;
  const allEmployees: Array<{ full_name: string; sigur_employee_id: number | null }> = [];

  // Сотрудники в разрешённых отделах
  let from = 0;
  while (true) {
    const { data } = await supabase
      .from('employees')
      .select('full_name, sigur_employee_id')
      .eq('is_archived', false)
      .in('org_department_id', allowedDepartmentIds)
      .range(from, from + PAGE - 1);
    if (!data || data.length === 0) break;
    allEmployees.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  // Также включаем сотрудников без отдела — они не должны отсекаться whitelist'ом
  from = 0;
  while (true) {
    const { data } = await supabase
      .from('employees')
      .select('full_name, sigur_employee_id')
      .eq('is_archived', false)
      .is('org_department_id', null)
      .range(from, from + PAGE - 1);
    if (!data || data.length === 0) break;
    allEmployees.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  const allowedNames = new Set<string>();
  const allowedSigurIds = new Set<number>();

  for (const employee of allEmployees) {
    const name = normalizePersonName(employee.full_name || '');
    if (name) {
      allowedNames.add(name);
    }
    if (employee.sigur_employee_id != null) {
      allowedSigurIds.add(employee.sigur_employee_id);
    }
  }

  return { allowedNames, allowedSigurIds };
}

export async function getWhitelistedSigurEmployees(
  connection: 'external' | 'internal' | undefined,
  context?: ISyncContext,
  onProgress?: (data: Record<string, unknown>) => void,
): Promise<Record<string, unknown>[]> {
  const send = onProgress || (() => {});
  const whitelist = await getWhitelistedDepartmentIdsCached(connection, context);

  if (!whitelist || whitelist.size === 0) {
    return sigurService.getEmployeesCached(connection);
  }

  if (context?.whitelistedSigurEmployees?.data) {
    send({
      type: 'employees_progress',
      current: whitelist.size,
      total: whitelist.size,
      percent: 100,
      status: `Using whitelist cache: ${context.whitelistedSigurEmployees.data.length} employees`,
    });
    return context.whitelistedSigurEmployees.data;
  }

  try {
    send({
      type: 'employees_progress',
      current: 0,
      total: whitelist.size,
      percent: 5,
      status: 'Loading all employees once and filtering locally...',
    });

    const allEmployees = await sigurService.getEmployeesCached(connection);
    const filteredEmployees = allEmployees.filter(emp => {
      const normalized = normalizeEmployee(emp);
      return normalized.departmentId != null && whitelist.has(normalized.departmentId);
    });

    if (filteredEmployees.length > 0 || allEmployees.length === 0) {
      if (context) {
        context.whitelistedSigurEmployees = buildWhitelistedEmployeesCache(filteredEmployees);
      }
      send({
        type: 'employees_progress',
        current: whitelist.size,
        total: whitelist.size,
        percent: 100,
        status: `Filtered ${filteredEmployees.length} employees from ${allEmployees.length}`,
      });
      return filteredEmployees;
    }
  } catch (error) {
    console.warn('[syncEmployees] full employee fetch failed, falling back to department scan:', (error as Error).message);
  }

  send({
    type: 'employees_progress',
    current: 0,
    total: whitelist.size,
    percent: 0,
    status: `Loading by ${whitelist.size} departments...`,
  });

  const sigurEmployeesRaw = await sigurService.getEmployeesByDepartments(
    [...whitelist],
    connection,
    (loaded, deptIdx, totalDepts) => {
      send({
        type: 'employees_progress',
        current: deptIdx,
        total: totalDepts,
        percent: Math.round((deptIdx / totalDepts) * 100),
        status: `Departments loaded: ${deptIdx}/${totalDepts} (${loaded} employees)`,
      });
    },
  );

  if (context) {
    context.whitelistedSigurEmployees = buildWhitelistedEmployeesCache(sigurEmployeesRaw);
  }

  return sigurEmployeesRaw;
}
