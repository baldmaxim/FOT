/**
 * СКУД: общие хелперы и кэши, используемые несколькими сервисами.
 */
import { query } from '../config/postgres.js';
import { normalizeMatchName } from './name-match.utils.js';

// ─── Кэш дерева отделов ───

export interface IDeptTreeRow {
  id: string;
  parent_id: string | null;
  name: string | null;
  sigur_department_id: number | null;
}

const DEPT_TREE_CACHE_TTL = 5 * 60_000;
let deptTreeCache: { data: IDeptTreeRow[]; expiresAt: number } | null = null;

/** Кэшированная загрузка всех отделов (id, parent_id, name, sigur_department_id). TTL 5 мин. */
export async function getAllDepartmentsTree(): Promise<IDeptTreeRow[]> {
  const now = Date.now();
  if (deptTreeCache && deptTreeCache.expiresAt > now) return deptTreeCache.data;

  const data = await query<IDeptTreeRow>(
    'SELECT id, parent_id, name, sigur_department_id FROM org_departments',
  );
  deptTreeCache = { data: data || [], expiresAt: now + DEPT_TREE_CACHE_TTL };
  return deptTreeCache.data;
}

/** Инвалидация кэша отделов (вызывать после sync/CRUD) */
export function invalidateDeptTreeCache(): void {
  deptTreeCache = null;
  companyResolveCache = null;
}

// ─── Резолв «компании» (= прямого ребёнка корневого узла «Объект») ───

const COMPANY_RESOLVE_CACHE_TTL = 5 * 60_000;
const OBJECT_ROOT_NAME = 'Объект';

export interface ICompanyResolveMeta {
  id: string;
  name: string;
  sigur_department_id: number | null;
}

interface ICompanyResolveIndex {
  rootId: string | null;
  companyByDeptId: Map<string, string>;
  companyMeta: Map<string, ICompanyResolveMeta>;
  companyBySigurId: Map<number, string>;
  /**
   * Fallback-индекс: нормализованное имя локальной компании → её id.
   * Нужен чтобы мерджить unsynced людей в local company по имени, когда
   * `sigur_department_id` у local company пуст или не совпадает с Sigur root.
   */
  companyByNormalizedName: Map<string, string>;
}

let companyResolveCache: { data: ICompanyResolveIndex; expiresAt: number } | null = null;

/**
 * Резолвит для каждого отдела ID его «компании» = прямого ребёнка корневого
 * узла «Объект» (parent_id IS NULL AND name='Объект', см. sigur-sync-structure.service.ts).
 * Кэш 5 мин, инвалидируется через invalidateDeptTreeCache().
 */
export async function getCompanyResolveIndex(): Promise<ICompanyResolveIndex> {
  const now = Date.now();
  if (companyResolveCache && companyResolveCache.expiresAt > now) {
    return companyResolveCache.data;
  }

  const allDepts = await getAllDepartmentsTree();
  const root = allDepts.find(d => d.parent_id === null && d.name === OBJECT_ROOT_NAME) || null;
  const companyByDeptId = new Map<string, string>();
  const companyMeta = new Map<string, ICompanyResolveMeta>();
  const companyBySigurId = new Map<number, string>();
  const companyByNormalizedName = new Map<string, string>();

  if (root) {
    const childrenByParent = buildChildrenIndex(allDepts);
    const directChildren = childrenByParent.get(root.id) || [];
    const metaById = new Map(allDepts.map(d => [d.id, d]));

    for (const companyId of directChildren) {
      const node = metaById.get(companyId);
      companyMeta.set(companyId, {
        id: companyId,
        name: node?.name || '',
        sigur_department_id: node?.sigur_department_id ?? null,
      });
      if (node?.sigur_department_id != null) {
        companyBySigurId.set(node.sigur_department_id, companyId);
      }
      if (node?.name) {
        const key = normalizeMatchName(node.name);
        if (key && !companyByNormalizedName.has(key)) {
          companyByNormalizedName.set(key, companyId);
        }
      }
      // BFS вниз: всех потомков этой компании привязываем к ней.
      const stack: string[] = [companyId];
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (companyByDeptId.has(current)) continue;
        companyByDeptId.set(current, companyId);
        const kids = childrenByParent.get(current);
        if (kids) stack.push(...kids);
      }
    }
  }

  const data: ICompanyResolveIndex = {
    rootId: root?.id ?? null,
    companyByDeptId,
    companyMeta,
    companyBySigurId,
    companyByNormalizedName,
  };
  companyResolveCache = { data, expiresAt: now + COMPANY_RESOLVE_CACHE_TTL };
  return data;
}

