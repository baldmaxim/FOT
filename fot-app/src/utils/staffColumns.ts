/**
 * Видимость столбцов «Текущих сотрудников» (шестерёнка). Выбор — удобство конкретного браузера,
 * поэтому хранится в localStorage; недоступное или битое хранилище = столбцы по умолчанию.
 */

/** Столбцы, которые можно скрыть. «№», «ФИО», «Признак» и кнопки действий видны всегда. */
export type StaffTableColumn =
  | 'department' | 'site' | 'position' | 'hire_date' | 'birth_date' | 'schedule' | 'main_object' | 'comment';

/** В порядке таблицы. */
export const STAFF_TABLE_COLUMNS: ReadonlyArray<{ key: StaffTableColumn; label: string }> = [
  { key: 'department', label: 'Отдел' },
  { key: 'site', label: 'Участок' },
  { key: 'position', label: 'Должность' },
  { key: 'hire_date', label: 'Дата трудоустройства' },
  { key: 'birth_date', label: 'Дата рождения' },
  { key: 'schedule', label: 'График' },
  { key: 'main_object', label: 'Объект' },
  { key: 'comment', label: 'Комментарий' },
];

export const STAFF_COLUMNS_KEY = 'fot:staff:hidden-columns';

/** По умолчанию — прежняя таблица: «Участок» включается шестерёнкой. */
export const DEFAULT_HIDDEN_STAFF_COLUMNS: ReadonlySet<StaffTableColumn> = new Set<StaffTableColumn>(['site']);

const KNOWN_COLUMNS = new Set<string>(STAFF_TABLE_COLUMNS.map(column => column.key));

export const isStaffTableColumn = (value: unknown): value is StaffTableColumn => (
  typeof value === 'string' && KNOWN_COLUMNS.has(value)
);

/** Разбор сохранённого значения: ничего не сохранено или мусор — умолчание; неизвестные ключи отбрасываются. */
export const parseHiddenStaffColumns = (raw: string | null): Set<StaffTableColumn> => {
  if (raw === null) return new Set(DEFAULT_HIDDEN_STAFF_COLUMNS);
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter(isStaffTableColumn)) : new Set(DEFAULT_HIDDEN_STAFF_COLUMNS);
  } catch {
    return new Set(DEFAULT_HIDDEN_STAFF_COLUMNS);
  }
};

/**
 * Строка для хранилища в порядке таблицы. Пустой выбор тоже сохраняется ('[]'): иначе
 * «Показать все» после перезагрузки вернулось бы к умолчанию со скрытым «Участком».
 */
export const serializeHiddenStaffColumns = (hidden: ReadonlySet<StaffTableColumn>): string =>
  JSON.stringify(STAFF_TABLE_COLUMNS.map(column => column.key).filter(key => hidden.has(key)));

export const loadHiddenStaffColumns = (): Set<StaffTableColumn> => {
  try {
    return parseHiddenStaffColumns(window.localStorage.getItem(STAFF_COLUMNS_KEY));
  } catch {
    return new Set(DEFAULT_HIDDEN_STAFF_COLUMNS);
  }
};

export const saveHiddenStaffColumns = (hidden: ReadonlySet<StaffTableColumn>): void => {
  try {
    window.localStorage.setItem(STAFF_COLUMNS_KEY, serializeHiddenStaffColumns(hidden));
  } catch {
    // Хранилище недоступно (приватный режим, запрет) — выбор живёт до перезагрузки страницы.
  }
};

export const isDefaultStaffColumns = (hidden: ReadonlySet<StaffTableColumn>): boolean =>
  hidden.size === DEFAULT_HIDDEN_STAFF_COLUMNS.size && [...hidden].every(key => DEFAULT_HIDDEN_STAFF_COLUMNS.has(key));

/** Видимые настраиваемые столбцы в порядке таблицы — для выгрузки. */
export const visibleStaffColumns = (hidden: ReadonlySet<StaffTableColumn>): StaffTableColumn[] =>
  STAFF_TABLE_COLUMNS.map(column => column.key).filter(key => !hidden.has(key));

/**
 * Минимальная ширина таблицы, px: сумма столбцов как .sc-col-* в StaffControlPage.css («Объект» и
 * «Комментарий» гибкие — по 140 минимум). Уже — скроллится таблица, не страница.
 */
const COLUMN_WIDTH: Record<StaffTableColumn, number> = {
  department: 150,
  site: 150,
  position: 160,
  hire_date: 180,
  birth_date: 130,
  schedule: 160,
  main_object: 140,
  comment: 140,
};
/** №, ФИО, Признак, действия. */
const FIXED_WIDTH = 60 + 220 + 130 + 140;
const CHECK_WIDTH = 44;

export const staffTableMinWidth = (hidden: ReadonlySet<StaffTableColumn>, selectionMode: boolean): number =>
  FIXED_WIDTH
  + (selectionMode ? CHECK_WIDTH : 0)
  + visibleStaffColumns(hidden).reduce((sum, key) => sum + COLUMN_WIDTH[key], 0);
