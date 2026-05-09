import { createCache } from '../utils/cache.js';
import { sigurService } from './sigur.service.js';
import { getEmployeeAccessPointBindings } from './sigur-linked-employees.service.js';
import {
  normalizeDepartment,
  normalizeEmployee,
  resolveField,
} from './sigur-sync-shared.js';
import type { ConnectionType } from './sigur-base.service.js';
import {
  loadAccessPointObjectMetaMap,
  normalizeAccessPointKey,
  type IAccessPointObjectMeta,
} from './sigur-access-point-meta.service.js';

export interface IAccessPointBinding {
  accessPointId: number;
  accessPointName: string | null;
  objectId: string | null;
  objectName: string | null;
  hasMapPreview: boolean;
}

export interface IAccessPointOption {
  id: number;
  name: string;
  objectId: string | null;
  objectName: string | null;
  hasMapPreview: boolean;
}

export interface ISigurDepartmentNode {
  id: number;
  parentId: number | null;
  name: string;
  hasChildren: boolean;
  employeeCount: number;
  employeeCountLoaded?: boolean;
  children?: ISigurDepartmentNode[];
}

export interface ISigurPositionSummary {
  id: number;
  name: string;
}

export interface ISigurEmployeeSummary {
  id: number;
  name: string;
  departmentId: number | null;
  departmentName: string | null;
  positionId: number | null;
  positionName: string | null;
  tabId: string | null;
  blocked: boolean | null;
}

export type SigurEmployeeCardAccessState =
  | 'active'
  | 'expired'
  | 'no_card'
  | 'no_expiration'
  | 'unknown';

export interface ISigurEmployeeCardAccessStatus {
  employeeId: number;
  state: SigurEmployeeCardAccessState;
  expirationDate: string | null;
  hasCard: boolean;
}

export interface ISigurDepartmentCountsResult {
  byDepartment: Record<string, number>;
  loading: boolean;
  complete: boolean;
  processedEmployees: number;
  totalEmployees: number | null;
}

export interface ISigurEmployeeListResult {
  items: ISigurEmployeeSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ISigurEmployeeProfile {
  sigurEmployeeId: number;
  profile: {
    fullName: string;
    departmentId: number | null;
    departmentName: string | null;
    positionId: number | null;
    positionName: string | null;
    tabNumber: string | null;
    description: string | null;
    blocked: boolean | null;
  };
  cards: Array<{
    cardId: number;
    cardNumber: string | null;
    status: string | null;
    startDate: string | null;
    expirationDate: string | null;
    issued: boolean | null;
  }>;
  accessRules: Array<{ accessRuleId: number; accessRuleName: string | null }>;
  accessRuleOptions: Array<{ accessRuleId: number; accessRuleName: string | null }>;
  accessPoints: IAccessPointBinding[];
  accessPointOptions: IAccessPointOption[];
}

export interface ISigurEmployeeUpsertInput {
  name?: string;
  departmentId?: number | null;
  positionId?: number | null;
  tabId?: string | null;
  description?: string | null;
  blocked?: boolean | null;
}

export interface ISigurDepartmentUpsertInput {
  name: string;
  parentId?: number | null;
}

const EMPLOYEE_CARD_STATUS_CACHE_TTL_MS = 5 * 60 * 1000;

const employeeCardStatusCache = createCache<ISigurEmployeeCardAccessStatus>({
  max: 10000,
  ttlMs: EMPLOYEE_CARD_STATUS_CACHE_TTL_MS,
});

function buildEmployeeCardStatusCacheKey(
  employeeId: number,
  connection?: ConnectionType,
): string {
  return `${connection || 'default'}:${employeeId}`;
}

export function invalidateSigurDirectoryCaches(): void {
  employeeCardStatusCache.clear();
}

export function normalizeInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeSigurEmployeesCount(value: unknown): number | null {
  const normalized = normalizeInt(value);
  if (normalized != null && normalized >= 0) {
    return normalized;
  }

  if (Array.isArray(value)) {
    return value.length === 1 ? normalizeSigurEmployeesCount(value[0]) : null;
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const preferredKeys = ['count', 'total', 'totalCount', 'employeeCount'];
  for (const key of preferredKeys) {
    const count = normalizeSigurEmployeesCount(record[key]);
    if (count != null) return count;
  }

  return normalizeSigurEmployeesCount(record.data);
}

function normalizeBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n'].includes(normalized)) return false;
  }
  return null;
}

