/**
 * Фильтры по столбцам «Текущих сотрудников» (воронка в заголовке). Строятся на тех же
 * SQL-выражениях, что и сортировка (buildStaffSortKeySql), поэтому значение в ячейке, порядок
 * строк и фильтр не расходятся. Транспорт — query-параметр cf (JSON).
 */
import { z } from 'zod';
import { escapeLike } from '../utils/search.utils.js';
import { buildStaffSortKeySql, StaffSortUnavailableError } from './employees-staff-sort.helpers.js';

export const STAFF_VALUE_FILTER_COLUMNS = ['department', 'position', 'schedule', 'main_object', 'sign'] as const;
export type StaffValueFilterColumn = typeof STAFF_VALUE_FILTER_COLUMNS[number];

export const STAFF_DATE_FILTER_COLUMNS = ['hire_date', 'birth_date'] as const;
export type StaffDateFilterColumn = typeof STAFF_DATE_FILTER_COLUMNS[number];

export const STAFF_TEXT_FILTER_COLUMNS = ['name', 'comment'] as const;
export type StaffTextFilterColumn = typeof STAFF_TEXT_FILTER_COLUMNS[number];

export type StaffFilterColumn = StaffValueFilterColumn | StaffDateFilterColumn | StaffTextFilterColumn;

const MAX_CF_LENGTH = 8192;
const MAX_VALUES = 200;
const MAX_VALUE_LENGTH = 300;
const MAX_TEXT_LENGTH = 200;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const isoDate = z.string().regex(ISO_DATE).refine(value => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));

const valueListSchema = z.array(z.string().max(MAX_VALUE_LENGTH).nullable()).min(1).max(MAX_VALUES);

const dateRangeSchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  empty: z.boolean().optional(),
}).strict().refine(range => !range.from || !range.to || range.from <= range.to, { message: 'from > to' });

const columnFiltersSchema = z.object({
  values: z.object(Object.fromEntries(STAFF_VALUE_FILTER_COLUMNS.map(column => [column, valueListSchema.optional()])) as Record<StaffValueFilterColumn, z.ZodOptional<typeof valueListSchema>>).strict().optional(),
  dates: z.object(Object.fromEntries(STAFF_DATE_FILTER_COLUMNS.map(column => [column, dateRangeSchema.optional()])) as Record<StaffDateFilterColumn, z.ZodOptional<typeof dateRangeSchema>>).strict().optional(),
  text: z.object(Object.fromEntries(STAFF_TEXT_FILTER_COLUMNS.map(column => [column, z.string().max(MAX_TEXT_LENGTH).optional()])) as Record<StaffTextFilterColumn, z.ZodOptional<z.ZodString>>).strict().optional(),
  has_comment: z.boolean().optional(),
}).strict();

export type IStaffColumnFilters = z.infer<typeof columnFiltersSchema>;

export type ColumnFiltersParseResult = { ok: true; filters: IStaffColumnFilters } | { ok: false };

/** cf отсутствует или пустой — без фильтров; неверный JSON/схема/слишком длинный — ошибка. */
export function parseStaffColumnFilters(raw: unknown): ColumnFiltersParseResult {
  if (raw === undefined || raw === '') return { ok: true, filters: {} };
  if (typeof raw !== 'string' || raw.length > MAX_CF_LENGTH) return { ok: false };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  const parsed = columnFiltersSchema.safeParse(json);
  return parsed.success ? { ok: true, filters: parsed.data } : { ok: false };
}

export class StaffFilterUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaffFilterUnavailableError';
  }
}

/** Столбец-объект снимка недоступен: пробрасываем как ошибку фильтра (409 FILTER_UNAVAILABLE). */
async function keySql(column: StaffValueFilterColumn | StaffTextFilterColumn, params: unknown[]): Promise<string> {
  try {
    return await buildStaffSortKeySql(column, params);
  } catch (error) {
    if (error instanceof StaffSortUnavailableError) {
      throw new StaffFilterUnavailableError('Фильтр по объекту недоступен: снимок объектов ещё не рассчитан');
    }
    throw error;
  }
}

/** Число активных фильтров (для аудита и проверок). */
export function countActiveColumnFilters(filters: IStaffColumnFilters): number {
  let count = 0;
  for (const list of Object.values(filters.values ?? {})) if (list && list.length > 0) count += 1;
  for (const range of Object.values(filters.dates ?? {})) if (range && (range.from || range.to || range.empty)) count += 1;
  for (const text of Object.values(filters.text ?? {})) if (text && text.trim()) count += 1;
  if (filters.has_comment !== undefined) count += 1;
  return count;
}

/**
 * Добавляет условия фильтров столбцов (таблица employees без алиаса). exclude — столбец, чей
 * фильтр не применяется: варианты значений столбца считаются без его собственного фильтра.
 */
export async function appendColumnFilters(
  whereParts: string[],
  params: unknown[],
  filters: IStaffColumnFilters,
  options: { exclude?: StaffFilterColumn } = {},
): Promise<void> {
  const { exclude } = options;

  for (const column of STAFF_VALUE_FILTER_COLUMNS) {
    const list = filters.values?.[column];
    if (!list || list.length === 0 || column === exclude) continue;
    const key = await keySql(column, params);
    const values = [...new Set(list.filter((value): value is string => value !== null))];
    const includeEmpty = list.includes(null);
    const parts: string[] = [];
    if (values.length > 0) {
      params.push(values);
      parts.push(`${key} = ANY($${params.length}::text[])`);
    }
    if (includeEmpty) parts.push(`${key} IS NULL`);
    whereParts.push(`(${parts.join(' OR ')})`);
  }

  for (const column of STAFF_DATE_FILTER_COLUMNS) {
    const range = filters.dates?.[column];
    if (!range || column === exclude || (!range.from && !range.to && !range.empty)) continue;
    const bounds: string[] = [];
    if (range.from) {
      params.push(range.from);
      bounds.push(`employees.${column} >= $${params.length}::date`);
    }
    if (range.to) {
      params.push(range.to);
      bounds.push(`employees.${column} <= $${params.length}::date`);
    }
    const inRange = bounds.length > 0 ? `(${bounds.join(' AND ')})` : null;
    const empty = range.empty ? `employees.${column} IS NULL` : null;
    whereParts.push(`(${[inRange, empty].filter(Boolean).join(' OR ')})`);
  }

  for (const column of STAFF_TEXT_FILTER_COLUMNS) {
    const text = filters.text?.[column]?.trim();
    if (!text || column === exclude) continue;
    const key = await keySql(column, params);
    params.push(`%${escapeLike(text, MAX_TEXT_LENGTH)}%`);
    whereParts.push(`${key} ILIKE $${params.length}`);
  }

  if (filters.has_comment !== undefined && exclude !== 'comment') {
    const exists = 'EXISTS (SELECT 1 FROM employee_staff_comments c WHERE c.employee_id = employees.id)';
    whereParts.push(filters.has_comment ? exists : `NOT ${exists}`);
  }
}
