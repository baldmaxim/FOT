import { supabase } from '../config/database.js';
import { createCache } from '../utils/cache.js';
import { sigurService } from './sigur.service.js';
import {
  getEmployeeAccessPointBindings,
  invalidateEmployeeAccessPointBindingsCache,
  replaceEmployeeAccessPointBindings,
} from './sigur-linked-employees.service.js';
import {
  normalizeDepartment,
  normalizeEmployee,
  resolveField,
} from './sigur-sync-shared.js';
import type { ConnectionType } from './sigur-base.service.js';

interface IAccessPointObjectMeta {
  objectId: string | null;
  objectName: string | null;
  hasMapPreview: boolean;
}

interface IAccessPointBinding {
  accessPointId: number;
  accessPointName: string | null;
  objectId: string | null;
  objectName: string | null;
  hasMapPreview: boolean;
}

interface IAccessPointOption {
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
    expirationDate: string | null;
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

const ACCESS_POINT_META_CACHE_TTL_MS = 5 * 60 * 1000;
const SUBTREE_EMPLOYEE_CACHE_TTL_MS = 60 * 1000;
const EMPLOYEE_CARD_STATUS_CACHE_TTL_MS = 5 * 60 * 1000;

const accessPointObjectMetaCache = createCache<{ map: Map<string, IAccessPointObjectMeta> }>({
  max: 1,
  ttlMs: ACCESS_POINT_META_CACHE_TTL_MS,
});
const subtreeEmployeeCache = createCache<{ items: ISigurEmployeeSummary[] }>({
  max: 100,
  ttlMs: SUBTREE_EMPLOYEE_CACHE_TTL_MS,
});
const employeeCardStatusCache = createCache<ISigurEmployeeCardAccessStatus>({
  max: 10000,
  ttlMs: EMPLOYEE_CARD_STATUS_CACHE_TTL_MS,
});

let accessPointObjectMetaInFlight: Promise<Map<string, IAccessPointObjectMeta>> | null = null;

function buildSubtreeEmployeeCacheKey(
  departmentId: number,
  connection?: ConnectionType,
): string {
  return `${connection || 'default'}:${departmentId}`;
}

function buildEmployeeCardStatusCacheKey(
  employeeId: number,
  connection?: ConnectionType,
): string {
  return `${connection || 'default'}:${employeeId}`;
}

function invalidateSigurDirectoryCaches(): void {
  subtreeEmployeeCache.clear();
  employeeCardStatusCache.clear();
}

function normalizeAccessPointKey(value: string | null | undefined): string {
  return value?.trim().toLocaleLowerCase('ru') || '';
}

function normalizeInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
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

function toCardSummary(raw: Record<string, unknown>): {
  cardId: number;
  cardNumber: string | null;
  status: string | null;
  startDate: string | null;
  expirationDate: string | null;
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
    startDate: String(
      resolveField<string>(raw, 'startDate', 'start_date', 'validFrom', 'startAt')
      || '',
    ).trim() || null,
    expirationDate: String(
      resolveField<string>(raw, 'expirationDate', 'expiration_date', 'expiresAt', 'expiryDate', 'validTo')
      || '',
    ).trim() || null,
  };
}