// ─── Сбор ID отделов (включая дочерние) ───

/** Строит индекс parent_id → child_ids[] из плоского списка отделов. */
function buildChildrenIndex(
  allDepts: { id: string; parent_id: string | null }[],
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const d of allDepts) {
    if (d.parent_id) {
      const arr = index.get(d.parent_id);
      if (arr) arr.push(d.id);
      else index.set(d.parent_id, [d.id]);
    }
  }
  return index;
}

/** Собирает ID отдела + все дочерние (BFS по индексу, O(N)). */
export async function collectDeptIds(
  departmentId: string,
): Promise<string[]> {
  const allDepts = await getAllDepartmentsTree();
  const childrenByParent = buildChildrenIndex(allDepts);

  const ids: string[] = [departmentId];
  const seen = new Set<string>([departmentId]);
  // BFS: на каждом шаге берём очередной id и добавляем всех его детей.
  for (let i = 0; i < ids.length; i++) {
    const children = childrenByParent.get(ids[i]);
    if (!children) continue;
    for (const childId of children) {
      if (!seen.has(childId)) {
        seen.add(childId);
        ids.push(childId);
      }
    }
  }
  return ids;
}

/** Получает ID всех предков отдела (от родителя до корня), O(N) с lookup-индексом. */
export function getAncestorDeptIds(
  deptId: string,
  allDepts: { id: string; parent_id: string | null }[],
): string[] {
  const byId = new Map<string, string | null>();
  for (const d of allDepts) byId.set(d.id, d.parent_id);

  const ancestors: string[] = [];
  const visited = new Set<string>([deptId]);
  let currentId: string | null = byId.get(deptId) ?? null;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    ancestors.push(currentId);
    currentId = byId.get(currentId) ?? null;
  }
  return ancestors;
}

// ─── Sync filter: фильтрация сотрудников по отделам ───

const SYNC_FILTER_CACHE_TTL = 5 * 60_000;
let syncFilterCache: { data: { empIds: Set<number>; empNames: Set<string> } | null; expiresAt: number } | null = null;

/** Инвалидация кэша sync filter (вызывать при PUT /sigur/sync-filter) */
export function invalidateSyncFilterCache(): void {
  syncFilterCache = null;
}

/**
 * Загружает ID и имена сотрудников, относящихся к отделам из sync filter.
 * Возвращает null если фильтр не настроен (показывать всё).
 * Кэшируется на 5 мин.
 */
export async function getSyncFilteredEmployees(): Promise<{ empIds: Set<number>; empNames: Set<string> } | null> {
  const now = Date.now();
  if (syncFilterCache && syncFilterCache.expiresAt > now) {
    return syncFilterCache.data;
  }
  // 1. Загружаем whitelist sigur_department_id
  const filterRows = await query<{ sigur_department_id: number }>(
    'SELECT sigur_department_id FROM skud_sync_department_filter',
  );

  if (!filterRows || filterRows.length === 0) {
    console.log('[sync-filter] Пустой whitelist → ничего не синхронизируем');
    const empty = { empIds: new Set<number>(), empNames: new Set<string>() };
    syncFilterCache = { data: empty, expiresAt: Date.now() + SYNC_FILTER_CACHE_TTL };
    return empty;
  }

  const sigurDeptIds = filterRows.map(r => r.sigur_department_id);
  console.log('[sync-filter] sigur_department_ids из фильтра:', sigurDeptIds);

  // 2. Маппим sigur_department_id → org_departments.id
  const depts = await query<{ id: string; parent_id: string | null; name: string | null; sigur_department_id: number }>(
    'SELECT id, parent_id, name, sigur_department_id FROM org_departments WHERE sigur_department_id = ANY($1::int[])',
    [sigurDeptIds],
  );

  console.log('[sync-filter] Найдено отделов по sigur_id:', depts?.length || 0,
    depts?.map(d => `${d.name} (sigur=${d.sigur_department_id})`));

  if (!depts || depts.length === 0) return { empIds: new Set(), empNames: new Set() };

  // 3. Собираем дочерние отделы (BFS по индексу parent_id → children, O(N)).
  const allDepts = await getAllDepartmentsTree();
  const childrenByParent = buildChildrenIndex(allDepts);
  const deptIds = new Set<string>(depts.map(d => d.id));
  const queue: string[] = [...deptIds];
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    const children = childrenByParent.get(parentId);
    if (!children) continue;
    for (const childId of children) {
      if (!deptIds.has(childId)) {
        deptIds.add(childId);
        queue.push(childId);
      }
    }
  }
  console.log('[sync-filter] Итого отделов (с дочерними):', deptIds.size);

  // 4. Загружаем сотрудников из этих отделов
  const employees = await query<{ id: number; full_name: string | null }>(
    'SELECT id, full_name FROM employees WHERE is_archived = false AND org_department_id = ANY($1::uuid[])',
    [[...deptIds]],
  );

  const empIds = new Set<number>();
  const empNames = new Set<string>();
  for (const e of employees || []) {
    empIds.add(e.id);
    if (e.full_name) empNames.add(e.full_name.toLowerCase().trim());
  }

  console.log('[sync-filter] Найдено сотрудников:', empIds.size);

  const result = { empIds, empNames };
  syncFilterCache = { data: result, expiresAt: Date.now() + SYNC_FILTER_CACHE_TTL };
  return result;
}

