/**
 * Сортировка и фильтры столбцов списка условий оплаты («Зарплата → Условия оплаты»).
 *
 * Паттерн тот же, что у «Текущих сотрудников» (employees-staff-sort.helpers.ts,
 * employees-staff-column-filters.helpers.ts), но выражения — над колонками CTE `scoped`
 * списка условий, а ключ сортировки бывает числовым (суммы): текстовое сравнение
 * поставило бы «9 000» после «10 000».
 *
 * Значение фильтра, ключ сортировки и ячейка на экране строятся из одних и тех же колонок,
 * поэтому не расходятся. Имена колонок — только из whitelist, значения пользователя — только
 * параметры $n.
 */
import { z } from 'zod';
import { escapeLike } from '../utils/search.utils.js';

export const PAYROLL_SORT_KEYS = ['name', 'department', 'position', 'schedule', 'salary', 'bonus', 'housing'] as const;
export type PayrollSortKey = typeof PAYROLL_SORT_KEYS[number];
export type PayrollSortDir = 'asc' | 'desc';

export interface IPayrollSort {
  key: PayrollSortKey;
  dir: PayrollSortDir;
}

/** Столбцы с фильтром «список значений». ФИО — текстовый фильтр «содержит». */
export const PAYROLL_VALUE_FILTER_COLUMNS = ['department', 'position', 'schedule', 'salary', 'bonus', 'housing'] as const;
export type PayrollValueFilterColumn = typeof PAYROLL_VALUE_FILTER_COLUMNS[number];
export type PayrollFilterColumn = PayrollValueFilterColumn | 'name';

const MAX_CF_LENGTH = 8192;
const MAX_VALUES = 200;
const MAX_VALUE_LENGTH = 300;
const MAX_TEXT_LENGTH = 200;

/** Текстовое значение или NULL: пустая строка — отсутствие значения. */
const nullIfBlank = (expr: string): string => `NULLIF(btrim(${expr}), '')`;

/**
 * Ключ сортировки над колонками `scoped`. Оклад сортируется по сумме независимо от вида оплаты
 * (оклад в месяц и ставка в час идут одним рядом чисел); пустые — всегда в конце.
 */
const SORT_KEY_SQL: Record<PayrollSortKey, { sql: string; cast: 'text' | 'numeric' }> = {
  name: { sql: nullIfBlank('full_name'), cast: 'text' },
  department: { sql: nullIfBlank('department_name'), cast: 'text' },
  position: { sql: nullIfBlank('position_name'), cast: 'text' },
  schedule: { sql: nullIfBlank('schedule_name'), cast: 'text' },
  salary: { sql: 'COALESCE(monthly_salary, hourly_rate)', cast: 'numeric' },
  bonus: { sql: 'bonus_amount', cast: 'numeric' },
  housing: { sql: 'housing_compensation', cast: 'numeric' },
};

/**
 * Значение столбца для фильтра «список значений». У оклада в значении есть вид оплаты:
 * 450 ₽/час и 450 ₽/мес — разные условия, склеивать их в одну галочку нельзя.
 */
const VALUE_KEY_SQL: Record<PayrollValueFilterColumn, string> = {
  department: nullIfBlank('department_name'),
  position: nullIfBlank('position_name'),
  schedule: nullIfBlank('schedule_name'),
  salary: `(CASE WHEN calc_type = 'salary' AND monthly_salary IS NOT NULL THEN 'мес:' || monthly_salary::text
                 WHEN calc_type = 'hourly' AND hourly_rate IS NOT NULL THEN 'час:' || hourly_rate::text END)`,
  bonus: 'bonus_amount::text',
  housing: 'housing_compensation::text',
};

export const payrollSortKeySql = (key: PayrollSortKey): { sql: string; cast: 'text' | 'numeric' } => SORT_KEY_SQL[key];

export const payrollValueKeySql = (column: PayrollValueFilterColumn): string => VALUE_KEY_SQL[column];

/** Порядок вариантов в списке фильтра: суммы — по числу, остальное — по тексту. */
export const payrollValueOrderSql = (column: PayrollValueFilterColumn): string => {
  const sortKey = column === 'department' || column === 'position' || column === 'schedule' ? null : SORT_KEY_SQL[column].sql;
  return sortKey ?? VALUE_KEY_SQL[column];
};

export const isPayrollValueFilterColumn = (value: unknown): value is PayrollValueFilterColumn =>
  typeof value === 'string' && (PAYROLL_VALUE_FILTER_COLUMNS as readonly string[]).includes(value);

export type PayrollSortParseResult = { ok: true; sort: IPayrollSort | null } | { ok: false };

/** Нет sort и dir — прежний порядок по ФИО (старый фронт); dir без sort или неизвестное — ошибка. */
export function parsePayrollSort(queryParams: Record<string, unknown>): PayrollSortParseResult {
  const { sort, dir } = queryParams;
  if (sort === undefined && dir === undefined) return { ok: true, sort: null };
  if (typeof sort !== 'string' || !(PAYROLL_SORT_KEYS as readonly string[]).includes(sort)) return { ok: false };
  if (dir !== undefined && dir !== 'asc' && dir !== 'desc') return { ok: false };
  return { ok: true, sort: { key: sort as PayrollSortKey, dir: (dir as PayrollSortDir | undefined) ?? 'asc' } };
}

