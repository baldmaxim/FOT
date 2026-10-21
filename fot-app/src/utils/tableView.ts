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
  /**
   * Значения фильтра, если в ячейке их несколько («ТМЦ, Питание»): строка проходит, когда выбрано хоть
   * одно из них, а в списке фильтра — отдельные значения, не склейки. Не задано — текст ячейки.
   */
  filterValues?: (row: Row) => string[];
}

/** Столбец таблицы-реестра (RegistryTable): ширина и перенос. */
export interface IRegistryColumn<Row> extends ITableColumn<Row> {
  /** Ширина в px; не задана — остаток ширины таблицы (ФИО). */
  width?: number;
  /** Одной строкой (даты, суммы); иначе текст переносится до двух строк. */
  nowrap?: boolean;
  /** Число — по правому краю. */
  numeric?: boolean;
}

/** «№», минимум ФИО и столбец ✎ / 🗑 таблицы-реестра (RegistryTable.module.css); на телефоне кнопки 44px. */
export const REGISTRY_NUM_WIDTH = 48;
export const REGISTRY_NAME_MIN_WIDTH = 170;
export const REGISTRY_ACTIONS_WIDTH = 84;
export const REGISTRY_ACTIONS_WIDTH_TOUCH = 116;
/** Заголовку столбца кроме подписи: паддинги 24 + стрелка 16 (12 и зазор 4) + зазор 2 + воронка 16. */
export const REGISTRY_HEADER_EXTRA = 58;
/** Ячейке кроме текста: паддинги 24 + запас 4 на расхождение замера canvas и вёрстки. */
export const REGISTRY_CELL_EXTRA = 28;
/** Шире текст столбец не тянет: длинное «Основание» переносится, а не забирает таблицу. */
export const REGISTRY_TEXT_MAX_WIDTH = 360;

/**
 * Запас после подписей — переносящимся столбцам (ФИО, отдел, должность, основание…) по их тексту: не хватает
 * на всех — пропорционально нехватке; хватает — каждому по тексту, остаток пропорционально ширинам. Даты и суммы
 * (nowrap) не трогаем. Столбец без ширины (ФИО) так и остаётся без неё — его доля и есть остаток таблицы.
 */
const growToContent = <Row,>(
  columns: ReadonlyArray<IRegistryColumn<Row>>,
  widths: ReadonlyArray<number | undefined>,
  contentWidths: ReadonlyArray<number>,
  spare: number,
): Array<number | undefined> => {
  if (spare <= 0) return [...widths];
  const grow = columns.flatMap((column, index) => {
    if (column.nowrap) return [];
    const current = widths[index] ?? REGISTRY_NAME_MIN_WIDTH;
    const text = Math.min(REGISTRY_TEXT_MAX_WIDTH, Math.ceil(contentWidths[index] ?? 0) + REGISTRY_CELL_EXTRA);
    return [{ index, current, wanted: Math.max(current, text) }];
  });
  const need = grow.reduce((sum, item) => sum + item.wanted - item.current, 0);
  const wantedTotal = grow.reduce((sum, item) => sum + item.wanted, 0);
  const result = [...widths];
  grow.forEach((item) => {
    if (widths[item.index] === undefined) return;
    result[item.index] = need >= spare
      ? item.current + Math.floor((item.wanted - item.current) * spare / need)
      : item.wanted + Math.floor((spare - need) * item.wanted / wantedTotal);
  });
  return result;
};

/**
 * Ширины столбцов таблицы-реестра под ширину контейнера. width столбца — компактная ширина (подпись может
 * переноситься); если запас позволяет, столбец расширяется так, чтобы подпись встала в одну строку. Жадно, по
 * порядку столбцов: не влез один — следующие ещё пробуем. Запас — контейнер минус «№», ФИО не уже минимума,
 * действия и компактные ширины. Остаток запаса при contentWidths делится по тексту (growToContent), без них —
 * весь у ФИО. undefined — столбец без ширины (ФИО, остаток).
 */