// ─── Access point settings cache ───

const AP_CACHE_TTL = 10 * 60_000;
const accessPointCache = new Map<string, { data: string[]; at: number }>();

export function getAccessPointCacheEntry(key: string): string[] | null {
  const cached = accessPointCache.get(key);
  if (cached && Date.now() - cached.at < AP_CACHE_TTL) {
    return cached.data;
  }
  return null;
}

// ─── Кэш внутренних точек доступа ───

let internalPointsCache: { data: Set<string>; expiresAt: number } | null = null;

/** Кэшированная загрузка внутренних точек доступа. TTL 10 мин. */
export async function getInternalAccessPoints(): Promise<Set<string>> {
  const now = Date.now();
  if (internalPointsCache && internalPointsCache.expiresAt > now) {
    return internalPointsCache.data;
  }

  const data = await query<{ access_point_name: string }>(
    'SELECT access_point_name FROM skud_access_point_settings WHERE is_internal = true',
  );

  const points = new Set<string>(
    (data || []).map(s => s.access_point_name.trim()),
  );
  internalPointsCache = { data: points, expiresAt: now + AP_CACHE_TTL };
  return points;
}

/** Инвалидация кэша внутренних точек доступа */
export function invalidateInternalPointsCache(): void {
  internalPointsCache = null;
}

export function setAccessPointCacheEntry(key: string, data: string[]): void {
  accessPointCache.set(key, { data, at: Date.now() });
}

export function deleteAccessPointCacheEntry(key: string): void {
  accessPointCache.delete(key);
}

// ─── Дата-хелперы ───

/** Вычисляет понедельник текущей/указанной недели */
export function getMonday(d: Date): Date {
  const date = new Date(d);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return date;
}

export const DAY_NAMES = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт'];

