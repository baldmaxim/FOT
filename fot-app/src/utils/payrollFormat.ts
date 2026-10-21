import type { PayrollValueFilterColumn } from '../services/payrollService';

/** Верхняя граница суммы — NUMERIC(12,2). */
export const MAX_RATE_AMOUNT = 9_999_999_999.99;
/** Верхняя граница часовой ставки — NUMERIC(12,4). */
export const MAX_HOURLY_RATE = 99_999_999.9999;

export type RateAmountParse = { amount: number | null; error: null } | { amount: null; error: string };

const DECIMALS_LABEL: Record<2 | 4, string> = { 2: 'двух', 4: 'четырёх' };

/**
 * Сумма из поля. Пусто — «не задано» (null, а не 0). Допустимы запятая и пробелы между
 * разрядами («1 250,5»). Лишний знак после запятой БД округлила бы молча — не принимаем:
 * у сумм — копейки (2 знака), у часовой ставки — 4 знака, как в NUMERIC(12,4).
 */
export const parseRateAmount = (raw: string, decimals: 2 | 4 = 2): RateAmountParse => {
  const compact = raw.replace(/\s/g, '').replace(',', '.');
  if (!compact) return { amount: null, error: null };
  if (!new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`).test(compact)) {
    return { amount: null, error: `Значение — число не меньше нуля, до ${DECIMALS_LABEL[decimals]} знаков после запятой` };
  }
  const amount = Number(compact);
  if (amount > (decimals === 4 ? MAX_HOURLY_RATE : MAX_RATE_AMOUNT)) return { amount: null, error: 'Слишком большое значение' };
  return { amount, error: null };
};

/** 175000 → «175 000,00»; не число — null. */
export const formatPayrollMoney = (value: string | number | null | undefined): string | null => {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(num)) return null;
  return num.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const EMPTY_VALUE_LABELS: Record<PayrollValueFilterColumn, string> = {
  department: 'Без подразделения',
  position: 'Без должности',
  schedule: 'Без графика',
  salary: 'Оклад не задан',
  bonus: 'Не задана',
  housing: 'Не задана',
};

/**
 * Подпись варианта в фильтре столбца в формате ячейки таблицы. Значения оклада приходят
 * с видом оплаты: «мес:175000.00» → «175 000,00 ₽/мес», «час:450.0000» → «450,00 ₽/час».
 */
export const formatPayrollFilterValue = (column: PayrollValueFilterColumn, value: string | null): string => {
  if (value === null) return EMPTY_VALUE_LABELS[column];
  if (column === 'salary') {
    const [unit, amount] = value.split(':');
    const money = formatPayrollMoney(amount);
    if (money === null) return value;
    return unit === 'час' ? `${money} ₽/час` : `${money} ₽/мес`;
  }
  if (column === 'bonus' || column === 'housing') {
    const money = formatPayrollMoney(value);
    return money === null ? value : `${money} ₽/мес`;
  }
  return value;
};
