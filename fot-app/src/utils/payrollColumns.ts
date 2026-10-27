/**
 * Видимость столбцов таблиц «Условия оплаты» и «Расчёты». Выбор — удобство конкретного браузера,
 * поэтому хранится в localStorage; недоступное или битое хранилище = все столбцы видны.
 */
import type { PayrollSortKey } from '../services/payrollService';


/** Столбцы, которые можно скрыть. Чекбокс выбора, «№» и «Сотрудник» видны всегда. */
export type PayrollTableColumn =
  | 'department' | 'position' | 'schedule' | 'salary' | 'bonus' | 'housing' | 'accruals'
  | 'payout' | 'accrued' | 'deductions'
  | 'calc_rate' | 'calc_timesheet' | 'calc_travel' | 'paid_vacation' | 'paid_sick' | 'calc_housing'
  | 'paid_recalc' | 'calc_supplements' | 'calc_deductions' | 'card_payouts';

/** Столбцы условий с сортировкой и фильтром; суммы «Выплачено» и «Расчётов» их не имеют. */
const SORTABLE_COLUMNS: ReadonlySet<PayrollTableColumn> = new Set<PayrollTableColumn>([
  'department', 'position', 'schedule', 'salary', 'bonus', 'housing',
]);

export const isSortablePayrollColumn = (key: PayrollTableColumn): key is PayrollSortKey & PayrollTableColumn => (
  SORTABLE_COLUMNS.has(key)
);

/** Набор столбцов таблицы в её порядке; подпись — для шестерёнки и шапки сортируемых столбцов. */
export type PayrollTableColumns = ReadonlyArray<{ key: PayrollTableColumn; label: string }>;

const COMMON_COLUMNS: PayrollTableColumns = [
  { key: 'department', label: 'Подразделение' },
  { key: 'position', label: 'Должность' },
  { key: 'schedule', label: 'График работы' },
];

/** «Условия оплаты». */
export const PAYROLL_TERMS_TABLE_COLUMNS: PayrollTableColumns = [
  ...COMMON_COLUMNS,
  { key: 'salary', label: 'Оклад' },
  { key: 'bonus', label: 'Премиальная часть' },
  { key: 'housing', label: 'Компенсация проживания' },
  { key: 'accruals', label: 'Выплачено за посл. полгода' },
];

/**
 * «Расчёты»: вместо условий и «Выплачено» — суммы «Оплачено» за выбранные месяцы, затем состав зарплаты
 * (payrollCalcColumns.ts): по расчёту ФОТ закрытого табеля и из 1С, где ФОТ сумму не считает.
 */
export const PAYROLL_CALC_TABLE_COLUMNS: PayrollTableColumns = [
  ...COMMON_COLUMNS,
  { key: 'payout', label: 'К выплате' },
  { key: 'accrued', label: 'Начислено' },
  { key: 'deductions', label: 'Удержания' },
  { key: 'calc_rate', label: 'Оклад' },
  { key: 'calc_timesheet', label: 'Начислено по табелю' },
  { key: 'calc_travel', label: 'Компенсация проезда' },
  { key: 'paid_vacation', label: 'Отпускные' },
  { key: 'paid_sick', label: 'Больничные' },
  { key: 'calc_housing', label: 'Проживание' },
  { key: 'paid_recalc', label: 'Перерасчёт за пред. месяц' },
  { key: 'calc_supplements', label: 'Доплаты' },
  { key: 'calc_deductions', label: 'Удержания (ФОТ)' },
  { key: 'card_payouts', label: 'Выплаты на карту' },
];

/** Ключи хранилища: у «Условий оплаты» и «Расчётов» скрытые столбцы свои. */
export const PAYROLL_TERMS_COLUMNS_KEY = 'fot:payroll-terms:hidden-columns';
export const PAYROLL_CALC_COLUMNS_KEY = 'fot:payroll-calc:hidden-columns';

/** Все известные столбцы по порядку: «Условия оплаты», затем свои столбцы «Расчётов». */
const ALL_COLUMN_KEYS: PayrollTableColumn[] = [
  ...new Set([...PAYROLL_TERMS_TABLE_COLUMNS, ...PAYROLL_CALC_TABLE_COLUMNS].map(column => column.key)),
];

const KNOWN_COLUMNS = new Set<string>(ALL_COLUMN_KEYS);

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
  const ordered = ALL_COLUMN_KEYS.filter(key => hidden.has(key));
  return ordered.length > 0 ? JSON.stringify(ordered) : null;
};

/**
 * Только столбцы этой таблицы: в ключе «Расчётов» могли остаться оклад, премия и «Выплачено» —
 * их больше нет на экране, и шестерёнка не должна считать их скрытыми.
 */
export const keepPayrollTableColumns = (
  hidden: ReadonlySet<PayrollTableColumn>,
  columns: PayrollTableColumns,
): Set<PayrollTableColumn> => new Set(columns.map(column => column.key).filter(key => hidden.has(key)));

export const loadHiddenPayrollColumns = (storageKey: string, columns: PayrollTableColumns): Set<PayrollTableColumn> => {
  try {
    return keepPayrollTableColumns(parseHiddenPayrollColumns(window.localStorage.getItem(storageKey)), columns);
  } catch {
    return new Set();
  }
};

export const saveHiddenPayrollColumns = (storageKey: string, hidden: ReadonlySet<PayrollTableColumn>): void => {
  try {
    const value = serializeHiddenPayrollColumns(hidden);
    if (value === null) window.localStorage.removeItem(storageKey);
    else window.localStorage.setItem(storageKey, value);
  } catch {
    // Хранилище недоступно (приватный режим, запрет) — выбор живёт до перезагрузки страницы.
  }
};
