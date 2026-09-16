/**
 * Фильтры по столбцам «Текущих сотрудников». Та же схема, что на сервере (параметр cf):
 * списки значений, диапазоны дат, текст «содержит», наличие комментария.
 */

export type StaffValueFilterColumn = 'department' | 'position' | 'schedule' | 'main_object' | 'sign';
export type StaffDateFilterColumn = 'hire_date' | 'birth_date';
export type StaffTextFilterColumn = 'name' | 'comment';
export type StaffFilterColumn = StaffValueFilterColumn | StaffDateFilterColumn | StaffTextFilterColumn;

export interface IStaffDateRange {
  from?: string;
  to?: string;
  empty?: boolean;
}

export interface IStaffColumnFilters {
  /** null в списке — «пусто». */
  values?: Partial<Record<StaffValueFilterColumn, (string | null)[]>>;
  dates?: Partial<Record<StaffDateFilterColumn, IStaffDateRange>>;
  text?: Partial<Record<StaffTextFilterColumn, string>>;
  has_comment?: boolean;
}

export const STAFF_VALUE_FILTER_COLUMNS: readonly StaffValueFilterColumn[] = ['department', 'position', 'schedule', 'main_object', 'sign'];
export const STAFF_DATE_FILTER_COLUMNS: readonly StaffDateFilterColumn[] = ['hire_date', 'birth_date'];
export const STAFF_TEXT_FILTER_COLUMNS: readonly StaffTextFilterColumn[] = ['name', 'comment'];

/** Лимиты сервера: при превышении запрос отклоняется, поэтому режем заранее. */
export const MAX_FILTER_VALUES = 200;
export const MAX_FILTER_TEXT = 200;

export const EMPTY_COLUMN_FILTERS: IStaffColumnFilters = {};

export const columnFilterKind = (column: StaffFilterColumn): 'values' | 'dates' | 'text' => {
  if ((STAFF_VALUE_FILTER_COLUMNS as readonly string[]).includes(column)) return 'values';
  if ((STAFF_DATE_FILTER_COLUMNS as readonly string[]).includes(column)) return 'dates';
  return 'text';
};

/** Убирает пустые фильтры; ключи в фиксированном порядке — стабильная сериализация для URL и query key. */
export const normalizeColumnFilters = (filters: IStaffColumnFilters): IStaffColumnFilters => {
  const result: IStaffColumnFilters = {};

  const values: NonNullable<IStaffColumnFilters['values']> = {};
  for (const column of STAFF_VALUE_FILTER_COLUMNS) {
    const list = filters.values?.[column];
    if (!list || list.length === 0) continue;
    const unique = [...new Set(list)].slice(0, MAX_FILTER_VALUES);
    values[column] = unique.sort((a, b) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b, 'ru')));
  }
  if (Object.keys(values).length > 0) result.values = values;

  const dates: NonNullable<IStaffColumnFilters['dates']> = {};
  for (const column of STAFF_DATE_FILTER_COLUMNS) {
    const range = filters.dates?.[column];
    if (!range) continue;
    const next: IStaffDateRange = {};
    if (range.from) next.from = range.from;
    if (range.to) next.to = range.to;
    if (next.from && next.to && next.from > next.to) [next.from, next.to] = [next.to, next.from];
    if (range.empty) next.empty = true;
    if (next.from || next.to || next.empty) dates[column] = next;
  }
  if (Object.keys(dates).length > 0) result.dates = dates;

  const text: NonNullable<IStaffColumnFilters['text']> = {};
  for (const column of STAFF_TEXT_FILTER_COLUMNS) {
    const value = filters.text?.[column]?.trim().slice(0, MAX_FILTER_TEXT);
    if (value) text[column] = value;
  }
  if (Object.keys(text).length > 0) result.text = text;

  if (filters.has_comment !== undefined) result.has_comment = filters.has_comment;
  return result;
};

/** '' — фильтров нет (параметр cf не отправляется). */
export const serializeColumnFilters = (filters: IStaffColumnFilters): string => {
  const normalized = normalizeColumnFilters(filters);
  return Object.keys(normalized).length === 0 ? '' : JSON.stringify(normalized);
};