export function toCardSummary(raw: Record<string, unknown>): {
  cardId: number;
  cardNumber: string | null;
  status: string | null;
  format: string | null;
  startDate: string | null;
  expirationDate: string | null;
  issued: boolean | null;
} | null {
  const cardId = normalizeInt(resolveField(raw, 'cardId', 'card_id', 'cardID', 'cardid', 'id', 'ID', 'Id'));
  if (!cardId) return null;

  return {
    cardId,
    cardNumber: String(
      resolveField<string | number>(raw, 'cardNumber', 'card_number', 'number', 'Number')
      ?? '',
    ).trim() || null,
    status: String(resolveField<string>(raw, 'status', 'Status', 'state') || '').trim() || null,
    format: String(resolveField<string>(raw, 'format', 'Format', 'cardFormat') || '').trim() || null,
    startDate: String(
      resolveField<string>(raw, 'startDate', 'start_date', 'validFrom', 'startAt')
      || '',
    ).trim() || null,
    expirationDate: String(
      resolveField<string>(raw, 'expirationDate', 'expiration_date', 'expiresAt', 'expiryDate', 'validTo')
      || '',
    ).trim() || null,
    issued: normalizeBoolean(resolveField(raw, 'issued', 'Issued', 'is_issued', 'isIssued')),
  };
}

export function toAccessRuleBinding(raw: Record<string, unknown>): { employeeId: number; accessRuleId: number } | null {
  const employeeId = normalizeInt(resolveField(raw, 'employeeId', 'employee_id'));
  const accessRuleId = normalizeInt(resolveField(
    raw,
    'accessRuleId',
    'access_rule_id',
    'accessruleId',
    'accessRuleID',
  ));

  if (!employeeId || !accessRuleId) return null;
  return { employeeId, accessRuleId };
}

function toEmployeeCardBinding(raw: Record<string, unknown>): {
  employeeId: number;
  expirationDate: string | null;
  startDate: string | null;
} | null {
  const employeeId = normalizeInt(resolveField(raw, 'employeeId', 'employee_id'));
  if (!employeeId) return null;

  const expirationDate = String(
    resolveField<string>(raw, 'expirationDate', 'expiration_date', 'validTo')
    || '',
  ).trim() || null;
  const startDate = String(
    resolveField<string>(raw, 'startDate', 'start_date', 'validFrom')
    || '',
  ).trim() || null;

  return {
    employeeId,
    expirationDate,
    startDate,
  };
}

function deriveEmployeeCardAccessStatus(
  employeeId: number,
  bindings: Array<{ expirationDate: string | null; startDate: string | null }>,
): ISigurEmployeeCardAccessStatus {
  if (bindings.length === 0) {
    return {
      employeeId,
      state: 'no_card',
      expirationDate: null,
      hasCard: false,
    };
  }

  const now = Date.now();
  const validExpirations = bindings
    .map(binding => binding.expirationDate ? new Date(binding.expirationDate) : null)
    .filter((date): date is Date => !!date && !Number.isNaN(date.getTime()))
    .sort((left, right) => right.getTime() - left.getTime());

  if (bindings.some(binding => !binding.expirationDate)) {
    return {
      employeeId,
      state: 'no_expiration',
      expirationDate: null,
      hasCard: true,
    };
  }

  const latestExpiration = validExpirations[0] || null;
  if (!latestExpiration) {
    return {
      employeeId,
      state: 'unknown',
      expirationDate: null,
      hasCard: true,
    };
  }

  return {
    employeeId,
    state: latestExpiration.getTime() >= now ? 'active' : 'expired',
    expirationDate: latestExpiration.toISOString(),
    hasCard: true,
  };
}

export function enrichAccessPointBinding(
  binding: { accessPointId: number; accessPointName: string | null },
  metaMap: Map<string, IAccessPointObjectMeta>,
): IAccessPointBinding {
  const meta = binding.accessPointName ? metaMap.get(normalizeAccessPointKey(binding.accessPointName)) : undefined;
  return {
    accessPointId: binding.accessPointId,
    accessPointName: binding.accessPointName,
    objectId: meta?.objectId || null,
    objectName: meta?.objectName || null,
    hasMapPreview: meta?.hasMapPreview === true,
  };
}

