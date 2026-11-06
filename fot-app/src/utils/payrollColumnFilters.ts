import type {
  IPayrollColumnFilters,
  IPayrollTermsRow,
  PayrollSortKey,
  PayrollValueFilterColumn,
} from '../services/payrollService';

/** Пометка «ГПХ» под ФИО и столбец «Договор» экспорта — то же, по чему отбирает «Только ГПХ» (is_gph сервера). */
export const isPayrollGphRow = (row: Pick<IPayrollTermsRow, 'is_gph' | 'contract_type'>): boolean => (
  row.is_gph ?? row.contract_type === 'gph'
);

/** Порядок совпадает со столбцами таблицы. */
export const PAYROLL_VALUE_FILTER_COLUMNS: readonly PayrollValueFilterColumn[] = [
  'department', 'position', 'schedule', 'salary', 'bonus', 'housing',
];

/** Подписи столбцов: заголовок окна фильтра и подзаголовок выгрузки. */
export const PAYROLL_FILTER_COLUMN_LABELS: Record<PayrollSortKey, string> = {
  name: 'Сотрудник',
  department: 'Подразделение',
  position: 'Должность',
  schedule: 'График работы',
  salary: 'Оклад',
  bonus: 'Премиальная часть',
  housing: 'Компенсация проживания',
};

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
  if (filters.contract === 'gph') result.contract = 'gph';
  return result;
};

/** '' — фильтров нет (параметр cf не отправляется). */
export const serializePayrollColumnFilters = (filters: IPayrollColumnFilters): string => {
  const normalized = normalizePayrollColumnFilters(filters);
  return normalized.values || normalized.text || normalized.contract ? JSON.stringify(normalized) : '';
};

export const countActivePayrollColumnFilters = (filters: IPayrollColumnFilters): number => {
  const normalized = normalizePayrollColumnFilters(filters);
  return Object.keys(normalized.values ?? {}).length + (normalized.text?.name ? 1 : 0) + (normalized.contract ? 1 : 0);
};

export const isPayrollColumnFilterActive = (filters: IPayrollColumnFilters, column: PayrollSortKey): boolean => (
  column === 'name'
    ? Boolean(filters.text?.name?.trim()) || filters.contract === 'gph'
    : (filters.values?.[column]?.length ?? 0) > 0
);

/** «Сотрудник»: текст «Содержит» и галочка «Только ГПХ». */
export interface IPayrollNameFilter {
  name: string;
  gph: boolean;
}

/** Значение фильтра столбца: список значений, «Сотрудник» или null — снять фильтр столбца. */
export type PayrollColumnFilterValue = (string | null)[] | IPayrollNameFilter | null;

/** Фильтр одного столбца; у «Сотрудника» null снимает и текст, и галочку «Только ГПХ». */
export const setPayrollColumnFilter = (
  filters: IPayrollColumnFilters,
  column: PayrollSortKey,
  value: PayrollColumnFilterValue,
): IPayrollColumnFilters => {
  if (column === 'name') {
    const nameFilter = value !== null && !Array.isArray(value) ? value : null;
    return normalizePayrollColumnFilters({
      ...filters,
      text: { name: nameFilter?.name ?? '' },
      contract: nameFilter?.gph ? 'gph' : undefined,
    });
  }
  const list = Array.isArray(value) ? value : [];
  return normalizePayrollColumnFilters({ ...filters, values: { ...filters.values, [column]: list } });
};
