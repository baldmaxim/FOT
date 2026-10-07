/**
 * Клиентские таблицы «как в Управлении кадрами»: сортировка, фильтры столбцов по значениям и
 * снимок для xlsx. Для таблиц, где все строки уже на клиенте (десятки, а не тысячи).
 *
 * Экран, варианты фильтра и снимок экспорта строятся из одних и тех же описаний столбцов:
 * выгрузка не может разойтись с тем, что видит пользователь.
 */

export type SortDir = 'asc' | 'desc';

export interface ITableView {
  /** Ключ столбца сортировки; '' — порядок, в котором строки пришли. */
  sort: string;
  dir: SortDir;
  /** Столбец → выбранные тексты ячеек. */
  filters: Record<string, string[]>;
}

/** Тип столбца в xlsx: сервер ставит по нему числовой формат. */
export type TableExportColumnType = 'text' | 'money' | 'percent' | 'int';

export interface ITableColumn<Row> {
  key: string;
  label: string;
  type: TableExportColumnType;
  /** Подсказка заголовка. */
  title?: string;
  /** Текст ячейки на экране — он же значение в фильтре столбца. */
  text: (row: Row) => string;
  /** Значение сортировки; null — в конце при любом направлении. */
  sortValue: (row: Row) => number | string | null;
  /** Точное значение для xlsx (сумма — строкой numeric, как с сервера); null — текст экрана. */
  exportValue?: (row: Row) => string | number | null;
}

export interface IFilterOption {
  value: string;
  count: number;
}

/** Снимок таблицы экрана для xlsx: видимые строки в порядке экрана, сервер только оформляет лист. */
export interface ITableExportSnapshot {
  title: string;
  subtitle: string;
  file_name: string;
  columns: Array<{ label: string; type: TableExportColumnType }>;
  rows: Array<{ cells: Array<string | number | null>; muted?: boolean }>;
}

/** Строка проходит фильтры всех столбцов, кроме skipKey (варианты самого столбца — без его фильтра). */
const passesFilters = <Row,>(
  row: Row,
  columns: ReadonlyArray<ITableColumn<Row>>,
  filters: Record<string, string[]>,
  skipKey?: string,
): boolean => columns.every((column) => {
  if (column.key === skipKey) return true;
  const selected = filters[column.key];
  return !selected || selected.length === 0 || selected.includes(column.text(row));
});

const compareValues = (a: number | string, b: number | string): number => (
  typeof a === 'number' && typeof b === 'number'
    ? a - b
    : String(a).localeCompare(String(b), 'ru', { numeric: true, sensitivity: 'base' })
);

/** Сравнение для сортировки: пустые — в конце при любом направлении, как у кадров. */
const compareSortEntries = (
  a: number | string | null,
  b: number | string | null,
  factor: number,
): number => {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compareValues(a, b) * factor;
};

/** Видимые строки: фильтры столбцов, затем сортировка (устойчивая — равные в прежнем порядке). */
export const applyTableView = <Row,>(
  rows: ReadonlyArray<Row>,
  columns: ReadonlyArray<ITableColumn<Row>>,
  view: ITableView,
): Row[] => {
  const filtered = rows.filter(row => passesFilters(row, columns, view.filters));
  const column = columns.find(item => item.key === view.sort);
  if (!column) return filtered;
  const factor = view.dir === 'asc' ? 1 : -1;
  return filtered
    .map((row, index) => ({ row, index, value: column.sortValue(row) }))
    .sort((a, b) => compareSortEntries(a.value, b.value, factor) || a.index - b.index)
    .map(item => item.row);
};

/**
 * Варианты фильтра столбца со счётчиками — по строкам, прошедшим фильтры ОСТАЛЬНЫХ столбцов
 * (как у кадров). Выбранные значения, которых в строках больше нет, остаются в списке с нулём:
 * иначе снять такую галочку было бы нечем.
 */
export const columnFilterOptions = <Row,>(
  rows: ReadonlyArray<Row>,
  columns: ReadonlyArray<ITableColumn<Row>>,
  filters: Record<string, string[]>,
  key: string,
): IFilterOption[] => {
  const column = columns.find(item => item.key === key);
  if (!column) return [];

  const entries = new Map<string, { count: number; sort: number | string | null }>();
  for (const row of rows) {
    if (!passesFilters(row, columns, filters, key)) continue;
    const text = column.text(row);
    const entry = entries.get(text);
    if (entry) entry.count += 1;
    else entries.set(text, { count: 1, sort: column.sortValue(row) });
  }
  for (const value of filters[key] ?? []) {
    if (!entries.has(value)) entries.set(value, { count: 0, sort: null });
  }

  return [...entries.entries()]
    .sort(([, a], [, b]) => compareSortEntries(a.sort, b.sort, 1))
    .map(([value, entry]) => ({ value, count: entry.count }));
};

export const isColumnFiltered = (view: ITableView, key: string): boolean =>
  (view.filters[key]?.length ?? 0) > 0;

/** Повторный клик по столбцу меняет направление, другой столбец — по возрастанию. */
export const toggleSort = (view: ITableView, key: string): ITableView => (
  view.sort === key
    ? { ...view, dir: view.dir === 'asc' ? 'desc' : 'asc' }
    : { ...view, sort: key, dir: 'asc' }
);

/** Фильтр одного столбца; null или пустой список — снять. */
export const setColumnFilter = (view: ITableView, key: string, values: string[] | null): ITableView => {
  const filters = { ...view.filters };
  if (values && values.length > 0) filters[key] = values;
  else delete filters[key];
  return { ...view, filters };
};

/** Снимок таблицы для xlsx: «№» и столбцы экрана, строки — видимые, в порядке экрана. */
export const buildExportTable = <Row,>(params: {
  title: string;
  subtitle: string;
  fileName: string;
  columns: ReadonlyArray<ITableColumn<Row>>;
  rows: ReadonlyArray<Row>;
  isMuted?: (row: Row) => boolean;
}): ITableExportSnapshot => ({
  title: params.title,
  subtitle: params.subtitle,
  file_name: params.fileName,
  columns: [
    { label: '№', type: 'int' },
    ...params.columns.map(column => ({ label: column.label, type: column.type })),
  ],
  rows: params.rows.map((row, index) => ({
    cells: [index + 1, ...params.columns.map(column => column.exportValue?.(row) ?? column.text(row))],
    ...(params.isMuted?.(row) ? { muted: true } : {}),
  })),
});