function toAccessPointOption(
  raw: Record<string, unknown>,
  metaMap: Map<string, IAccessPointObjectMeta>,
): IAccessPointOption | null {
  const id = normalizeInt(resolveField(raw, 'id', 'ID', 'Id'));
  const name = String(resolveField<string>(raw, 'name', 'Name', 'title') || '').trim();
  if (!id || !name) return null;

  const meta = metaMap.get(normalizeAccessPointKey(name));
  return {
    id,
    name,
    objectId: meta?.objectId || null,
    objectName: meta?.objectName || null,
    hasMapPreview: meta?.hasMapPreview === true,
  };
}

export function collectSigurDepartmentDescendantIds(
  departmentId: number,
  departments: Array<{ id: number; parentId: number | null }>,
): Set<number> {
  const childIdsByParentId = new Map<number, number[]>();
  for (const department of departments) {
    if (department.parentId == null) continue;
    const children = childIdsByParentId.get(department.parentId) || [];
    children.push(department.id);
    childIdsByParentId.set(department.parentId, children);
  }

  const ids = new Set<number>();
  const queue = [departmentId];
  while (queue.length > 0) {
    const currentId = queue.pop()!;
    if (ids.has(currentId)) continue;
    ids.add(currentId);
    for (const childId of childIdsByParentId.get(currentId) || []) {
      if (!ids.has(childId)) queue.push(childId);
    }
  }

  return ids;
}

export function normalizeSigurEmployeeSummary(
  raw: Record<string, unknown>,
  departmentMap: Map<number, string>,
): ISigurEmployeeSummary | null {
  const normalized = normalizeEmployee(raw);
  if (!normalized.id || !normalized.name) return null;

  const departmentName = String(
    resolveField<string>(raw, 'departmentName', 'department_name')
    || (normalized.departmentId ? departmentMap.get(normalized.departmentId) || '' : ''),
  ).trim() || null;

  return {
    id: normalized.id,
    name: normalized.name,
    departmentId: normalized.departmentId || null,
    departmentName,
    positionId: normalized.positionId || null,
    positionName: normalized.position || null,
    tabId: normalized.tabId || null,
    blocked: normalizeBoolean(resolveField(raw, 'isBlocked', 'blocked', 'IsBlocked')),
  };
}

export function buildSigurDepartmentTree(
  departments: Array<{ id: number; parentId: number | null; name: string }>,
  employees: ISigurEmployeeSummary[],
  employeeCountLoaded = true,
): ISigurDepartmentNode[] {
  const directEmployeeCounts = new Map<number, number>();
  for (const employee of employees) {
    if (employee.departmentId == null) continue;
    directEmployeeCounts.set(
      employee.departmentId,
      (directEmployeeCounts.get(employee.departmentId) || 0) + 1,
    );
  }

  return buildSigurDepartmentTreeWithCounts(departments, directEmployeeCounts, employeeCountLoaded);
}

function buildSigurDepartmentTreeWithCounts(
  departments: Array<{ id: number; parentId: number | null; name: string }>,
  directEmployeeCounts: Map<number, number>,
  employeeCountLoaded = true,
): ISigurDepartmentNode[] {

  const byId = new Map<number, ISigurDepartmentNode>();
  for (const department of departments) {
    byId.set(department.id, {
      id: department.id,
      parentId: department.parentId,
      name: department.name,
      hasChildren: false,
      employeeCount: directEmployeeCounts.get(department.id) || 0,
      employeeCountLoaded,
      children: [],
    });
  }

  const roots: ISigurDepartmentNode[] = [];
  for (const department of departments) {
    const node = byId.get(department.id)!;
    if (department.parentId != null && byId.has(department.parentId)) {
      const parent = byId.get(department.parentId)!;
      parent.children = parent.children || [];
      parent.children.push(node);
      parent.hasChildren = true;
    } else {
      roots.push(node);
    }
  }

  const sortNodes = (nodes: ISigurDepartmentNode[]): void => {
    nodes.sort((left, right) => left.name.localeCompare(right.name, 'ru'));
    for (const node of nodes) {
      if (node.children && node.children.length > 0) {
        sortNodes(node.children);
      }
    }
  };

  const aggregateCounts = (nodes: ISigurDepartmentNode[]): number => {
    let total = 0;
    for (const node of nodes) {
      const childTotal = node.children && node.children.length > 0
        ? aggregateCounts(node.children)
        : 0;
      node.employeeCount += childTotal;
      total += node.employeeCount;
      node.hasChildren = !!node.children?.length;
    }
    return total;
  };

  sortNodes(roots);
  aggregateCounts(roots);
  return roots;
}

