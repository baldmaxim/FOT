/**
 * Начисления за полгода в таблице «Условия оплаты»: окно месяцев, подписи периода и итоги.
 */
import type { IPayrollMonthlyAccrual } from '../services/payrollService';
import { MONTHS_RU } from './calendarUtils';
import { shiftMonth } from './moscowDate';

/** Начисления показываются за полгода. */
export const PAYROLL_ACCRUAL_MONTH_COUNT = 6;

/** Короткие названия в именительном падеже: «май», а не «мая», как в MONTH_GENITIVE_SHORT_RU. */
const MONTHS_SHORT_RU = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_LONG_LOWER_RU = MONTHS_RU.map(name => name.toLowerCase());

const monthIndex = (month: string): number => Number(month.slice(5, 7)) - 1;
const monthYear = (month: string): string => month.slice(0, 4);

/**
 * Закрытые месяцы перед месяцем даты: 2026-09-24 → 2026-03 … 2026-08. Текущий месяц не входит:
 * ЗУП считает его только после закрытия, и последний столбик весь месяц стоял бы пустым.
 */
export const payrollAccrualMonths = (dateIso: string, count = PAYROLL_ACCRUAL_MONTH_COUNT): string[] => {
  const current = dateIso.slice(0, 7);
  return Array.from({ length: count }, (_, index) => shiftMonth(current, index - count));
};

/** Окно захватывает два года — у каждого месяца нужен год. */
export const accrualPeriodCrossesYear = (months: string[]): boolean => (
  months.length > 0 && monthYear(months[0]) !== monthYear(months[months.length - 1])
);

const formatPeriod = (months: string[], names: readonly string[]): string => {
  if (months.length === 0) return '';
  const first = months[0];
  const last = months[months.length - 1];
  const name = (month: string) => names[monthIndex(month)];
  if (accrualPeriodCrossesYear(months)) return `${name(first)} ${monthYear(first)} – ${name(last)} ${monthYear(last)}`;
  return first === last ? `${name(first)} ${monthYear(first)}` : `${name(first)} – ${name(last)} ${monthYear(last)}`;
};

/** «мар – авг 2026»; через границу года — «ноя 2025 – апр 2026». */
export const formatAccrualPeriodShort = (months: string[]): string => formatPeriod(months, MONTHS_SHORT_RU);

/** «март – август 2026»; через границу года — «ноябрь 2025 – апрель 2026». */
export const formatAccrualPeriodLong = (months: string[]): string => formatPeriod(months, MONTHS_LONG_LOWER_RU);

/** Подпись строки окна: «Март»; в окне через границу года — «Декабрь 2025». */
export const formatAccrualMonthLabel = (month: string, withYear: boolean): string => {
  const name = MONTHS_RU[monthIndex(month)];
  return withYear ? `${name} ${monthYear(month)}` : name;
};

export interface IAccrualSummary {
  /** Суммы по месяцам окна в его порядке; null — за месяц данных нет. */
  values: (number | null)[];
  /** Сумма за месяцы с данными; null — данных нет ни за один месяц. */
  total: number | null;
  /** Среднее по месяцам с данными. */
  average: number | null;
  monthsWithData: number;
  /** Наибольшая положительная сумма — масштаб столбиков; 0 — рисовать нечего. */
  max: number;
}

const toAmount = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(num) ? num : null;
};

/** Итоги по окну месяцев. Месяцы вне окна не учитываются, суммы одного месяца складываются. */
export const summarizeAccruals = (
  months: string[],
  accruals: IPayrollMonthlyAccrual[] | null | undefined,
): IAccrualSummary => {
  const byMonth = new Map<string, number>();
  for (const item of accruals ?? []) {
    const amount = toAmount(item.amount);
    if (amount !== null) byMonth.set(item.month, (byMonth.get(item.month) ?? 0) + amount);
  }
  const values = months.map(month => byMonth.get(month) ?? null);
  const present = values.filter((value): value is number => value !== null);
  const total = present.length > 0 ? present.reduce((sum, value) => sum + value, 0) : null;
  return {
    values,
    total,
    average: total === null ? null : total / present.length,
    monthsWithData: present.length,
    max: Math.max(0, ...present),
  };
};

/** Длина столбика в % от максимума строки; ноль, сторно (минус) и «нет данных» — 0. */
export const accrualBarPercent = (value: number | null, max: number): number => {
  if (value === null || value <= 0 || max <= 0) return 0;
  return Math.min(100, (value / max) * 100);
};