/** Из URL: мусор и чужие поля отбрасываются — лучше без фильтра, чем 400 на странице. */
export const parseColumnFilters = (raw: string | null): IStaffColumnFilters => {
  if (!raw) return EMPTY_COLUMN_FILTERS;
  try {
    const json: unknown = JSON.parse(raw);
    if (!json || typeof json !== 'object' || Array.isArray(json)) return EMPTY_COLUMN_FILTERS;
    const source = json as Record<string, unknown>;
    const filters: IStaffColumnFilters = {};
    const values = source.values as Record<string, unknown> | undefined;
    if (values && typeof values === 'object') {
      filters.values = {};
      for (const column of STAFF_VALUE_FILTER_COLUMNS) {
        const list = values[column];
        if (Array.isArray(list)) {
          filters.values[column] = list.filter((item): item is string | null => item === null || typeof item === 'string');
        }
      }
    }
    const dates = source.dates as Record<string, unknown> | undefined;
    if (dates && typeof dates === 'object') {
      filters.dates = {};
      const isoDate = (value: unknown): string | undefined => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined);
      for (const column of STAFF_DATE_FILTER_COLUMNS) {
        const range = dates[column] as Record<string, unknown> | undefined;
        if (range && typeof range === 'object') {
          filters.dates[column] = { from: isoDate(range.from), to: isoDate(range.to), empty: range.empty === true };
        }
      }
    }
    const text = source.text as Record<string, unknown> | undefined;
    if (text && typeof text === 'object') {
      filters.text = {};
      for (const column of STAFF_TEXT_FILTER_COLUMNS) {
        if (typeof text[column] === 'string') filters.text[column] = text[column] as string;
      }
    }
    if (typeof source.has_comment === 'boolean') filters.has_comment = source.has_comment;
    return normalizeColumnFilters(filters);
  } catch {
    return EMPTY_COLUMN_FILTERS;
  }
};

export const isColumnFilterActive = (filters: IStaffColumnFilters, column: StaffFilterColumn): boolean => {
  const kind = columnFilterKind(column);
  if (kind === 'values') return (filters.values?.[column as StaffValueFilterColumn]?.length ?? 0) > 0;
  if (kind === 'dates') {
    const range = filters.dates?.[column as StaffDateFilterColumn];
    return Boolean(range && (range.from || range.to || range.empty));
  }
  const hasText = Boolean(filters.text?.[column as StaffTextFilterColumn]?.trim());
  return column === 'comment' ? hasText || filters.has_comment !== undefined : hasText;
};

export const countActiveColumnFilters = (filters: IStaffColumnFilters): number =>
  (['name', 'department', 'position', 'hire_date', 'birth_date', 'schedule', 'main_object', 'comment', 'sign'] as const)
    .filter(column => isColumnFilterActive(filters, column)).length;

/** Фильтр одного столбца, остальные без изменений; null — снять фильтр столбца. */
export interface IColumnFilterValue {
  values?: (string | null)[];
  dates?: IStaffDateRange;
  text?: string;
  hasComment?: boolean;
}

export const setColumnFilter = (
  filters: IStaffColumnFilters,
  column: StaffFilterColumn,
  value: IColumnFilterValue | null,
): IStaffColumnFilters => {
  const next: IStaffColumnFilters = {
    values: { ...filters.values },
    dates: { ...filters.dates },
    text: { ...filters.text },
    has_comment: filters.has_comment,
  };
  const kind = columnFilterKind(column);
  if (kind === 'values') {
    next.values![column as StaffValueFilterColumn] = value?.values;
  } else if (kind === 'dates') {
    next.dates![column as StaffDateFilterColumn] = value?.dates;
  } else {
    next.text![column as StaffTextFilterColumn] = value?.text;
    if (column === 'comment') next.has_comment = value?.hasComment;
  }
  return normalizeColumnFilters(next);
};

/** Текущее значение фильтра столбца для редактора. */
export const getColumnFilter = (filters: IStaffColumnFilters, column: StaffFilterColumn): IColumnFilterValue => {
  const kind = columnFilterKind(column);
  if (kind === 'values') return { values: filters.values?.[column as StaffValueFilterColumn] ?? [] };
  if (kind === 'dates') return { dates: filters.dates?.[column as StaffDateFilterColumn] ?? {} };
  return {
    text: filters.text?.[column as StaffTextFilterColumn] ?? '',
    hasComment: column === 'comment' ? filters.has_comment : undefined,
  };
};