export const fitRegistryColumnWidths = <Row,>(params: {
  columns: ReadonlyArray<IRegistryColumn<Row>>;
  containerWidth: number;
  /** Ширина подписи одной строкой, px. */
  labelWidth: (label: string) => number;
  /** Столбец действий; 0 — его нет. */
  actionsWidth: number;
  /** Самый длинный текст ячеек столбца одной строкой, px (по индексу столбца). */
  contentWidths?: ReadonlyArray<number>;
}): Array<number | undefined> => {
  const compactTotal = params.columns.reduce((sum, column) => sum + (column.width ?? 0), 0);
  let spare = params.containerWidth - REGISTRY_NUM_WIDTH - REGISTRY_NAME_MIN_WIDTH - params.actionsWidth - compactTotal;
  const widths = params.columns.map((column) => {
    if (column.width === undefined) return undefined;
    const oneLine = Math.ceil(params.labelWidth(column.label)) + REGISTRY_HEADER_EXTRA;
    const extra = oneLine - column.width;
    if (extra <= 0 || extra > spare) return column.width;
    spare -= extra;
    return oneLine;
  });
  return params.contentWidths ? growToContent(params.columns, widths, params.contentWidths, spare) : widths;
};

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

/** Значения ячейки для фильтра: отдельные (filterValues) или текст ячейки. */
const cellFilterValues = <Row,>(row: Row, column: ITableColumn<Row>): string[] => (
  column.filterValues ? column.filterValues(row) : [column.text(row)]
);

/** Строка проходит фильтры всех столбцов, кроме skipKey (варианты самого столбца — без его фильтра). */
const passesFilters = <Row,>(
  row: Row,
  columns: ReadonlyArray<ITableColumn<Row>>,
  filters: Record<string, string[]>,
  skipKey?: string,
): boolean => columns.every((column) => {
  if (column.key === skipKey) return true;
  const selected = filters[column.key];
  if (!selected || selected.length === 0) return true;
  return cellFilterValues(row, column).some(value => selected.includes(value));
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
    for (const text of new Set(cellFilterValues(row, column))) {
      const entry = entries.get(text);
      if (entry) entry.count += 1;
      // У отдельных значений своя сортировка — по тексту, а не по ключу строки.
      else entries.set(text, { count: 1, sort: column.filterValues ? text : column.sortValue(row) });
    }
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

/**
 * Снимок таблицы для xlsx: «№» и столбцы экрана, строки — видимые, в порядке экрана.
 * totals — строка итогов экрана (ключ — column.key), идёт последней, без номера.
 */
export const buildExportTable = <Row,>(params: {
  title: string;
  subtitle: string;
  fileName: string;
  columns: ReadonlyArray<ITableColumn<Row>>;
  rows: ReadonlyArray<Row>;
  isMuted?: (row: Row) => boolean;
  totals?: Readonly<Record<string, string | number | null>>;
}): ITableExportSnapshot => {
  const { totals } = params;
  return {
    title: params.title,
    subtitle: params.subtitle,
    file_name: params.fileName,
    columns: [
      { label: '№', type: 'int' },
      ...params.columns.map(column => ({ label: column.label, type: column.type })),
    ],
    rows: [
      ...params.rows.map((row, index) => ({
        cells: [index + 1, ...params.columns.map(column => column.exportValue?.(row) ?? column.text(row))],
        ...(params.isMuted?.(row) ? { muted: true } : {}),
      })),
      ...(totals && params.rows.length > 0
        ? [{ cells: [null, ...params.columns.map(column => totals[column.key] ?? null)] }]
        : []),
    ],
  };
};

/** Поиск по ФИО над таблицей: без учёта регистра и «ё». */
export const matchesNameSearch = (name: string | null | undefined, search: string): boolean => {
  const needle = search.trim().toLocaleLowerCase('ru').replace(/ё/g, 'е');
  if (!needle) return true;
  return (name ?? '').toLocaleLowerCase('ru').replace(/ё/g, 'е').includes(needle);
};