/** Считает рабочие дни (Пн–Пт) между двумя ISO-датами включительно */
export function countWorkingDays(startStr: string, endStr: string): number {
  let count = 0;
  const cur = new Date(startStr);
  const end = new Date(endStr);
  while (cur <= end) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

// ─── Employee event helpers ───

/** Запрос событий по employee_id */
export async function queryEventsByEmployeeId(
  employeeId: number,
  startDate: unknown,
  endDate: unknown,
): Promise<Record<string, unknown>[]> {
  const conditions: string[] = ['employee_id = $1'];
  const params: unknown[] = [employeeId];
  if (startDate && typeof startDate === 'string') {
    params.push(startDate);
    conditions.push(`event_date >= $${params.length}`);
  }
  if (endDate && typeof endDate === 'string') {
    params.push(endDate);
    conditions.push(`event_date <= $${params.length}`);
  }
  const sql = `SELECT id, physical_person, card_number, event_date, event_time, access_point, direction, employee_id
    FROM skud_events
    WHERE ${conditions.join(' AND ')}
    ORDER BY event_date DESC, event_time DESC
    LIMIT 5000`;

  const data = await query<Record<string, unknown>>(sql, params);
  return data || [];
}

/** Пагинированный поиск по ФИО + бэкфилл employee_id */
export async function searchAndBackfillByName(
  employeeId: number,
  employeeName: string,
  startDate: unknown,
  endDate: unknown,
): Promise<Record<string, unknown>[]> {
  // Быстрая проверка: есть ли вообще unmatched события за период
  const countConditions: string[] = ['employee_id IS NULL'];
  const countParams: unknown[] = [];
  if (startDate && typeof startDate === 'string') {
    countParams.push(startDate);
    countConditions.push(`event_date >= $${countParams.length}`);
  }
  if (endDate && typeof endDate === 'string') {
    countParams.push(endDate);
    countConditions.push(`event_date <= $${countParams.length}`);
  }

  const countRow = await query<{ count: number }>(
    `SELECT count(*)::int AS count FROM skud_events WHERE ${countConditions.join(' AND ')}`,
    countParams,
  );
  const count = countRow[0]?.count ?? 0;
  if (!count || count === 0) return [];

  const PAGE_SIZE = 1000;
  const MAX_SCAN = 50000;
  let offset = 0;
  const matched: Record<string, unknown>[] = [];
  const idsToBackfill: number[] = [];

  while (offset < MAX_SCAN) {
    const pageConditions: string[] = ['employee_id IS NULL'];
    const pageParams: unknown[] = [];
    if (startDate && typeof startDate === 'string') {
      pageParams.push(startDate);
      pageConditions.push(`event_date >= $${pageParams.length}`);
    }
    if (endDate && typeof endDate === 'string') {
      pageParams.push(endDate);
      pageConditions.push(`event_date <= $${pageParams.length}`);
    }
    const sql = `SELECT id, physical_person, card_number, event_date, event_time, access_point, direction, employee_id
      FROM skud_events
      WHERE ${pageConditions.join(' AND ')}
      ORDER BY event_date ASC
      LIMIT ${PAGE_SIZE} OFFSET ${offset}`;
    const page = await query<Record<string, unknown>>(sql, pageParams);
    if (!page || page.length === 0) break;

    for (const ev of page) {
      const name = String(ev.physical_person || '').toLowerCase().trim();
      if (name === employeeName) {
        matched.push(ev);
        idsToBackfill.push(ev.id as number);
      }
    }

    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  // Бэкфилл employee_id на найденные записи (в фоне, пакетный RPC)
  if (idsToBackfill.length > 0) {
    query(
      'SELECT public.bulk_update_employee_ids($1::bigint[], $2::bigint[])',
      [idsToBackfill, idsToBackfill.map(() => employeeId)],
    )
      .then(() => {
        console.log(`[employee-events] backfilled employee_id=${employeeId} on ${idsToBackfill.length} events`);
      })
      .catch(err => {
        console.error('[employee-events] backfill failed:', err);
      });
  }

  return matched;
}

// ─── Вспомогательные функции для импорта ───

export function isHeaderRow(row: (string | number | Date | null)[]): boolean {
  if (!row || row.length === 0) return false;
  const firstCell = String(row[0] || '').toLowerCase();
  return (
    firstCell.includes('фио') ||
    firstCell.includes('имя') ||
    firstCell.includes('person') ||
    firstCell.includes('физ') ||
    firstCell.includes('сотрудник') ||
    firstCell === '№'
  );
}

/** Извлекает время из строки "Дата и Время" */
export function parseTimeFromDateTime(value: string | number | Date | null | undefined): string | null {
  if (!value) return null;

  const str = String(value).trim();
  if (!str) return null;

  // Ищем время в формате HH:MM или HH:MM:SS
  const timeMatch = str.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (timeMatch) {
    const [, hours, minutes, seconds = '00'] = timeMatch;
    return `${hours.padStart(2, '0')}:${minutes}:${seconds}`;
  }

  // Excel десятичное время
  if (!isNaN(Number(str))) {
    const num = Number(str);
    const timePart = num % 1;
    if (timePart > 0) {
      const totalMinutes = Math.round(timePart * 24 * 60);
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;
    }
  }

  return null;
}

export function parseTime(value: string | number | Date | null | undefined): string | null {
  if (!value) return null;

  const str = String(value).trim();
  if (!str) return null;

  const timeMatch = str.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (timeMatch) {
    const [, hours, minutes, seconds = '00'] = timeMatch;
    return `${hours.padStart(2, '0')}:${minutes}:${seconds}`;
  }

  if (!isNaN(Number(str))) {
    const num = Number(str);
    if (num >= 0 && num < 1) {
      const totalMinutes = Math.round(num * 24 * 60);
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;
    }
  }

  return null;
}