function sumDirectEmployeeCounts(counts: Map<number, number>): number {
  let total = 0;
  for (const value of counts.values()) {
    total += value;
  }
  return total;
}

function buildDepartmentParentMap(
  departments: Array<{ id: number; parentId: number | null; name: string }>,
): Map<number, number | null> {
  return new Map(departments.map(department => [department.id, department.parentId]));
}

export function collectAncestorDepartmentIds(
  departmentId: number,
  departments: Array<{ id: number; parentId: number | null; name: string }>,
): Set<number> {
  const parentMap = buildDepartmentParentMap(departments);
  const ids = new Set<number>();
  let currentId: number | null | undefined = departmentId;

  while (currentId != null && !ids.has(currentId)) {
    ids.add(currentId);
    currentId = parentMap.get(currentId) ?? null;
  }

  return ids;
}

export function normalizeDepartmentIds(departmentIds: number[]): number[] {
  const normalized: number[] = [];
  const seen = new Set<number>();

  for (const departmentId of departmentIds) {
    if (!Number.isFinite(departmentId) || departmentId <= 0 || seen.has(departmentId)) {
      continue;
    }
    seen.add(departmentId);
    normalized.push(departmentId);
  }

  return normalized;
}

export function collapseNestedDepartmentSelection(
  departmentIds: number[],
  departments: Array<{ id: number; parentId: number | null; name: string }>,
): number[] {
  const selected = new Set(departmentIds);
  const parentMap = buildDepartmentParentMap(departments);

  return departmentIds.filter(departmentId => {
    let currentParent = parentMap.get(departmentId) ?? null;

    while (currentParent != null) {
      if (selected.has(currentParent)) {
        return false;
      }
      currentParent = parentMap.get(currentParent) ?? null;
    }

    return true;
  });
}

function flattenDepartmentCounts(
  nodes: ISigurDepartmentNode[],
  target: Record<string, number> = {},
): Record<string, number> {
  for (const node of nodes) {
    target[String(node.id)] = node.employeeCount;
    if (node.children?.length) {
      flattenDepartmentCounts(node.children, target);
    }
  }
  return target;
}

export async function getNormalizedDepartments(connection?: ConnectionType): Promise<Array<{ id: number; parentId: number | null; name: string }>> {
  const departments = await sigurService.getDepartmentsCached(connection);
  return departments
    .map(raw => normalizeDepartment(raw))
    .filter(department => Number.isFinite(department.id) && department.id > 0 && !!department.name)
    .map(department => ({
      id: department.id,
      parentId: department.parentId || null,
      name: department.name,
    }))
    .sort((left, right) => left.name.localeCompare(right.name, 'ru'));
}

async function getDirectDepartmentCounts(
  connection?: ConnectionType,
): Promise<Map<number, number>> {
  try {
    return await sigurService.getEmployeeCountByDepartmentCached(connection);
  } catch (error) {
    console.warn('Sigur live admin department counts warning:', error);
    return new Map<number, number>();
  }
}

function buildEmployeeSearchVariants(search: string): Record<string, unknown>[] {
  const trimmed = search.trim();
  if (!trimmed) return [{}];

  // Чисто цифровой ввод — пробуем сразу по Sigur id и по табельному (STARTS_WITH), потом сольём.
  if (/^\d+$/.test(trimmed)) {
    const variants: Record<string, unknown>[] = [];
    const asId = Number(trimmed);
    if (Number.isFinite(asId) && asId > 0) {
      variants.push({ id: asId });
    }
    variants.push({ 'tabId[STARTS_WITH]': trimmed });
    return variants;
  }

  const looksLikeTabSearch = /^[A-Za-z0-9\-_/]+$/.test(trimmed) && /\d/.test(trimmed) && !/\s/.test(trimmed);
  if (looksLikeTabSearch) {
    return [{ 'tabId[STARTS_WITH]': trimmed }];
  }

  return [{ name: trimmed }];
}

