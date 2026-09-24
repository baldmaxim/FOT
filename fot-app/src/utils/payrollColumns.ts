/**
 * Видимость столбцов таблицы «Условия оплаты». Выбор — удобство конкретного браузера,
 * поэтому хранится в localStorage; недоступное или битое хранилище = все столбцы видны.
 */

/** Столбцы, которые можно скрыть. Чекбокс выбора, «№» и «Сотрудник» видны всегда. */
export type PayrollTableColumn = 'department' | 'position' | 'schedule' | 'salary' | 'bonus' | 'housing' | 'accruals';

/** В порядке таблицы. */
export const PAYROLL_TABLE_COLUMNS: ReadonlyArray<{ key: PayrollTableColumn; label: string }> = [
  { key: 'department', label: 'Подразделение' },
  { key: 'position', label: 'Должность' },
  { key: 'schedule', label: 'График работы' },
  { key: 'salary', label: 'Оклад' },
  { key: 'bonus', label: 'Премиальная часть' },
  { key: 'housing', label: 'Компенсация проживания' },
  { key: 'accruals', label: 'Начисления за посл. полгода' },
];

const STORAGE_KEY = 'fot:payroll-terms:hidden-columns';

const KNOWN_COLUMNS = new Set<string>(PAYROLL_TABLE_COLUMNS.map(column => column.key));

const isPayrollTableColumn = (value: unknown): value is PayrollTableColumn => (
  typeof value === 'string' && KNOWN_COLUMNS.has(value)
);

/** Разбор сохранённого значения: неизвестные ключи и мусор отбрасываются. */
export const parseHiddenPayrollColumns = (raw: string | null): Set<PayrollTableColumn> => {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter(isPayrollTableColumn)) : new Set();
  } catch {
    return new Set();
  }
};

/** Строка для хранилища в порядке таблицы; null — ничего не скрыто (ключ удаляется). */
export const serializeHiddenPayrollColumns = (hidden: ReadonlySet<PayrollTableColumn>): string | null => {
  const ordered = PAYROLL_TABLE_COLUMNS.map(column => column.key).filter(key => hidden.has(key));
  return ordered.length > 0 ? JSON.stringify(ordered) : null;
};

export const loadHiddenPayrollColumns = (): Set<PayrollTableColumn> => {
  try {
    return parseHiddenPayrollColumns(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return new Set();
  }
};

export const saveHiddenPayrollColumns = (hidden: ReadonlySet<PayrollTableColumn>): void => {
  try {
    const value = serializeHiddenPayrollColumns(hidden);
    if (value === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Хранилище недоступно (приватный режим, запрет) — выбор живёт до перезагрузки страницы.
  }
};