function toAccessRuleBinding(raw: Record<string, unknown>): { employeeId: number; accessRuleId: number } | null {
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

function enrichAccessPointBinding(
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

async function loadAccessPointObjectMetaMap(): Promise<Map<string, IAccessPointObjectMeta>> {
  const cached = accessPointObjectMetaCache.get('default');
  if (cached) {
    return cached.map;
  }

  if (accessPointObjectMetaInFlight) {
    return accessPointObjectMetaInFlight;
  }

  accessPointObjectMetaInFlight = (async () => {
    const [objectsResult, accessPointsResult, mapPointsResult] = await Promise.all([
      supabase.from('skud_objects').select('id, name, map_storage_path'),
      supabase.from('skud_object_access_points').select('object_id, access_point_name'),
      supabase.from('skud_object_map_points').select('object_id, access_point_name'),
    ]);

    if (objectsResult.error) throw objectsResult.error;
    if (accessPointsResult.error) throw accessPointsResult.error;
    if (mapPointsResult.error) throw mapPointsResult.error;

    const objectMetaById = new Map<string, { name: string | null; hasMap: boolean }>();
    for (const row of objectsResult.data || []) {
      objectMetaById.set(String(row.id), {
        name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : null,
        hasMap: !!row.map_storage_path,
      });
    }

    const mapPointObjectByName = new Map<string, string>();
    for (const row of mapPointsResult.data || []) {
      const key = normalizeAccessPointKey(row.access_point_name);
      if (!key) continue;
      mapPointObjectByName.set(key, String(row.object_id));
    }

    const metaMap = new Map<string, IAccessPointObjectMeta>();
    for (const row of accessPointsResult.data || []) {
      const key = normalizeAccessPointKey(row.access_point_name);
      if (!key) continue;

      const objectId = row.object_id ? String(row.object_id) : (mapPointObjectByName.get(key) || null);
      const objectMeta = objectId ? objectMetaById.get(objectId) : null;
      metaMap.set(key, {
        objectId,
        objectName: objectMeta?.name || null,
        hasMapPreview: !!objectId && mapPointObjectByName.has(key) && !!objectMeta?.hasMap,
      });
    }

    for (const [key, objectId] of mapPointObjectByName.entries()) {
      if (metaMap.has(key)) continue;
      const objectMeta = objectMetaById.get(objectId);
      metaMap.set(key, {
        objectId,
        objectName: objectMeta?.name || null,
        hasMapPreview: !!objectMeta?.hasMap,
      });
    }

    accessPointObjectMetaCache.set('default', { map: metaMap });
    return metaMap;
  })()
    .catch(error => {
      console.warn('Sigur live admin access point object metadata warning:', error);
      return new Map<string, IAccessPointObjectMeta>();
    })
    .finally(() => {
      accessPointObjectMetaInFlight = null;
    });

  return accessPointObjectMetaInFlight;
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

function collectAncestorDepartmentIds(
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

function normalizeDepartmentIds(departmentIds: number[]): number[] {
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

function collapseNestedDepartmentSelection(
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

async function getNormalizedDepartments(connection?: ConnectionType): Promise<Array<{ id: number; parentId: number | null; name: string }>> {
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

function buildEmployeeSearchParams(search: string): Record<string, unknown> {
  const trimmed = search.trim();
  if (!trimmed) return {};

  const looksLikeTabSearch = /^[A-Za-z0-9\-_/]+$/.test(trimmed) && /\d/.test(trimmed) && !/\s/.test(trimmed);
  if (looksLikeTabSearch) {
    return { 'tabId[STARTS_WITH]': trimmed };
  }

  return { name: trimmed };
}

function buildSearchHaystack(employee: ISigurEmployeeSummary): string {
  return [
    employee.name,
    employee.departmentName,
    employee.positionName,
    employee.tabId,
  ]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase('ru');
}

async function getCachedSubtreeEmployees(
  departmentId: number,
  departments: Array<{ id: number; parentId: number | null; name: string }>,
  departmentNameMap: Map<number, string>,
  connection?: ConnectionType,
): Promise<ISigurEmployeeSummary[]> {
  const cacheKey = buildSubtreeEmployeeCacheKey(departmentId, connection);
  const cached = subtreeEmployeeCache.get(cacheKey);
  if (cached) {
    return cached.items;
  }

  const descendantIds = [...collectSigurDepartmentDescendantIds(departmentId, departments)];
  let employeesRaw: Record<string, unknown>[];

  try {
    employeesRaw = await sigurService.getEmployeesByDepartments(descendantIds, connection);
  } catch (error) {
    console.warn(
      '[sigur live admin] subtree employee fetch failed, falling back to full employee cache:',
      error,
    );
    const fallbackEmployees = await sigurService.getEmployeesCached(connection);
    const allowedDepartmentIds = new Set(descendantIds);
    employeesRaw = fallbackEmployees.filter(raw => {
      const departmentIdValue = normalizeInt(resolveField(raw, 'departmentId', 'department_id'));
      return departmentIdValue != null && allowedDepartmentIds.has(departmentIdValue);
    });
  }

  const items = employeesRaw
    .map(raw => normalizeSigurEmployeeSummary(raw, departmentNameMap))
    .filter((employee): employee is ISigurEmployeeSummary => !!employee)
    .sort((left, right) => left.name.localeCompare(right.name, 'ru'));

  subtreeEmployeeCache.set(cacheKey, { items });
  return items;
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
  const searchParams = buildEmployeeSearchParams(search);
  const baseFilters = {
    ...(departmentId != null ? { departmentId } : {}),
    ...(blocked == null ? {} : { blocked }),
    ...searchParams,
  };

  const [itemsRaw, countRaw] = await Promise.all([
    sigurService.getEmployeesPage(baseFilters, { limit: safePageSize, offset }, connection),
    sigurService.getEmployeesCount(baseFilters, connection).catch(() => null),
  ]);

  const items = itemsRaw
    .map(raw => normalizeSigurEmployeeSummary(raw, departmentNameMap))
    .filter((employee): employee is ISigurEmployeeSummary => !!employee)
    .filter(employee => buildSearchHaystack(employee).includes(search.toLocaleLowerCase('ru')))
    .sort((left, right) => left.name.localeCompare(right.name, 'ru'));

  const total = normalizeInt(countRaw) || items.length;
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

export async function listSigurPositions(connection?: ConnectionType): Promise<ISigurPositionSummary[]> {
  const positions = await sigurService.getPositionOptionsCached(connection);
  return positions.map(position => ({
    id: position.id,
    name: position.name,
  }));
}

export async function createSigurPosition(
  name: string,
  connection?: ConnectionType,
): Promise<ISigurPositionSummary> {
  const normalizedName = name.trim();
  if (!normalizedName) {
    throw new Error('Название должности обязательно');
  }

  const existingPositions = await sigurService.getPositionOptionsCached(connection);
  const existing = existingPositions.find(position => position.name.toLocaleLowerCase('ru') === normalizedName.toLocaleLowerCase('ru'));
  if (existing) {
    return existing;
  }

  const created = await sigurService.createPosition({ name: normalizedName }, connection);
  sigurService.invalidatePositionCache();
  const positionId = normalizeInt(resolveField(created, 'id', 'ID', 'Id'));
  const positionName = String(resolveField<string>(created, 'name', 'Name', 'title') || normalizedName).trim();

  if (!positionId || !positionName) {
    throw new Error('Sigur не вернул созданную должность');
  }

  return {
    id: positionId,
    name: positionName,
  };
}

export async function updateSigurPosition(
  id: number,
  name: string,
  connection?: ConnectionType,
): Promise<ISigurPositionSummary> {
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error('Некорректный ID должности');
  }
  const normalizedName = name.trim();
  if (!normalizedName) {
    throw new Error('Название должности обязательно');
  }

  const existingPositions = await sigurService.getPositionOptionsCached(connection);
  const duplicate = existingPositions.find(
    position => position.id !== id
      && position.name.toLocaleLowerCase('ru') === normalizedName.toLocaleLowerCase('ru'),
  );
  if (duplicate) {
    throw new Error('Должность с таким названием уже существует');
  }

  const updated = await sigurService.updatePosition(id, { name: normalizedName }, connection);
  sigurService.invalidatePositionCache();
  const positionId = normalizeInt(resolveField(updated, 'id', 'ID', 'Id')) || id;
  const positionName = String(resolveField<string>(updated, 'name', 'Name', 'title') || normalizedName).trim();

  return {
    id: positionId,
    name: positionName,
  };
}

export async function deleteSigurPosition(
  id: number,
  connection?: ConnectionType,
): Promise<void> {
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error('Некорректный ID должности');
  }

  await sigurService.deletePosition(id, connection);
  sigurService.invalidatePositionCache();
}

export async function listSigurEmployees(
  filters: {
    departmentId?: number | null;
    search?: string | null;
    blocked?: boolean | null;
    includeChildren?: boolean | null;
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
  const includeChildren = filters.includeChildren === true;

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
    return {
      items: [],
      total: 0,
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

  const directCounts = await getDirectDepartmentCounts(connection);
  if (!includeChildren) {
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
    const items = (await sigurService.getEmployeesPage(
      { departmentId: selectedDepartmentId, ...(blocked == null ? {} : { blocked }) },
      { limit: safePageSize, offset },
      connection,
    ))
      .map(raw => normalizeSigurEmployeeSummary(raw, departmentNameMap))
      .filter((employee): employee is ISigurEmployeeSummary => !!employee)
      .sort((left, right) => left.name.localeCompare(right.name, 'ru'));

    return {
      items,
      total: blocked == null ? (directCounts.get(selectedDepartmentId) || 0) : items.length,
      page: safePage,
      pageSize: safePageSize,
    };
  }

  const subtreeIds = collectSigurDepartmentDescendantIds(selectedDepartmentId, departments);
  if (subtreeIds.size === 1) {
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
    const items = (await sigurService.getEmployeesPage(
      { departmentId: selectedDepartmentId, ...(blocked == null ? {} : { blocked }) },
      { limit: safePageSize, offset },
      connection,
    ))
      .map(raw => normalizeSigurEmployeeSummary(raw, departmentNameMap))
      .filter((employee): employee is ISigurEmployeeSummary => !!employee)
      .sort((left, right) => left.name.localeCompare(right.name, 'ru'));

    return {
      items,
      total: blocked == null ? (directCounts.get(selectedDepartmentId) || 0) : items.length,
      page: safePage,
      pageSize: safePageSize,
    };
  }

  const allItems = await getCachedSubtreeEmployees(selectedDepartmentId, departments, departmentNameMap, connection);
  const filteredItems = allItems.filter(employee => {
    if (blocked != null && employee.blocked !== blocked) {
      return false;
    }
    if (!search) return true;
    return buildSearchHaystack(employee).includes(search);
  });
  const startIndex = (safePage - 1) * safePageSize;

  return {
    items: filteredItems.slice(startIndex, startIndex + safePageSize),
    total: filteredItems.length,
    page: safePage,
    pageSize: safePageSize,
  };
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

  const cards = cardBindingsResult.status === 'fulfilled'
    ? (cardBindingsResult.value as Record<string, unknown>[])
      .map(raw => toCardSummary(raw))
      .filter((card): card is NonNullable<ReturnType<typeof toCardSummary>> => !!card)
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

export async function createSigurDepartment(
  input: ISigurDepartmentUpsertInput,
  connection?: ConnectionType,
): Promise<ISigurDepartmentNode> {
  const created = await sigurService.createDepartment({
    name: input.name.trim(),
    parentId: input.parentId ?? 0,
  }, connection);

  sigurService.invalidateDepartmentCache();
  invalidateSigurDirectoryCaches();

  const departmentId = normalizeInt(resolveField(created, 'id', 'ID', 'Id'));
  if (!departmentId) {
    throw new Error('Sigur не вернул id созданного отдела');
  }

  const remoteDepartment = normalizeDepartment(await sigurService.getDepartmentById(departmentId, connection));
  return {
    id: remoteDepartment.id,
    parentId: remoteDepartment.parentId || null,
    name: remoteDepartment.name,
    hasChildren: false,
    employeeCount: 0,
    children: [],
  };
}

export async function updateSigurDepartment(
  departmentId: number,
  input: Partial<ISigurDepartmentUpsertInput>,
  connection?: ConnectionType,
): Promise<ISigurDepartmentNode> {
  const payload: Record<string, unknown> = {};
  if (typeof input.name === 'string') payload.name = input.name.trim();
  if (input.parentId !== undefined) payload.parentId = input.parentId ?? 0;

  await sigurService.updateDepartment(departmentId, payload, connection);
  sigurService.invalidateDepartmentCache();
  invalidateSigurDirectoryCaches();

  const remoteDepartment = normalizeDepartment(await sigurService.getDepartmentById(departmentId, connection));
  return {
    id: remoteDepartment.id,
    parentId: remoteDepartment.parentId || null,
    name: remoteDepartment.name,
    hasChildren: false,
    employeeCount: 0,
    children: [],
  };
}

export async function deleteSigurDepartment(
  departmentId: number,
  connection?: ConnectionType,
): Promise<void> {
  await sigurService.deleteDepartment(departmentId, connection);
  sigurService.invalidateDepartmentCache();
  invalidateSigurDirectoryCaches();
}

export async function batchMoveSigurDepartments(
  departmentIds: number[],
  targetParentId: number | null,
  connection?: ConnectionType,
): Promise<{
  requested: number;
  effective: number;
  moved: number;
  failedDepartmentId: number | null;
  error: string | null;
}> {
  const departments = await getNormalizedDepartments(connection);
  const normalizedIds = normalizeDepartmentIds(departmentIds);
  const requested = departmentIds.length;

  if (normalizedIds.length === 0) {
    throw new Error('Не выбраны отделы для перемещения');
  }

  const departmentMap = new Map(departments.map(department => [department.id, department]));
  const missingIds = normalizedIds.filter(departmentId => !departmentMap.has(departmentId));
  if (missingIds.length > 0) {
    throw new Error(`Отделы не найдены: ${missingIds.join(', ')}`);
  }

  if (targetParentId != null && targetParentId > 0 && !departmentMap.has(targetParentId)) {
    throw new Error('Целевой родительский отдел не найден');
  }

  const effectiveIds = collapseNestedDepartmentSelection(normalizedIds, departments);
  const invalidTargetIds = new Set<number>();
  for (const departmentId of effectiveIds) {
    for (const id of collectSigurDepartmentDescendantIds(departmentId, departments)) {
      invalidTargetIds.add(id);
    }
  }

  if (targetParentId != null && invalidTargetIds.has(targetParentId)) {
    throw new Error('Нельзя переместить отдел внутрь самого себя или его потомка');
  }

  const targetParentValue = targetParentId ?? 0;
  const moveIds = effectiveIds.filter(departmentId => (departmentMap.get(departmentId)?.parentId || null) !== targetParentId);
  let moved = 0;
  let failedDepartmentId: number | null = null;
  let error: string | null = null;

  for (const departmentId of moveIds) {
    try {
      await sigurService.updateDepartment(departmentId, { parentId: targetParentValue }, connection);
      moved++;
    } catch (cause) {
      failedDepartmentId = departmentId;
      error = cause instanceof Error ? cause.message : 'Ошибка перемещения отдела';
      break;
    }
  }

  sigurService.invalidateDepartmentCache();
  invalidateSigurDirectoryCaches();

  return {
    requested,
    effective: effectiveIds.length,
    moved,
    failedDepartmentId,
    error,
  };
}

async function moveDirectDepartmentEmployees(
  departmentId: number,
  targetDepartmentId: number | null,
  connection?: ConnectionType,
): Promise<void> {
  const targetDepartmentValue = targetDepartmentId ?? 0;
  const limit = 1000;

  while (true) {
    const employees = await sigurService.getEmployeesPage(
      { departmentId },
      { limit, offset: 0 },
      connection,
    );
    const employeeIds = employees
      .map(employee => normalizeInt(resolveField(employee, 'id', 'ID', 'Id')))
      .filter((employeeId): employeeId is number => !!employeeId);

    if (employeeIds.length === 0) {
      return;
    }

    await Promise.allSettled(
      employeeIds.map(employeeId => sigurService.updateEmployee(employeeId, { departmentId: targetDepartmentValue }, connection)),
    );

    if (employeeIds.length < limit) {
      return;
    }
  }
}

export async function deleteSigurDepartmentRecursive(
  departmentId: number,
  connection?: ConnectionType,
): Promise<{ deleted: number }> {
  const departments = await getNormalizedDepartments(connection);
  const selectedDepartment = departments.find(department => department.id === departmentId) || null;
  if (!selectedDepartment) {
    const error = new Error('Отдел Sigur не найден');
    (error as Error & { status?: number }).status = 404;
    throw error;
  }

  const descendants = [...collectSigurDepartmentDescendantIds(departmentId, departments)];
  descendants.sort((left, right) => {
    const leftDepth = collectAncestorDepartmentIds(left, departments).size;
    const rightDepth = collectAncestorDepartmentIds(right, departments).size;
    return rightDepth - leftDepth;
  });

  const targetDepartmentId = selectedDepartment.parentId ?? null;

  for (const currentDepartmentId of descendants) {
    await moveDirectDepartmentEmployees(currentDepartmentId, targetDepartmentId, connection);
    try {
      await sigurService.deleteDepartment(currentDepartmentId, connection);
    } catch (error) {
      console.warn(`[sigur live admin] failed to delete department ${currentDepartmentId}:`, error);
    }
  }

  sigurService.invalidateEmployeeCache();
  sigurService.invalidateDepartmentCache();
  invalidateSigurDirectoryCaches();

  return { deleted: descendants.length };
}

function buildSigurEmployeePayload(input: ISigurEmployeeUpsertInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (typeof input.name === 'string') payload.name = input.name.trim();
  if (input.departmentId !== undefined) payload.departmentId = input.departmentId;
  if (input.positionId !== undefined) payload.positionId = input.positionId;
  if (input.tabId !== undefined) payload.tabId = input.tabId || null;
  if (input.description !== undefined) payload.description = input.description || null;
  return payload;
}

async function syncSigurEmployeeBlockedState(
  sigurEmployeeId: number,
  blocked: boolean | null | undefined,
  currentBlocked: boolean | null,
  connection?: ConnectionType,
): Promise<void> {
  if (blocked == null || currentBlocked === blocked) {
    return;
  }

  if (blocked) {
    await sigurService.blockEmployee(sigurEmployeeId, connection);
  } else {
    await sigurService.unblockEmployee(sigurEmployeeId, connection);
  }
}

export async function createSigurEmployee(
  input: ISigurEmployeeUpsertInput,
  connection?: ConnectionType,
): Promise<ISigurEmployeeProfile> {
  const created = await sigurService.createEmployee(buildSigurEmployeePayload(input), connection);
  const sigurEmployeeId = normalizeInt(resolveField(created, 'id', 'ID', 'Id'));
  if (!sigurEmployeeId) {
    throw new Error('Sigur не вернул id созданного сотрудника');
  }

  await syncSigurEmployeeBlockedState(sigurEmployeeId, input.blocked, false, connection);
  sigurService.invalidateEmployeeCache();
  sigurService.invalidateDepartmentCache();
  invalidateSigurDirectoryCaches();

  return getSigurEmployeeProfile(sigurEmployeeId, {}, connection);
}

export async function updateSigurEmployee(
  sigurEmployeeId: number,
  input: ISigurEmployeeUpsertInput,
  connection?: ConnectionType,
): Promise<ISigurEmployeeProfile> {
  const currentProfile = await getSigurEmployeeProfile(sigurEmployeeId, {}, connection);
  const payload = buildSigurEmployeePayload(input);

  if (Object.keys(payload).length > 0) {
    await sigurService.updateEmployee(sigurEmployeeId, payload, connection);
  }

  await syncSigurEmployeeBlockedState(
    sigurEmployeeId,
    input.blocked,
    currentProfile.profile.blocked,
    connection,
  );

  sigurService.invalidateEmployeeCache();
  sigurService.invalidateDepartmentCache();
  invalidateEmployeeAccessPointBindingsCache(sigurEmployeeId);
  invalidateSigurDirectoryCaches();

  return getSigurEmployeeProfile(sigurEmployeeId, {}, connection);
}

export async function moveSigurEmployee(
  sigurEmployeeId: number,
  departmentId: number,
  connection?: ConnectionType,
): Promise<ISigurEmployeeProfile> {
  return updateSigurEmployee(
    sigurEmployeeId,
    { departmentId },
    connection,
  );
}

export async function batchMoveSigurEmployees(
  employeeIds: number[],
  departmentId: number,
  connection?: ConnectionType,
): Promise<{ requested: number; moved: number; failedIds: number[] }> {
  const normalizedEmployeeIds = Array.from(new Set(
    employeeIds.filter(employeeId => Number.isFinite(employeeId) && employeeId > 0),
  ));

  const results = await Promise.allSettled(
    normalizedEmployeeIds.map(employeeId => sigurService.updateEmployee(employeeId, { departmentId }, connection)),
  );

  sigurService.invalidateEmployeeCache();
  sigurService.invalidateDepartmentCache();
  invalidateSigurDirectoryCaches();

  return {
    requested: normalizedEmployeeIds.length,
    moved: results.filter(result => result.status === 'fulfilled').length,
    failedIds: results.flatMap((result, index) => (result.status === 'rejected' ? [normalizedEmployeeIds[index]] : [])),
  };
}

export async function deleteSigurEmployee(
  sigurEmployeeId: number,
  connection?: ConnectionType,
): Promise<void> {
  await sigurService.deleteEmployee(sigurEmployeeId, connection);
  sigurService.invalidateEmployeeCache();
  sigurService.invalidateDepartmentCache();
  invalidateEmployeeAccessPointBindingsCache(sigurEmployeeId);
  invalidateSigurDirectoryCaches();
}

export async function updateSigurEmployeeCardExpiration(
  sigurEmployeeId: number,
  cardId: number,
  expirationDate: string,
  connection?: ConnectionType,
): Promise<{
  cardId: number;
  cardNumber: string | null;
  status: string | null;
  startDate: string | null;
  expirationDate: string | null;
}> {
  const parsedExpirationDate = new Date(expirationDate);
  if (Number.isNaN(parsedExpirationDate.getTime())) {
    throw new Error('Некорректная дата срока действия');
  }

  await sigurService.updateEmployeeCardBindingExpiration(
    sigurEmployeeId,
    cardId,
    parsedExpirationDate.toISOString(),
    connection,
  );

  const cardsRaw = await sigurService.getCardBindings({ employeeId: sigurEmployeeId }, connection) as Record<string, unknown>[];
  const card = cardsRaw
    .map(rawCard => toCardSummary(rawCard))
    .filter((rawCard): rawCard is NonNullable<ReturnType<typeof toCardSummary>> => !!rawCard)
    .find(rawCard => rawCard.cardId === cardId);

  return card || {
    cardId,
    cardNumber: null,
    status: null,
    startDate: null,
    expirationDate: parsedExpirationDate.toISOString(),
  };
}

export async function updateSigurEmployeeCardBinding(
  sigurEmployeeId: number,
  cardId: number,
  startDate: string,
  expirationDate: string,
  connection?: ConnectionType,
): Promise<{
  cardId: number;
  cardNumber: string | null;
  status: string | null;
  startDate: string | null;
  expirationDate: string | null;
}> {
  const parsedStartDate = new Date(startDate);
  if (Number.isNaN(parsedStartDate.getTime())) {
    throw new Error('Некорректная дата начала доступа');
  }
  const parsedExpirationDate = new Date(expirationDate);
  if (Number.isNaN(parsedExpirationDate.getTime())) {
    throw new Error('Некорректная дата срока действия');
  }

  await sigurService.patchEmployeeCardBinding(
    sigurEmployeeId,
    cardId,
    parsedStartDate.toISOString(),
    parsedExpirationDate.toISOString(),
    connection,
  );

  const cardsRaw = await sigurService.getCardBindings({ employeeId: sigurEmployeeId }, connection) as Record<string, unknown>[];
  const card = cardsRaw
    .map(rawCard => toCardSummary(rawCard))
    .filter((rawCard): rawCard is NonNullable<ReturnType<typeof toCardSummary>> => !!rawCard)
    .find(rawCard => rawCard.cardId === cardId);

  return card || {
    cardId,
    cardNumber: null,
    status: null,
    startDate: parsedStartDate.toISOString(),
    expirationDate: parsedExpirationDate.toISOString(),
  };
}

export async function replaceSigurEmployeeAccessPoints(
  sigurEmployeeId: number,
  accessPointIds: number[],
  connection?: ConnectionType,
): Promise<{
  addedIds: number[];
  removedIds: number[];
  bindings: IAccessPointBinding[];
}> {
  const accessPointObjectMeta = await loadAccessPointObjectMetaMap();
  const result = await replaceEmployeeAccessPointBindings(sigurEmployeeId, accessPointIds, connection);

  return {
    addedIds: result.addedIds,
    removedIds: result.removedIds,
    bindings: result.bindings.map(binding => enrichAccessPointBinding(binding, accessPointObjectMeta)),
  };
}

export async function replaceSigurEmployeeAccessRules(
  sigurEmployeeId: number,
  accessRuleIds: number[],
  connection?: ConnectionType,
): Promise<{
  addedIds: number[];
  removedIds: number[];
  bindings: Array<{ accessRuleId: number; accessRuleName: string | null }>;
}> {
  const normalizedAccessRuleIds = Array.from(new Set(
    accessRuleIds.filter(accessRuleId => Number.isFinite(accessRuleId) && accessRuleId > 0),
  )).sort((left, right) => left - right);
  const currentBindings = await sigurService.getEmployeeAccessRuleBindings({ employeeId: sigurEmployeeId }, connection) as Record<string, unknown>[];
  const currentIds = currentBindings
    .map(raw => toAccessRuleBinding(raw))
    .filter((binding): binding is NonNullable<ReturnType<typeof toAccessRuleBinding>> => !!binding && binding.employeeId === sigurEmployeeId)
    .map(binding => binding.accessRuleId)
    .sort((left, right) => left - right);
  const currentIdSet = new Set(currentIds);
  const nextIdSet = new Set(normalizedAccessRuleIds);
  const addedIds = normalizedAccessRuleIds.filter(accessRuleId => !currentIdSet.has(accessRuleId));
  const removedIds = currentIds.filter(accessRuleId => !nextIdSet.has(accessRuleId));

  await Promise.all([
    ...addedIds.map(accessRuleId => sigurService.addEmployeeAccessRuleBinding({
      employeeId: sigurEmployeeId,
      accessruleId: accessRuleId,
    }, connection)),
    ...removedIds.map(accessRuleId => sigurService.deleteEmployeeAccessRuleBinding({
      employeeId: sigurEmployeeId,
      accessruleId: accessRuleId,
    }, connection)),
  ]);

  const accessRuleCatalog = await sigurService.getAccessRuleMapCached(connection).catch(() => null);

  return {
    addedIds,
    removedIds,
    bindings: normalizedAccessRuleIds.map(accessRuleId => ({
      accessRuleId,
      accessRuleName: accessRuleCatalog?.get(accessRuleId) || null,
    })),
  };
}
