/**
 * Правила блока «Пересчёт» карточки «Зарплаты» (миграция 348): какой месяц и от каких прежних условий считать.
 *
 * Месяц попадает в запись, если он от месяца новой даты оклада до месяца перед днём правки и выплачен к дню правки:
 * следующие месяцы выплатят уже по новому окладу. Выплачен — ведомость окончательного расчёта с датой не позже правки
 * или статья «По трудовому договору» в 1С на день правки. Аванс выплатой не считается: остаток выплатят по новому окладу.
 *
 * Незакрытых записей на месяц может быть несколько: «Было» — от первой, у которой он выплачен (160 → 180 → 190 даёт
 * доплату от 160), «Стало» — всегда текущие условия. Счёт в целых копейках.
 */
import type { ICalcTermsRow } from './payroll-calc.rules.js';
import { lastDayOfMonth } from './payroll-payslip.rules.js';
import { centsToAmount, toCents } from './payroll-summary.attribution.js';

/** Способы выплаты 1С, которые закрывают месяц: окончательный расчёт сотрудника. */
export const RECALC_FINAL_PAYOUT_METHODS: readonly string[] = ['Зарплата за месяц', 'Увольнения'];

/** Незакрытая запись пересчёта. */
export interface IRecalcRecord {
  id: number;
  /** YYYY-MM-DD. */
  effective_from: string;
  /** День правки по Москве, YYYY-MM-DD. */
  changed_on: string;
  previous_terms: readonly ICalcTermsRow[];
  /** Месяцы YYYY-MM со статьёй «По трудовому договору» на момент правки. */
  paid_months_1c: readonly string[];
}

/** Новые условия из формы — для сравнения с прежними. */
export interface IRecalcNextTerms {
  calc_type: ICalcTermsRow['calc_type'];
  monthly_salary: number | null;
  hourly_rate: number | null;
  bonus_amount: number | null;
  proration_rounding: ICalcTermsRow['proration_rounding'];
}

/** Условия для подписи месяца «оклад было → стало». */
export interface IRecalcTermsNote {
  calc_type: ICalcTermsRow['calc_type'];
  /** Оклад или ставка, NUMERIC текстом. */
  amount: string | null;
  bonus: string | null;
}

export interface IRecalcMonth {
  /** YYYY-MM. */
  month: string;
  /** Итог месяца по прежним условиям; null — посчитать нельзя. */
  was: string | null;
  /** Итог месяца по текущим условиям; null — посчитать нельзя. */
  became: string | null;
  /** Стало минус было; null — одна из сумм неизвестна, в итог не идёт. */
  difference: string | null;
  terms_from: IRecalcTermsNote | null;
  terms_to: IRecalcTermsNote | null;
}

/** Месяц перед YYYY-MM. */
const previousMonth = (month: string): string => {
  const [year, mon] = month.split('-').map(Number);
  return mon === 1 ? `${year - 1}-12` : `${year}-${String(mon - 1).padStart(2, '0')}`;
};

/** Месяц после YYYY-MM. */
const nextMonth = (month: string): string => {
  const [year, mon] = month.split('-').map(Number);
  return mon === 12 ? `${year + 1}-01` : `${year}-${String(mon + 1).padStart(2, '0')}`;
};

/** Сумма в копейках; разные записи одной суммы ('180000', '180000.00') равны, пусто — ноль. */
const moneyCents = (value: string | number | null): number => (value === null ? 0 : Math.round(Number(value) * 100));

/** Ставка до 4 знаков в десятитысячных рубля. */
const rateUnits = (value: string | number | null): number => (value === null ? 0 : Math.round(Number(value) * 10_000));

/**
 * Правка задевает прошлое и что-то меняет: на периоде от новой даты есть прежние условия и хоть одна строка отличается
 * видом оплаты, суммами или округлением. Прежних условий нет (первое назначение) — сравнивать не с чем.
 */