function buildSearchHaystack(employee: ISigurEmployeeSummary): string {
  return [
    employee.name,
    employee.departmentName,
    employee.positionName,
    employee.tabId,
    String(employee.id),
  ]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase('ru');
}

async function searchEmployeesDirectly(
  search: string,
  departmentNameMap: Map<number, string>,
  pagination: { page: number; pageSize: number },
  connection?: ConnectionType,
  departmentId?: number | null,
  blocked?: boolean | null,
): Promise<ISigurEmployeeListResult> {
  const safePageSize = Math.min(500, Math.max(1, pagination.pageSize || 200));
  const safePage = Math.max(1, pagination.page || 1);
  const offset = (safePage - 1) * safePageSize;
  const variants = buildEmployeeSearchVariants(search);
  const commonFilters = {
    ...(departmentId != null ? { departmentId } : {}),
    ...(blocked == null ? {} : { blocked }),
  };

  // Для каждого варианта (name / id / tabId) делаем параллельный запрос и сливаем по sigur id.
  const pageResults = await Promise.all(
    variants.map(variant =>
      sigurService
        .getEmployeesPage({ ...commonFilters, ...variant }, { limit: safePageSize, offset }, connection)
        .catch(() => [] as Record<string, unknown>[]),
    ),
  );
  const firstVariantFilters = { ...commonFilters, ...(variants[0] ?? {}) };
  const countRaw = await sigurService.getEmployeesCount(firstVariantFilters, connection).catch(() => null);

  const seen = new Set<number>();
  const items: ISigurEmployeeSummary[] = [];
  for (const batch of pageResults) {
    for (const raw of batch) {
      const summary = normalizeSigurEmployeeSummary(raw, departmentNameMap);
      if (!summary) continue;
      if (seen.has(summary.id)) continue;
      if (!buildSearchHaystack(summary).includes(search.toLocaleLowerCase('ru'))) continue;
      seen.add(summary.id);
      items.push(summary);
    }
  }
  items.sort((left, right) => left.name.localeCompare(right.name, 'ru'));

  const total = variants.length > 1
    ? items.length
    : (normalizeSigurEmployeesCount(countRaw) ?? items.length);
  return {
    items,
    total,
    page: safePage,
    pageSize: safePageSize,
  };
}

export async function listSigurDepartmentsTree(connection?: ConnectionType): Promise<ISigurDepartmentNode[]> {
  const [departments, directCounts] = await Promise.all([
    getNormalizedDepartments(connection),
    getDirectDepartmentCounts(connection),
  ]);
  return buildSigurDepartmentTreeWithCounts(departments, directCounts, true);
}

export async function listSigurDepartmentCounts(connection?: ConnectionType): Promise<ISigurDepartmentCountsResult> {
  const [departments, directCounts] = await Promise.all([
    getNormalizedDepartments(connection),
    getDirectDepartmentCounts(connection),
  ]);
  const tree = buildSigurDepartmentTreeWithCounts(departments, directCounts, true);

  return {
    byDepartment: flattenDepartmentCounts(tree),
    loading: false,
    complete: true,
    processedEmployees: sumDirectEmployeeCounts(directCounts),
    totalEmployees: sumDirectEmployeeCounts(directCounts),
  };
}

