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

export function summarizeMonthExpenses(
  usages: IStatementUsageEvent[],
  payments: IMtsPaymentEntry[],
): IMonthExpenseSummary {
  const buckets: Record<MtsExpenseCategory, IExpenseBucket> = {
    calls: empty(),
    sms: empty(),
    internet: empty(),
    periodic: empty(),
    oneTime: empty(),
    topups: empty(),
    other: empty(),
  };

  for (const u of usages) {
    const b = buckets[u.category] ?? buckets.other;
    b.count += 1;
    b.amount += u.amount;
  }

  for (const p of payments) {
    if (p.amount == null) continue;
    buckets.topups.count += 1;
    buckets.topups.amount += Math.abs(p.amount);
  }

  // total — сумма расходов (без пополнений).
  const total = (Object.keys(buckets) as MtsExpenseCategory[])
    .filter(k => k !== 'topups')
    .reduce((sum, k) => sum + buckets[k].amount, 0);

  return { ...buckets, total };
}
