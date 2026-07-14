import type { IStatementUsageEvent, MtsExpenseCategory } from './mts-business-cdr.service.js';
import type { IMtsPaymentEntry } from './mts-business-billing.service.js';

// Сводка расходов за месяц (карточка номера, §4). Чистая функция без сети/БД —
// группирует строки выписки (usages) и пополнения (payments) по категориям.
// Пополнения (topups) держим отдельным бакетом и НЕ нетим против расходов.

export interface IExpenseBucket {
  count: number;
  amount: number;
}

export type IMonthExpenseSummary = Record<MtsExpenseCategory, IExpenseBucket> & { total: number };

const empty = (): IExpenseBucket => ({ count: 0, amount: 0 });

const emptyBuckets = (): Record<MtsExpenseCategory, IExpenseBucket> => ({
  calls: empty(),
  sms: empty(),
  internet: empty(),
  periodic: empty(),
  oneTime: empty(),
  topups: empty(),
  other: empty(),
});

const addPayments = (buckets: Record<MtsExpenseCategory, IExpenseBucket>, payments: IMtsPaymentEntry[]): void => {
  for (const p of payments) {
    if (p.amount == null) continue;
    buckets.topups.count += 1;
    buckets.topups.amount += Math.abs(p.amount);
  }
};

/** total — сумма расходов (без пополнений). */
const withTotal = (buckets: Record<MtsExpenseCategory, IExpenseBucket>): IMonthExpenseSummary => {
  const total = (Object.keys(buckets) as MtsExpenseCategory[])
    .filter(k => k !== 'topups')
    .reduce((sum, k) => sum + buckets[k].amount, 0);
  return { ...buckets, total };
};

export function summarizeMonthExpenses(
  usages: IStatementUsageEvent[],
  payments: IMtsPaymentEntry[],
): IMonthExpenseSummary {
  const buckets = emptyBuckets();
  for (const u of usages) {
    const b = buckets[u.category] ?? buckets.other;
    b.count += 1;
    b.amount += u.amount;
  }
  addPayments(buckets, payments);
  return withTotal(buckets);
}

/**
 * Та же сводка, но из SQL-агрегата сохранённых строк выписки
 * (mts_business_statement_rows) — единый источник с «Использованием» и ЛК.
 */
export function expenseSummaryFromTotals(
  totals: Map<MtsExpenseCategory, { count: number; amount: number }>,
  payments: IMtsPaymentEntry[],
): IMonthExpenseSummary {
  const buckets = emptyBuckets();
  for (const [category, v] of totals) {
    const b = buckets[category] ?? buckets.other;
    b.count += v.count;
    b.amount += v.amount;
  }
  addPayments(buckets, payments);
  return withTotal(buckets);
}
