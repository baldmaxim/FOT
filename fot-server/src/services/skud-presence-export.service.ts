/**
 * СКУД: выгрузка «Сотрудники на объектах» за период (xlsx).
 *
 * Экран `/skud-presence` показывает присутствие «в моменте»; здесь собирается
 * исторический датасет: кто был на каком объекте в каждый день периода. Факт
 * присутствия = первый вход (direction='entry') на точке доступа объекта за день.
 *
 * Конвейер: collectPresenceExport (авторизованный датасет, кэш) →
 * filterPresenceExport (пользовательские фильтры) → сборка книги.
 *
 * Ограничение: отдел берётся ТЕКУЩИЙ (Sigur / org_departments), а не на дату
 * прохода — истории членства в skud_events нет.
 */
import { createHash } from 'node:crypto';
import { query } from '../config/postgres.js';
import { getCompanyResolveIndex, getInternalAccessPoints } from './skud-shared.service.js';
import { listTravelObjects } from './skud-travel.service.js';
import {
  resolveSigurEmployeesByIds,
  resolveSigurEmployeesByNames,
  normalizeMatchName,
} from './sigur-presence-resolver.service.js';

export const NO_OBJECT_KEY = '__no_object__';
export const NO_OBJECT_NAME = 'Без объекта';
export const NO_GROUP_KEY = 'nocompany';
export const NO_GROUP_NAME = 'Без компании';

/** Максимальная длина периода в днях (включительно). */
export const MAX_PERIOD_DAYS = 62;
/** Аварийный предел исходного (нефильтрованного) датасета — защита памяти. */
export const MAX_DATASET_ROWS = 500_000;
/** Предел строк после пользовательских фильтров — предел книги. */
export const MAX_EXPORT_ROWS = 100_000;

const CACHE_TTL_MS = 3 * 60_000;
const CACHE_MAX_ENTRIES = 24;

export type PresenceExportErrorCode =
  | 'INVALID_PERIOD'
  | 'PERIOD_TOO_LONG'
  | 'DATASET_TOO_LARGE'
  | 'EXPORT_TOO_LARGE'
  | 'NO_DATA';

export class PresenceExportError extends Error {
  code: PresenceExportErrorCode;

  constructor(code: PresenceExportErrorCode, message: string) {
    super(message);
    this.name = 'PresenceExportError';
    this.code = code;
  }
}

export interface IPresenceExportVisibility {
  isUnrestricted: boolean;
  assignedObjectIds: Set<string>;
  allowedEmployeeIds: Set<number> | 'all';
  hasObjectViewScope: boolean;
}

export interface IPresenceExportEmployee {
  entry_time: string;
  full_name: string;
}

export interface IPresenceExportGroup {
  /** Устойчивый ключ: local:<uuid> | sigur:<id> | nocompany. */
  key: string;
  name: string;
  company_name: string | null;
  employees: IPresenceExportEmployee[];
}

export interface IPresenceExportObject {
  object_key: string;
  object_name: string;
  total: number;
  groups: IPresenceExportGroup[];
}

export interface IPresenceExportDay {
  date: string;
  objects: IPresenceExportObject[];
}

export interface IPresenceExportFilters {
  objectKeys?: Set<string>;
  groupKeys?: Set<string>;
}

interface IRawRow {
  event_date: string;
  employee_id: number | string | null;
  physical_person: string | null;
  access_point: string | null;
  first_entry: string;
}

interface IEmployeeRow {
  id: number | string;
  full_name: string | null;
  org_department_id: string | null;
  sigur_employee_id: number | string | null;
}

interface IDeptRow {
  id: string;
  parent_id: string | null;
  name: string | null;
  sigur_department_id: number | string | null;
  is_active: boolean | null;
}

/** Накопитель по одному человеку в один день на одном объекте. */
interface IPersonAcc {
  employeeId: number | null;
  /** Каноническое написание ФИО из проходов (для unsynced). */
  rawName: string;
  entryTime: string;
}

const collator = new Intl.Collator('ru', { sensitivity: 'base' });

function compareByCountThenName(aCount: number, bCount: number, aName: string, bName: string): number {
  if (aCount !== bCount) return bCount - aCount;
  return collator.compare(aName, bName);
}