export async function listSigurEmployees(
  filters: {
    departmentId?: number | null;
    search?: string | null;
    blocked?: boolean | null;
  },
  pagination: { page?: number | null; pageSize?: number | null } = {},
  connection?: ConnectionType,
): Promise<ISigurEmployeeListResult> {
  const departments = await getNormalizedDepartments(connection);
  const departmentNameMap = new Map(departments.map(department => [department.id, department.name]));
  const search = (filters.search || '').trim().toLocaleLowerCase('ru');
  const safePageSize = Math.min(500, Math.max(1, pagination.pageSize || 200));
  const safePage = Math.max(1, pagination.page || 1);
  const selectedDepartmentId = typeof filters.departmentId === 'number' && Number.isFinite(filters.departmentId)
    ? filters.departmentId
    : null;
  const blocked = filters.blocked ?? null;

  if (!selectedDepartmentId && search) {
    return searchEmployeesDirectly(
      search,
      departmentNameMap,
      { page: safePage, pageSize: safePageSize },
      connection,
      null,
      blocked,
    );
  }

  if (!selectedDepartmentId) {
    const offset = (safePage - 1) * safePageSize;
    const filters = blocked == null ? {} : { blocked };
    const [pageItems, countRaw] = await Promise.all([
      sigurService.getEmployeesPage(filters, { limit: safePageSize, offset }, connection),
      sigurService.getEmployeesCount(filters, connection).catch(() => null),
    ]);
    const items = pageItems
      .map(raw => normalizeSigurEmployeeSummary(raw, departmentNameMap))
      .filter((employee): employee is ISigurEmployeeSummary => !!employee)
      .sort((left, right) => left.name.localeCompare(right.name, 'ru'));
    let total = normalizeSigurEmployeesCount(countRaw);
    if (total == null) {
      total = blocked == null
        ? sumDirectEmployeeCounts(await getDirectDepartmentCounts(connection))
        : items.length;
    }
    return {
      items,
      total,
      page: safePage,
      pageSize: safePageSize,
    };
  }

  const selectedDepartment = departments.find(department => department.id === selectedDepartmentId) || null;
  if (!selectedDepartment) {
    return {
      items: [],
      total: 0,
      page: safePage,
      pageSize: safePageSize,
    };
  }

  if (search) {
    return searchEmployeesDirectly(
      search,
      departmentNameMap,
      { page: safePage, pageSize: safePageSize },
      connection,
      selectedDepartmentId,
      blocked,
    );
  }

  const offset = (safePage - 1) * safePageSize;
  const employeeFilters = { departmentId: selectedDepartmentId, ...(blocked == null ? {} : { blocked }) };
  const [pageItems, countRaw, directCounts] = await Promise.all([
    sigurService.getEmployeesPage(
      employeeFilters,
      { limit: safePageSize, offset },
      connection,
    ),
    blocked == null
      ? Promise.resolve(null)
      : sigurService.getEmployeesCount(employeeFilters, connection).catch(() => null),
    blocked == null
      ? getDirectDepartmentCounts(connection)
      : Promise.resolve(new Map<number, number>()),
  ]);
  const items = pageItems
    .map(raw => normalizeSigurEmployeeSummary(raw, departmentNameMap))
    .filter((employee): employee is ISigurEmployeeSummary => !!employee)
    .sort((left, right) => left.name.localeCompare(right.name, 'ru'));

  return {
    items,
    total: blocked == null
      ? (directCounts.get(selectedDepartmentId) || 0)
      : (normalizeSigurEmployeesCount(countRaw) ?? items.length),
    page: safePage,
    pageSize: safePageSize,
  };
}

export async function listSigurAccessPointOptions(
  connection?: ConnectionType,
): Promise<IAccessPointOption[]> {
  const [accessPointPairs, accessPointObjectMeta] = await Promise.all([
    sigurService.getAccessPointOptionsCached(connection),
    loadAccessPointObjectMetaMap(),
  ]);
  return accessPointPairs
    .map(({ id, name }) => {
      const meta = accessPointObjectMeta.get(normalizeAccessPointKey(name));
      return {
        id,
        name,
        objectId: meta?.objectId || null,
        objectName: meta?.objectName || null,
        hasMapPreview: meta?.hasMapPreview === true,
      } satisfies IAccessPointOption;
    })
    .sort((left, right) => left.name.localeCompare(right.name, 'ru'));
}

