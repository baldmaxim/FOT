/**
 * Ставки «Справочника» по месяцам (миграция 324): значение за месяц — последняя запись истории не позже него.
 * Первое значение действует «с начала», следующие меняют с текущего месяца МСК и до RATE_MONTHS_AHEAD вперёд —
 * прошлые месяцы сохраняют своё значение.
 */
import type { IPayrollRateValue, IPayrollTermsRow, StaffCategory } from '../services/payrollService';
import { shiftMonth } from './moscowDate';

/** Значение меняют не дальше, чем на столько месяцев вперёд (как проверяет сервер). */
export const RATE_MONTHS_AHEAD = 12;

/** Значение ставки за месяц YYYY-MM; записей до него нет — null. */
export const rateValueOn = (values: ReadonlyArray<IPayrollRateValue>, month: string): string | null => {
  let found: string | null = null;
  for (const value of values) {
    if (value.effective_from > month) break;
    found = value.amount;
  }
  return found;
};

/** Запланированное значение — первое после текущего месяца; нет — null. */
export const nextRateValue = (
  values: ReadonlyArray<IPayrollRateValue>,
  currentMonth: string,
): IPayrollRateValue | null => values.find(value => value.effective_from > currentMonth) ?? null;

/** «2026-11» → «с ноября 2026»: месяц в родительном падеже — с какого месяца действует значение. */
export const rateFromLabel = (month: string): string => {
  const [year, mon] = month.split('-').map(Number);
  // «1 ноября» → «ноября»: родительный падеж даёт только формат с числом.
  const genitive = new Date(Date.UTC(year, mon - 1, 1))
    .toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' })
    .replace(/^\d+\s/, '');
  return `с ${genitive} ${year}`;
};

/** «С какого месяца» в правке ставки: текущий месяц и RATE_MONTHS_AHEAD следующих. */
export const rateMonthOptions = (currentMonth: string): Array<{ value: string; label: string }> => (
  Array.from({ length: RATE_MONTHS_AHEAD + 1 }, (_, index) => {
    const month = shiftMonth(currentMonth, index);
    return { value: month, label: rateFromLabel(month) };
  })
);

/**
 * Проезд сотрудника за месяц даты выборки: ставка «Проезд», кроме «Рабочих» и «Без проезда» в этом месяце.
 * category — выбранная в окне: смена категории сразу меняет показанный проезд.
 */
export const travelAllowance = (
  category: StaffCategory,
  row: Pick<IPayrollTermsRow, 'travel_rate' | 'travel_stopped'>,
): string | null => (category === 'worker' || row.travel_stopped ? null : row.travel_rate ?? null);
