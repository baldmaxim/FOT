import type {
  IPayrollColumnFilters,
  PayrollSortKey,
  PayrollValueFilterColumn,
} from '../services/payrollService';

/** Порядок совпадает со столбцами таблицы. */
export const PAYROLL_VALUE_FILTER_COLUMNS: readonly PayrollValueFilterColumn[] = [
  'department', 'position', 'schedule', 'salary', 'bonus', 'housing',
];

/** Лимиты сервера (payroll-terms-list.helpers.ts). */
export const MAX_PAYROLL_FILTER_VALUES = 200;
export const MAX_PAYROLL_FILTER_TEXT = 200;

export const isPayrollValueFilterColumn = (value: string): value is PayrollValueFilterColumn =>
  (PAYROLL_VALUE_FILTER_COLUMNS as readonly string[]).includes(value);

/** Сортировка по русскому алфавиту, «(пусто)» в конце — для стабильной сериализации. */
const compareValues = (a: string | null, b: string | null): number => {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b, 'ru');
};

/**
 * Убирает пустые фильтры, дубликаты и упорядочивает значения: одинаковые фильтры дают
 * одинаковую строку — один ключ кэша и один запрос.
 */
export const normalizePayrollColumnFilters = (filters: IPayrollColumnFilters): IPayrollColumnFilters => {
  const result: IPayrollColumnFilters = {};
  for (const column of PAYROLL_VALUE_FILTER_COLUMNS) {
    const list = filters.values?.[column];
    if (!list || list.length === 0) continue;
    const unique = [...new Set(list)].sort(compareValues).slice(0, MAX_PAYROLL_FILTER_VALUES);
    result.values = { ...result.values, [column]: unique };
  }
  const name = filters.text?.name?.trim().slice(0, MAX_PAYROLL_FILTER_TEXT);
  if (name) result.text = { name };
  return result;
};

/** '' — фильтров нет (параметр cf не отправляется). */
export const serializePayrollColumnFilters = (filters: IPayrollColumnFilters): string => {
  const normalized = normalizePayrollColumnFilters(filters);
  return normalized.values || normalized.text ? JSON.stringify(normalized) : '';
};

export const countActivePayrollColumnFilters = (filters: IPayrollColumnFilters): number => {
  const normalized = normalizePayrollColumnFilters(filters);
  return Object.keys(normalized.values ?? {}).length + (normalized.text?.name ? 1 : 0);
};

export const isPayrollColumnFilterActive = (filters: IPayrollColumnFilters, column: PayrollSortKey): boolean => (
  column === 'name'
    ? Boolean(filters.text?.name?.trim())
    : (filters.values?.[column]?.length ?? 0) > 0
);

/** Фильтр одного столбца: список значений или текст ФИО; null — снять фильтр столбца. */
export const setPayrollColumnFilter = (
  filters: IPayrollColumnFilters,
  column: PayrollSortKey,
  value: (string | null)[] | string | null,
): IPayrollColumnFilters => {
  if (column === 'name') {
    const name = typeof value === 'string' ? value : '';
    return normalizePayrollColumnFilters({ ...filters, text: { name } });
  }
  const list = Array.isArray(value) ? value : [];
  return normalizePayrollColumnFilters({ ...filters, values: { ...filters.values, [column]: list } });
};