export async function getSigurEmployeeProfile(
  sigurEmployeeId: number,
  options: { includeAccessPointCatalog?: boolean } = {},
  connection?: ConnectionType,
): Promise<ISigurEmployeeProfile> {
  const includeAccessPointCatalog = options.includeAccessPointCatalog === true;
  const accessPointObjectMetaPromise = loadAccessPointObjectMetaMap();
  const cachedRemoteEmployee = sigurService.findEmployeeInCache(sigurEmployeeId);

  const [
    remoteEmployeeRaw,
    departmentMap,
    accessRuleCatalog,
    accessPointObjectMeta,
    accessPointOptions,
    cardBindingsResult,
    accessRuleBindingsResult,
    accessPoints,
    cardsCatalog,
  ] = await Promise.all([
    cachedRemoteEmployee
      ? Promise.resolve(cachedRemoteEmployee)
      : sigurService.getEmployeeById(sigurEmployeeId, connection),
    sigurService.getDepartmentMapCached(connection),
    sigurService.getAccessRuleMapCached(connection).catch(error => {
      console.warn('Sigur live admin access rule catalog warning:', error);
      return null;
    }),
    accessPointObjectMetaPromise,
    includeAccessPointCatalog
      ? sigurService.getAccessPointOptionsCached(connection).catch(error => {
        console.warn('Sigur live admin access point catalog warning:', error);
        return [];
      })
      : Promise.resolve([]),
    sigurService.getCardBindings({ employeeId: sigurEmployeeId }, connection)
      .then(value => ({ status: 'fulfilled', value }) as const)
      .catch(reason => ({ status: 'rejected', reason }) as const),
    sigurService.getEmployeeAccessRuleBindings({ employeeId: sigurEmployeeId }, connection)
      .then(value => ({ status: 'fulfilled', value }) as const)
      .catch(reason => ({ status: 'rejected', reason }) as const),
    getEmployeeAccessPointBindings(sigurEmployeeId, connection, true)
      .then(value => ({ status: 'fulfilled', value }) as const)
      .catch(reason => ({ status: 'rejected', reason }) as const),
    sigurService.getCardsCached(connection).catch(error => {
      console.warn('Sigur live admin cards catalog warning:', error);
      return [] as Record<string, unknown>[];
    }),
  ]);

  const employee = normalizeSigurEmployeeSummary(remoteEmployeeRaw, departmentMap);
  if (!employee) {
    const error = new Error('Сотрудник Sigur не найден');
    (error as Error & { status?: number }).status = 404;
    throw error;
  }

  const description = String(
    resolveField<string>(remoteEmployeeRaw, 'description', 'Description')
    || '',
  ).trim() || null;

  const cardsCatalogById = new Map<number, Record<string, unknown>>();
  for (const rawCard of cardsCatalog) {
    const cardId = normalizeInt(resolveField(rawCard, 'cardId', 'card_id', 'cardID', 'cardid', 'id', 'ID', 'Id'));
    if (cardId) cardsCatalogById.set(cardId, rawCard);
  }

  const cards = cardBindingsResult.status === 'fulfilled'
    ? (cardBindingsResult.value as Record<string, unknown>[])
      .map(raw => toCardSummary(raw))
      .filter((card): card is NonNullable<ReturnType<typeof toCardSummary>> => !!card)
      .map(card => {
        const catalogEntry = cardsCatalogById.get(card.cardId);
        if (!catalogEntry) return card;
        const issuedFromCatalog = normalizeBoolean(resolveField(catalogEntry, 'issued', 'Issued', 'is_issued', 'isIssued'));
        return issuedFromCatalog === null ? card : { ...card, issued: issuedFromCatalog };
      })
      .sort((left, right) => (left.cardNumber || '').localeCompare(right.cardNumber || '', 'ru'))
    : [];

  const accessRules = accessRuleBindingsResult.status === 'fulfilled'
    ? (accessRuleBindingsResult.value as Record<string, unknown>[])
      .map(raw => toAccessRuleBinding(raw))
      .filter((binding): binding is NonNullable<ReturnType<typeof toAccessRuleBinding>> => !!binding && binding.employeeId === sigurEmployeeId)
      .map(binding => ({
        accessRuleId: binding.accessRuleId,
        accessRuleName: accessRuleCatalog?.get(binding.accessRuleId) || null,
      }))
      .sort((left, right) => (left.accessRuleName || '').localeCompare(right.accessRuleName || '', 'ru'))
    : [];

  const employeeAccessPoints = accessPoints.status === 'fulfilled'
    ? accessPoints.value.map(binding => enrichAccessPointBinding(binding, accessPointObjectMeta))
    : [];

  return {
    sigurEmployeeId,
    profile: {
      fullName: employee.name,
      departmentId: employee.departmentId,
      departmentName: employee.departmentName,
      positionId: employee.positionId,
      positionName: employee.positionName,
      tabNumber: employee.tabId,
      description,
      blocked: employee.blocked,
    },
    cards,
    accessRules,
    accessRuleOptions: accessRuleCatalog
      ? [...accessRuleCatalog.entries()]
        .map(([accessRuleId, accessRuleName]) => ({ accessRuleId, accessRuleName }))
        .sort((left, right) => (left.accessRuleName || '').localeCompare(right.accessRuleName || '', 'ru'))
      : [],
    accessPoints: employeeAccessPoints,
    accessPointOptions: accessPointOptions
      .map(point => toAccessPointOption(point as unknown as Record<string, unknown>, accessPointObjectMeta))
      .filter((point): point is IAccessPointOption => !!point),
  };
}