/** Курсор сортированной выдачи: key — значение ключа последней строки текстом (null — пустое). */
export interface IPayrollSortCursor {
  key: string | null;
  id: number;
}

export type PayrollSortCursorParseResult = { ok: true; after: IPayrollSortCursor | null } | { ok: false };

const NUMERIC_TEXT = /^-?\d{1,15}(\.\d{1,6})?$/;

/**
 * after_key + after_null + after_id; after_name с сортировкой не принимается (это курсор
 * прежнего порядка). Для числового ключа значение проверяется до SQL — иначе вместо 400
 * был бы 500 от приведения ::numeric.
 */
export function parsePayrollSortCursor(
  queryParams: Record<string, unknown>,
  cast: 'text' | 'numeric',
): PayrollSortCursorParseResult {
  const { after_key: key, after_null: isNull, after_id: idRaw, after_name: legacyName } = queryParams;
  if (legacyName !== undefined) return { ok: false };
  if (key === undefined && isNull === undefined && idRaw === undefined) return { ok: true, after: null };
  if (typeof idRaw !== 'string' || !/^\d+$/.test(idRaw)) return { ok: false };
  const id = Number(idRaw);
  if (!Number.isSafeInteger(id) || id <= 0) return { ok: false };
  if (isNull === '1') return key === undefined ? { ok: true, after: { key: null, id } } : { ok: false };
  if (isNull !== '0' || typeof key !== 'string' || key.length > MAX_VALUE_LENGTH * 2) return { ok: false };
  if (cast === 'numeric' && !NUMERIC_TEXT.test(key)) return { ok: false };
  return { ok: true, after: { key, id } };
}

/**
 * Условие «строка после курсора» над колонками sort_key и employee_id. NULL-ключи идут после
 * всех непустых при любом направлении, поэтому сравнение раскрыто через OR.
 */
export function buildPayrollCursorSql(
  alias: string,
  sort: IPayrollSort,
  after: IPayrollSortCursor,
  params: unknown[],
): string {
  const op = sort.dir === 'asc' ? '>' : '<';
  const { cast } = SORT_KEY_SQL[sort.key];
  const sk = `${alias}.sort_key`;
  params.push(after.id);
  const idIdx = params.length;
  if (after.key === null) return `(${sk} IS NULL AND ${alias}.employee_id ${op} $${idIdx}::int)`;
  params.push(after.key);
  const keyIdx = params.length;
  return `((${sk} IS NOT NULL AND ${sk} ${op} $${keyIdx}::${cast})
        OR (${sk} IS NOT NULL AND ${sk} = $${keyIdx}::${cast} AND ${alias}.employee_id ${op} $${idIdx}::int)
        OR ${sk} IS NULL)`;
}

export const buildPayrollOrderSql = (alias: string, dir: PayrollSortDir): string => {
  const direction = dir === 'asc' ? 'ASC' : 'DESC';
  return `(${alias}.sort_key IS NULL) ASC, ${alias}.sort_key ${direction}, ${alias}.employee_id ${direction}`;
};

const valueListSchema = z.array(z.string().max(MAX_VALUE_LENGTH).nullable()).min(1).max(MAX_VALUES);

const columnFiltersSchema = z.object({
  values: z.object(
    Object.fromEntries(PAYROLL_VALUE_FILTER_COLUMNS.map(column => [column, valueListSchema.optional()])) as
      Record<PayrollValueFilterColumn, z.ZodOptional<typeof valueListSchema>>,
  ).strict().optional(),
  text: z.object({ name: z.string().max(MAX_TEXT_LENGTH).optional() }).strict().optional(),
}).strict();

export type IPayrollColumnFilters = z.infer<typeof columnFiltersSchema>;

export type PayrollColumnFiltersParseResult = { ok: true; filters: IPayrollColumnFilters } | { ok: false };

/** cf отсутствует или пустой — без фильтров; неверный JSON/схема/слишком длинный — ошибка. */
export function parsePayrollColumnFilters(raw: unknown): PayrollColumnFiltersParseResult {
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

/**
 * Условия фильтров столбцов над колонками `scoped`. exclude — столбец, чей фильтр не применяется:
 * варианты значений столбца считаются без его собственного фильтра (как автофильтр Excel).
 */
export function appendPayrollColumnFilters(
  whereParts: string[],
  params: unknown[],
  filters: IPayrollColumnFilters,
  options: { exclude?: PayrollFilterColumn } = {},
): void {
  const { exclude } = options;

  for (const column of PAYROLL_VALUE_FILTER_COLUMNS) {
    const list = filters.values?.[column];
    if (!list || list.length === 0 || column === exclude) continue;
    const key = VALUE_KEY_SQL[column];
    const values = [...new Set(list.filter((value): value is string => value !== null))];
    const parts: string[] = [];
    if (values.length > 0) {
      params.push(values);
      parts.push(`${key} = ANY($${params.length}::text[])`);
    }
    if (list.includes(null)) parts.push(`${key} IS NULL`);
    whereParts.push(`(${parts.join(' OR ')})`);
  }

  const nameText = filters.text?.name?.trim();
  if (nameText && exclude !== 'name') {
    params.push(`%${escapeLike(nameText, MAX_TEXT_LENGTH)}%`);
    whereParts.push(`${SORT_KEY_SQL.name.sql} ILIKE $${params.length}`);
  }
}
