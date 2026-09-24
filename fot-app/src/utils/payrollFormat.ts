import type { PayrollValueFilterColumn } from '../services/payrollService';

/** 175000 → «175 000,00»; не число — null. */
export const formatPayrollMoney = (value: string | number | null | undefined): string | null => {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(num)) return null;
  return num.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/** Целые рубли для итогов: 742300.45 → «742 300»; не число — null. */
export const formatPayrollRubles = (value: number | null | undefined): string | null => {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.round(value).toLocaleString('ru-RU', { maximumFractionDigits: 0 });
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