export const termsChangedFrom = (
  history: readonly ICalcTermsRow[],
  effectiveFrom: string,
  next: IRecalcNextTerms,
): boolean => {
  const affected = history.filter(row => row.effective_to === null || row.effective_to >= effectiveFrom);
  return affected.some(row => (
    row.calc_type !== next.calc_type
    || moneyCents(row.monthly_salary) !== moneyCents(next.monthly_salary)
    || rateUnits(row.hourly_rate) !== rateUnits(next.hourly_rate)
    || moneyCents(row.bonus_amount) !== moneyCents(next.bonus_amount)
    || (row.proration_rounding ?? 'ruble') !== (next.proration_rounding ?? 'ruble')
  ));
};

/** Запись покрывает месяц: от месяца новой даты до месяца перед днём правки. */
const recordCovers = (record: IRecalcRecord, month: string): boolean => (
  month >= record.effective_from.slice(0, 7) && month <= previousMonth(record.changed_on.slice(0, 7))
);

/** Месяц выплачен к дню правки: ведомость окончательного расчёта не позже правки или статья 1С на момент правки. */
const recordSeesPaid = (
  record: IRecalcRecord,
  month: string,
  finalPayoutDates: ReadonlyMap<string, readonly string[]>,
): boolean => (
  record.paid_months_1c.includes(month)
  || (finalPayoutDates.get(month) ?? []).some(date => date <= record.changed_on)
);

/**
 * Месяцы блока, новые сверху, и запись, от которой считать «Было»: первая по порядку правок, которая покрывает месяц
 * и у которой он выплачен. Записи — в порядке создания.
 */
export const pickRecalcMonths = (
  records: readonly IRecalcRecord[],
  finalPayoutDates: ReadonlyMap<string, readonly string[]>,
): Array<{ month: string; record: IRecalcRecord }> => {
  if (records.length === 0) return [];
  const first = records.reduce((min, record) => (
    record.effective_from < min ? record.effective_from : min
  ), records[0].effective_from).slice(0, 7);
  const last = records.reduce((max, record) => {
    const to = previousMonth(record.changed_on.slice(0, 7));
    return to > max ? to : max;
  }, first);
  const picked: Array<{ month: string; record: IRecalcRecord }> = [];
  for (let month = first; month <= last; month = nextMonth(month)) {
    const record = records.find(item => recordCovers(item, month) && recordSeesPaid(item, month, finalPayoutDates));
    if (record) picked.unshift({ month, record });
  }
  return picked;
};

/** Строки условий, задевающие месяц: их и только их видит расчёт месяца. */
export const termsForMonth = (rows: readonly ICalcTermsRow[], month: string): ICalcTermsRow[] => {
  const start = `${month}-01`;
  const end = lastDayOfMonth(month);
  return rows.filter(row => row.effective_from <= end && (row.effective_to === null || row.effective_to >= start));
};

/** Последние в месяце условия — для подписи месяца. */
export const lastTermsNote = (rows: readonly ICalcTermsRow[]): IRecalcTermsNote | null => {
  const last = [...rows].sort((a, b) => a.effective_from.localeCompare(b.effective_from)).at(-1);
  if (!last) return null;
  return {
    calc_type: last.calc_type,
    amount: last.calc_type === 'hourly' ? last.hourly_rate : last.monthly_salary,
    bonus: last.bonus_amount,
  };
};

/** Строка месяца; разницы нет — null: строку не показываем. */
export const recalcMonthRow = (
  month: string,
  was: string | null,
  became: string | null,
  notes: { from: IRecalcTermsNote | null; to: IRecalcTermsNote | null },
): IRecalcMonth | null => {
  const difference = was === null || became === null ? null : toCents(became) - toCents(was);
  if (difference === 0) return null;
  return {
    month,
    was,
    became,
    difference: difference === null ? null : centsToAmount(difference),
    terms_from: notes.from,
    terms_to: notes.to,
  };
};

/** Итог блока: сумма известных разниц; минус — переплата. */
export const recalcTotal = (months: readonly IRecalcMonth[]): string => centsToAmount(
  months.reduce((sum, row) => sum + (row.difference === null ? 0 : toCents(row.difference)), 0),
);