async function fetchCardBindingsForEmployee(
  employeeId: number,
  connection?: ConnectionType,
): Promise<Array<{ expirationDate: string | null; startDate: string | null }>> {
  const raw = await sigurService.getCardBindings({ employeeId }, connection) as Record<string, unknown>[];
  return raw
    .map(item => toEmployeeCardBinding(item))
    .filter((item): item is NonNullable<ReturnType<typeof toEmployeeCardBinding>> => !!item && item.employeeId === employeeId)
    .map(item => ({
      expirationDate: item.expirationDate,
      startDate: item.startDate,
    }));
}

export async function getSigurEmployeeCardStatuses(
  employeeIds: number[],
  connection?: ConnectionType,
): Promise<ISigurEmployeeCardAccessStatus[]> {
  const normalizedIds = [...new Set(
    employeeIds
      .map(value => Number(value))
      .filter(value => Number.isFinite(value) && value > 0),
  )];

  if (normalizedIds.length === 0) {
    return [];
  }

  const byEmployeeId = new Map<number, ISigurEmployeeCardAccessStatus>();
  const missingIds: number[] = [];

  normalizedIds.forEach(employeeId => {
    const cached = employeeCardStatusCache.get(buildEmployeeCardStatusCacheKey(employeeId, connection));
    if (cached) {
      byEmployeeId.set(employeeId, cached);
    } else {
      missingIds.push(employeeId);
    }
  });

  if (missingIds.length > 0) {
    const unresolvedIds = new Set<number>(missingIds);

    try {
      const batchedRaw = await sigurService.getCardBindings({ employeeId: missingIds.join(',') }, connection) as Record<string, unknown>[];
      const grouped = new Map<number, Array<{ expirationDate: string | null; startDate: string | null }>>();

      batchedRaw
        .map(item => toEmployeeCardBinding(item))
        .filter((item): item is NonNullable<ReturnType<typeof toEmployeeCardBinding>> => !!item && unresolvedIds.has(item.employeeId))
        .forEach(item => {
          const bucket = grouped.get(item.employeeId) || [];
          bucket.push({ expirationDate: item.expirationDate, startDate: item.startDate });
          grouped.set(item.employeeId, bucket);
        });

      if (grouped.size > 1 || (grouped.size === 1 && missingIds.length === 1)) {
        for (const employeeId of missingIds) {
          const status = deriveEmployeeCardAccessStatus(employeeId, grouped.get(employeeId) || []);
          byEmployeeId.set(employeeId, status);
          employeeCardStatusCache.set(buildEmployeeCardStatusCacheKey(employeeId, connection), status);
          unresolvedIds.delete(employeeId);
        }
      }
    } catch (error) {
      console.warn('Sigur employee card status batch fetch warning:', error);
    }

    const remainingIds = [...unresolvedIds];
    const concurrency = 8;

    for (let index = 0; index < remainingIds.length; index += concurrency) {
      const chunk = remainingIds.slice(index, index + concurrency);
      const statuses = await Promise.all(chunk.map(async employeeId => {
        try {
          const bindings = await fetchCardBindingsForEmployee(employeeId, connection);
          return deriveEmployeeCardAccessStatus(employeeId, bindings);
        } catch (error) {
          console.warn(`Sigur employee card status fetch warning for ${employeeId}:`, error);
          return {
            employeeId,
            state: 'unknown' as const,
            expirationDate: null,
            hasCard: false,
          };
        }
      }));

      statuses.forEach(status => {
        byEmployeeId.set(status.employeeId, status);
        employeeCardStatusCache.set(buildEmployeeCardStatusCacheKey(status.employeeId, connection), status);
      });
    }
  }

  return normalizedIds.map(employeeId => (
    byEmployeeId.get(employeeId) || {
      employeeId,
      state: 'unknown',
      expirationDate: null,
      hasCard: false,
    }
  ));
}

