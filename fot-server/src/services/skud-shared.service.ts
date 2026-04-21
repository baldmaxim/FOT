/**
 * СКУД: общие хелперы и кэши, используемые несколькими сервисами.
 */
import { supabase } from '../config/database.js';

// ─── Кэш дерева отделов ───

const DEPT_TREE_CACHE_TTL = 5 * 60_000;
let deptTreeCache: { data: { id: string; parent_id: string | null }[]; expiresAt: number } | null = null;

/** Кэшированная загрузка всех отделов (id, parent_id). TTL 5 мин. */
export async function getAllDepartmentsTree(): Promise<{ id: string; parent_id: string | null }[]> {
  const now = Date.now();
  if (deptTreeCache && deptTreeCache.expiresAt > now) return deptTreeCache.data;

  const { data } = await supabase.from('org_departments').select('id, parent_id');
  deptTreeCache = { data: data || [], expiresAt: now + DEPT_TREE_CACHE_TTL };
  return deptTreeCache.data;
}

/** Инвалидация кэша отделов (вызывать после sync/CRUD) */
export function invalidateDeptTreeCache(): void {
  deptTreeCache = null;
}

// ─── Сбор ID отделов (включая дочерние) ───

/** Собирает ID отдела + все дочерние */
export async function collectDeptIds(
  departmentId: string,
): Promise<string[]> {
  const allDepts = await getAllDepartmentsTree();

  const ids = [departmentId];
  let changed = true;
  while (changed) {
    changed = false;
    for (const d of allDepts) {
      if (d.parent_id && ids.includes(d.parent_id) && !ids.includes(d.id)) {
        ids.push(d.id);
        changed = true;
      }
    }
  }
  return ids;
}

/** Получает ID всех предков отдела (от родителя до корня) */
export function getAncestorDeptIds(
  deptId: string,
  allDepts: { id: string; parent_id: string | null }[],
): string[] {
  const ancestors: string[] = [];
  let currentId: string | null = deptId;
  const visited = new Set<string>([deptId]);
  while (currentId) {
    const dept = allDepts.find(d => d.id === currentId);
    if (dept?.parent_id && !visited.has(dept.parent_id)) {
      ancestors.push(dept.parent_id);
      visited.add(dept.parent_id);
      currentId = dept.parent_id;
    } else {
      break;
    }
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
  const { data: filterRows } = await supabase
    .from('skud_sync_department_filter')
    .select('sigur_department_id');

  if (!filterRows || filterRows.length === 0) {
    console.log('[sync-filter] Пустой whitelist → ничего не синхронизируем');
    const empty = { empIds: new Set<number>(), empNames: new Set<string>() };
    syncFilterCache = { data: empty, expiresAt: Date.now() + SYNC_FILTER_CACHE_TTL };
    return empty;
  }

  const sigurDeptIds = filterRows.map(r => r.sigur_department_id);
  console.log('[sync-filter] sigur_department_ids из фильтра:', sigurDeptIds);

  // 2. Маппим sigur_department_id → org_departments.id
  const { data: depts } = await supabase
    .from('org_departments')
    .select('id, parent_id, name, sigur_department_id')
    .in('sigur_department_id', sigurDeptIds);

  console.log('[sync-filter] Найдено отделов по sigur_id:', depts?.length || 0,
    depts?.map(d => `${d.name} (sigur=${d.sigur_department_id})`));

  if (!depts || depts.length === 0) return { empIds: new Set(), empNames: new Set() };

  // 3. Собираем дочерние отделы
  const allDepts = await getAllDepartmentsTree();

  const deptIds = new Set(depts.map(d => d.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const d of allDepts || []) {
      if (d.parent_id && deptIds.has(d.parent_id) && !deptIds.has(d.id)) {
        deptIds.add(d.id);
        changed = true;
      }
    }
  }
  console.log('[sync-filter] Итого отделов (с дочерними):', deptIds.size);

  // 4. Загружаем сотрудников из этих отделов
  const { data: employees } = await supabase
    .from('employees')
    .select('id, full_name')
    .eq('is_archived', false)
    .in('org_department_id', [...deptIds]);

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

  const { data } = await supabase
    .from('skud_access_point_settings')
    .select('access_point_name')
    .eq('is_internal', true);

  const points = new Set<string>(
    (data || []).map((s: { access_point_name: string }) => s.access_point_name.trim()),
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
  let query = supabase
    .from('skud_events')
    .select('id, physical_person, card_number, event_date, event_time, access_point, direction, employee_id')
    .eq('employee_id', employeeId)
    .order('event_date', { ascending: false })
    .order('event_time', { ascending: false })
    .limit(5000);
  if (startDate && typeof startDate === 'string') query = query.gte('event_date', startDate);
  if (endDate && typeof endDate === 'string') query = query.lte('event_date', endDate);

  const { data } = await query;
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
  let countQuery = supabase
    .from('skud_events')
    .select('id', { count: 'exact', head: true })
    .is('employee_id', null);

  if (startDate && typeof startDate === 'string') countQuery = countQuery.gte('event_date', startDate);
  if (endDate && typeof endDate === 'string') countQuery = countQuery.lte('event_date', endDate);

  const { count } = await countQuery;
  if (!count || count === 0) return [];

  const PAGE_SIZE = 1000;
  const MAX_SCAN = 50000;
  let offset = 0;
  const matched: Record<string, unknown>[] = [];
  const idsToBackfill: number[] = [];

  while (offset < MAX_SCAN) {
    let query = supabase
      .from('skud_events')
      .select('id, physical_person, card_number, event_date, event_time, access_point, direction, employee_id')
      .is('employee_id', null)
      .order('event_date')
      .range(offset, offset + PAGE_SIZE - 1);

    if (startDate && typeof startDate === 'string') query = query.gte('event_date', startDate);
    if (endDate && typeof endDate === 'string') query = query.lte('event_date', endDate);

    const { data: page } = await query;
    if (!page || page.length === 0) break;

    for (const ev of page) {
      const name = (ev.physical_person || '').toLowerCase().trim();
      if (name === employeeName) {
        matched.push(ev);
        idsToBackfill.push(ev.id);
      }
    }

    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  // Бэкфилл employee_id на найденные записи (в фоне, пакетный RPC)
  if (idsToBackfill.length > 0) {
    supabase
      .rpc('bulk_update_employee_ids', {
        p_event_ids: idsToBackfill,
        p_employee_ids: idsToBackfill.map(() => employeeId),
      })
      .then(() => {
        console.log(`[employee-events] backfilled employee_id=${employeeId} on ${idsToBackfill.length} events`);
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