// ─── Валидация периода ───

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseIsoDate(value: string): Date {
  if (!ISO_DATE_RE.test(value)) {
    throw new PresenceExportError('INVALID_PERIOD', `Некорректная дата: ${value}`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new PresenceExportError('INVALID_PERIOD', `Некорректная дата: ${value}`);
  }
  return date;
}

/** Проверяет период и возвращает его длину в днях (включительно). */
export function validatePeriod(dateFrom: string, dateTo: string): number {
  const from = parseIsoDate(dateFrom);
  const to = parseIsoDate(dateTo);
  if (from.getTime() > to.getTime()) {
    throw new PresenceExportError('INVALID_PERIOD', 'Начало периода позже конца');
  }
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
  if (days > MAX_PERIOD_DAYS) {
    throw new PresenceExportError('PERIOD_TOO_LONG', `Период больше ${MAX_PERIOD_DAYS} дней`);
  }
  return days;
}

// ─── Bounded-кэш датасета ───
// createSwrCache не годится: его Map не ограничен и не чистит протухшие ключи,
// а произвольные периоды дают неограниченное число ключей.

interface ICacheEntry {
  value: IPresenceExportDay[];
  expiresAt: number;
}

const datasetCache = new Map<string, ICacheEntry>();

export function invalidatePresenceExportCache(): void {
  datasetCache.clear();
}

/**
 * Отпечаток запроса. Именно перечислением полей, а не JSON.stringify(visibility):
 * `JSON.stringify(new Set())` === '{}', из-за чего разные скоупы дали бы один
 * ключ — это утечка данных между пользователями.
 */
export function buildCacheKey(
  dateFrom: string,
  dateTo: string,
  visibility: IPresenceExportVisibility,
): string {
  const fingerprint = [
    dateFrom,
    dateTo,
    visibility.isUnrestricted ? 'U' : 'u',
    visibility.hasObjectViewScope ? 'V' : 'v',
    [...visibility.assignedObjectIds].sort().join(','),
    visibility.allowedEmployeeIds === 'all'
      ? 'all'
      : [...visibility.allowedEmployeeIds].sort((a, b) => a - b).join(','),
  ].join('|');
  return createHash('sha1').update(fingerprint).digest('hex');
}

function cacheGet(key: string): IPresenceExportDay[] | null {
  const entry = datasetCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    datasetCache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key: string, value: IPresenceExportDay[]): void {
  const now = Date.now();
  for (const [existingKey, entry] of datasetCache) {
    if (entry.expiresAt <= now) datasetCache.delete(existingKey);
  }
  datasetCache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
  // Map хранит ключи в порядке вставки — вытесняем самые старые.
  while (datasetCache.size > CACHE_MAX_ENTRIES) {
    const oldest = datasetCache.keys().next();
    if (oldest.done) break;
    datasetCache.delete(oldest.value);
  }
}

// ─── Сбор датасета ───

export async function collectPresenceExport(params: {
  dateFrom: string;
  dateTo: string;
  visibility: IPresenceExportVisibility;
}): Promise<IPresenceExportDay[]> {
  const { dateFrom, dateTo, visibility } = params;
  validatePeriod(dateFrom, dateTo);

  const key = buildCacheKey(dateFrom, dateTo, visibility);
  const cached = cacheGet(key);
  if (cached) return cached;

  const value = await computePresenceExport(dateFrom, dateTo, visibility);
  cacheSet(key, value);
  return value;
}

async function computePresenceExport(
  dateFrom: string,
  dateTo: string,
  visibility: IPresenceExportVisibility,
): Promise<IPresenceExportDay[]> {
  const [rows, internalPoints, travelObjects, companyIndex, deptRows] = await Promise.all([
    query<IRawRow>(
      `SELECT to_char(event_date, 'YYYY-MM-DD') AS event_date,
              employee_id,
              physical_person,
              access_point,
              MIN(event_time)::text AS first_entry
         FROM skud_events
        WHERE event_date BETWEEN $1 AND $2
          AND direction = 'entry'
          AND access_point IS NOT NULL
        GROUP BY event_date, employee_id, physical_person, access_point
        ORDER BY event_date`,
      [dateFrom, dateTo],
    ),
    getInternalAccessPoints(),
    listTravelObjects(),
    getCompanyResolveIndex(),
    // Отдельный запрос (не getAllDepartmentsTree): та не грузит is_active,
    // а её кэш общий с другими потребителями.
    query<IDeptRow>(
      'SELECT id, parent_id, name, sigur_department_id, is_active FROM org_departments',
    ),
  ]);

  // Полная карта точек — строится ДО скоупа и фильтров. Иначе проход на
  // известном, но недоступном объекте деградировал бы в «Без объекта».
  const accessPointToObjectId = new Map<string, string>();
  const objectNameById = new Map<string, string>();
  for (const obj of travelObjects) {
    objectNameById.set(obj.id, obj.name);
    for (const point of obj.access_points) {
      if (!accessPointToObjectId.has(point)) accessPointToObjectId.set(point, obj.id);
    }
  }

  // date → objectKey → personKey → накопитель
  const byDate = new Map<string, Map<string, Map<string, IPersonAcc>>>();
  let totalRows = 0;

  for (const row of rows || []) {
    const accessPoint = (row.access_point || '').trim();
    if (!accessPoint || internalPoints.has(accessPoint)) continue;

    const rawEmployeeId = row.employee_id == null ? null : Number(row.employee_id);
    const employeeId = rawEmployeeId != null && Number.isFinite(rawEmployeeId) ? rawEmployeeId : null;
    const rawName = (row.physical_person || '').trim();
    if (employeeId === null && !rawName) continue;

    const objectId = accessPointToObjectId.get(accessPoint) ?? null;
    const objectKey = objectId ?? NO_OBJECT_KEY;
    const personKey = employeeId !== null
      ? `emp:${employeeId}`
      : `ext:${normalizeMatchName(rawName)}`;

    let objects = byDate.get(row.event_date);
    if (!objects) {
      objects = new Map();
      byDate.set(row.event_date, objects);
    }
    let persons = objects.get(objectKey);
    if (!persons) {
      persons = new Map();
      objects.set(objectKey, persons);
    }

    const existing = persons.get(personKey);
    if (!existing) {
      persons.set(personKey, { employeeId, rawName, entryTime: row.first_entry });
      totalRows += 1;
      if (totalRows > MAX_DATASET_ROWS) {
        throw new PresenceExportError(
          'DATASET_TOO_LARGE',
          'Слишком много данных за период',
        );
      }
      continue;
    }
    if (row.first_entry < existing.entryTime) {
      existing.entryTime = row.first_entry;
      existing.rawName = rawName || existing.rawName;
    } else if (row.first_entry === existing.entryTime && rawName && rawName < existing.rawName) {
      // Детерминированное каноническое написание при равном времени.
      existing.rawName = rawName;
    }
  }

  // ─── Справочники для резолва отдела/ФИО ───
  const employeeIds = new Set<number>();
  const externalNames = new Set<string>();
  for (const objects of byDate.values()) {
    for (const persons of objects.values()) {
      for (const person of persons.values()) {
        if (person.employeeId !== null) employeeIds.add(person.employeeId);
        else if (person.rawName) externalNames.add(person.rawName);
      }
    }
  }

  const employeeRows = employeeIds.size > 0
    ? await query<IEmployeeRow>(
      `SELECT id, full_name, org_department_id, sigur_employee_id
         FROM employees WHERE id = ANY($1::bigint[])`,
      [[...employeeIds]],
    )
    : [];

  const employeeById = new Map<number, IEmployeeRow>();
  const sigurIds: number[] = [];
  for (const row of employeeRows || []) {
    const id = Number(row.id);
    if (!Number.isFinite(id)) continue;
    employeeById.set(id, row);
    const sigurId = row.sigur_employee_id == null ? null : Number(row.sigur_employee_id);
    if (sigurId != null && Number.isFinite(sigurId)) sigurIds.push(sigurId);
  }

  const [sigurByEmployeeId, sigurByName] = await Promise.all([
    sigurIds.length > 0 ? resolveSigurEmployeesByIds(sigurIds) : Promise.resolve(new Map()),
    externalNames.size > 0
      ? resolveSigurEmployeesByNames([...externalNames])
      : Promise.resolve(new Map()),
  ]);

  const deptById = new Map<string, IDeptRow>();
  const localIdBySigurDeptId = new Map<number, string>();
  for (const dept of deptRows || []) {
    deptById.set(dept.id, dept);
    const sigurDeptId = dept.sigur_department_id == null ? null : Number(dept.sigur_department_id);
    if (sigurDeptId != null && Number.isFinite(sigurDeptId)) {
      // Активные узлы приоритетнее: у неактивных дублей тот же sigur id.
      if (!localIdBySigurDeptId.has(sigurDeptId) || dept.is_active !== false) {
        localIdBySigurDeptId.set(sigurDeptId, dept.id);
      }
    }
  }

  const companyNameByLocalDeptId = (localDeptId: string): string | null => {
    const companyId = companyIndex.companyByDeptId.get(localDeptId);
    if (!companyId) return null;
    return companyIndex.companyMeta.get(companyId)?.name || null;
  };

  interface IResolvedGroup { key: string; name: string; company_name: string | null }

  const resolveGroup = (person: IPersonAcc): IResolvedGroup => {
    const employee = person.employeeId !== null ? employeeById.get(person.employeeId) : undefined;

    // Приоритет ключа обязан совпадать с приоритетом имени: имя берём из Sigur,
    // локальный отдел — только как fallback (паритет с presence-by-object).
    const sigurMatch = employee
      ? (() => {
        const sigurId = employee.sigur_employee_id == null ? null : Number(employee.sigur_employee_id);
        return sigurId != null && Number.isFinite(sigurId) ? sigurByEmployeeId.get(sigurId) : undefined;
      })()
      : sigurByName.get(normalizeMatchName(person.rawName));

    if (sigurMatch) {
      const sigurDeptId = sigurMatch.department.sigur_department_id;
      const localId = localIdBySigurDeptId.get(sigurDeptId) ?? null;
      return {
        key: localId ? `local:${localId}` : `sigur:${sigurDeptId}`,
        name: sigurMatch.department.name || NO_GROUP_NAME,
        company_name: (localId ? companyNameByLocalDeptId(localId) : null)
          || sigurMatch.root.name
          || null,
      };
    }

    if (employee?.org_department_id) {
      const localId = employee.org_department_id;
      return {
        key: `local:${localId}`,
        name: deptById.get(localId)?.name || NO_GROUP_NAME,
        company_name: companyNameByLocalDeptId(localId),
      };
    }

    return { key: NO_GROUP_KEY, name: NO_GROUP_NAME, company_name: null };
  };

  // ─── Сборка + построчная авторизация ───
  const days: IPresenceExportDay[] = [];

  for (const [date, objects] of byDate) {
    const dayObjects: IPresenceExportObject[] = [];

    for (const [objectKey, persons] of objects) {
      const objectId = objectKey === NO_OBJECT_KEY ? null : objectKey;
      const assigned = objectId !== null && visibility.assignedObjectIds.has(objectId);

      const groupAcc = new Map<string, IPresenceExportGroup>();
      let objectTotal = 0;

      for (const person of persons.values()) {
        const isUnsynced = person.employeeId === null;
        const allowedPerson = !isUnsynced
          && (visibility.allowedEmployeeIds === 'all'
            || visibility.allowedEmployeeIds.has(person.employeeId as number));
        const visible = visibility.isUnrestricted
          || (assigned && (!visibility.hasObjectViewScope || allowedPerson))
          || (allowedPerson && objectId !== null);
        if (!visible) continue;

        const group = resolveGroup(person);
        let bucket = groupAcc.get(group.key);
        if (!bucket) {
          bucket = { key: group.key, name: group.name, company_name: group.company_name, employees: [] };
          groupAcc.set(group.key, bucket);
        }
        const employee = person.employeeId !== null ? employeeById.get(person.employeeId) : undefined;
        bucket.employees.push({
          entry_time: person.entryTime,
          full_name: employee?.full_name?.trim() || person.rawName || '—',
        });
        objectTotal += 1;
      }

      if (objectTotal === 0) continue;

      const groups = [...groupAcc.values()];
      for (const group of groups) {
        group.employees.sort((a, b) => (
          a.entry_time !== b.entry_time
            ? (a.entry_time < b.entry_time ? -1 : 1)
            : collator.compare(a.full_name, b.full_name)
        ));
      }
      groups.sort((a, b) => compareByCountThenName(
        a.employees.length, b.employees.length, a.name, b.name,
      ));

      dayObjects.push({
        object_key: objectKey,
        object_name: objectId ? objectNameById.get(objectId) || '—' : NO_OBJECT_NAME,
        total: objectTotal,
        groups,
      });
    }

    if (dayObjects.length === 0) continue;
    dayObjects.sort((a, b) => compareByCountThenName(a.total, b.total, a.object_name, b.object_name));
    days.push({ date, objects: dayObjects });
  }

  days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return days;
}

// ─── Пользовательские фильтры (после авторизации) ───

/**
 * Чистая функция: применяет выбор пользователя поверх авторизованного датасета.
 * Пустой/отсутствующий набор = «все». Вход лежит в кэше — не мутируем.
 */
export function filterPresenceExport(
  days: IPresenceExportDay[],
  filters: IPresenceExportFilters,
): IPresenceExportDay[] {
  const objectKeys = filters.objectKeys && filters.objectKeys.size > 0 ? filters.objectKeys : null;
  const groupKeys = filters.groupKeys && filters.groupKeys.size > 0 ? filters.groupKeys : null;
  if (!objectKeys && !groupKeys) return days;

  const result: IPresenceExportDay[] = [];
  for (const day of days) {
    const objects: IPresenceExportObject[] = [];
    for (const object of day.objects) {
      if (objectKeys && !objectKeys.has(object.object_key)) continue;
      const groups = groupKeys
        ? object.groups.filter(group => groupKeys.has(group.key))
        : object.groups;
      if (groups.length === 0) continue;
      const total = groups.reduce((sum, group) => sum + group.employees.length, 0);
      objects.push({ ...object, total, groups });
    }
    if (objects.length === 0) continue;
    result.push({ date: day.date, objects });
  }
  return result;
}

/**
 * Предел строк книги. Проверяется ПОСЛЕ пользовательских фильтров — иначе совет
 * «сузьте фильтры» невыполним: запрос падал бы до их применения.
 */
export function assertExportSize(days: IPresenceExportDay[]): void {
  if (countExportRows(days) > MAX_EXPORT_ROWS) {
    throw new PresenceExportError('EXPORT_TOO_LARGE', 'Слишком много строк');
  }
}

export function countExportRows(days: IPresenceExportDay[]): number {
  let total = 0;
  for (const day of days) {
    for (const object of day.objects) total += object.total;
  }
  return total;
}

// ─── Списки для модалки фильтров ───

export interface IPresenceExportFilterOptions {
  objects: Array<{ key: string; name: string }>;
  groups: Array<{ key: string; name: string; company_name: string | null }>;
}

/** Опции фильтров выводятся из того же датасета — «мёртвых» вариантов не бывает. */
export function buildFilterOptions(days: IPresenceExportDay[]): IPresenceExportFilterOptions {
  const objects = new Map<string, string>();
  const groups = new Map<string, { key: string; name: string; company_name: string | null }>();

  for (const day of days) {
    for (const object of day.objects) {
      if (!objects.has(object.object_key)) objects.set(object.object_key, object.object_name);
      for (const group of object.groups) {
        if (!groups.has(group.key)) {
          groups.set(group.key, {
            key: group.key,
            name: group.name,
            company_name: group.company_name,
          });
        }
      }
    }
  }

  return {
    objects: [...objects.entries()]
      .map(([key, name]) => ({ key, name }))
      .sort((a, b) => collator.compare(a.name, b.name)),
    groups: [...groups.values()].sort((a, b) => (
      collator.compare(a.company_name || '', b.company_name || '')
        || collator.compare(a.name, b.name)
    )),
  };
}
