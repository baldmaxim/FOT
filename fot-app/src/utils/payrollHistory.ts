import type { IPayrollTermsChange, IPlannedDeductionChange } from '../services/payrollService';

/** Запись общего журнала карточки: условия оплаты (оклад, плановая доплата) или плановое удержание (миграция 357). */
export type HistoryEntry =
  | { source: 'terms'; key: string; changedAt: number; change: IPayrollTermsChange }
  | { source: 'deduction'; key: string; changedAt: number; change: IPlannedDeductionChange };

/**
 * Условия и плановые удержания одним журналом, новые сверху. Плановые удержания — своим запросом: старый клиент
 * получил бы чужую запись в /changes и нарисовал бы её как оклад.
 */
export const mergeHistory = (
  terms: readonly IPayrollTermsChange[] | undefined,
  deductions: readonly IPlannedDeductionChange[] | undefined,
): HistoryEntry[] | undefined => {
  if (!terms || !deductions) return undefined;
  const entries: HistoryEntry[] = [
    ...terms.map((change, index): HistoryEntry => ({
      source: 'terms', key: `terms-${change.kind}-${index}`, changedAt: new Date(change.changed_at).getTime(), change,
    })),
    ...deductions.map((change): HistoryEntry => ({
      source: 'deduction', key: `deduction-${change.id}`, changedAt: new Date(change.changed_at).getTime(), change,
    })),
  ];
  // Сортировка устойчивая: при равном времени — порядок сервера.
  return entries.sort((a, b) => b.changedAt - a.changedAt);
};
