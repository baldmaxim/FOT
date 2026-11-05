/** Подписи блока «Пересчёт» карточки «Зарплаты» (миграция 348). */
import type { IPayrollRecalcTerms } from '../services/payrollService';
import { formatPaidAmount } from './payrollPaid';

const money = (amount: string | null): string => (amount === null ? '—' : formatPaidAmount(Number(amount)));

const rate = (amount: string | null): string => (
  amount === null ? '—' : `${Number(amount).toLocaleString('ru-RU', { maximumFractionDigits: 4 })} ₽/ч`
);

const sameMoney = (a: string | null, b: string | null): boolean => Number(a ?? 0) === Number(b ?? 0);

const termsLabel = (terms: IPayrollRecalcTerms): string => (
  terms.calc_type === 'hourly' ? `ставка ${rate(terms.amount)}` : `оклад ${money(terms.amount)}`
);

/**
 * Что изменилось в месяце: «оклад 180 000,00 → 200 000,00», «ставка 500 ₽/ч → 600 ₽/ч», «премиальная 0,00 → 10 000,00»,
 * «оклад 180 000,00 → ставка 800 ₽/ч». Последние условия месяца совпали (менялись только дни внутри него) — без подписи.
 */
export const recalcTermsNotes = (
  from: IPayrollRecalcTerms | null,
  to: IPayrollRecalcTerms | null,
): string[] => {
  if (!from || !to) return [];
  if (from.calc_type !== to.calc_type) return [`${termsLabel(from)} → ${termsLabel(to)}`];
  const format = to.calc_type === 'hourly' ? rate : money;
  const name = to.calc_type === 'hourly' ? 'ставка' : 'оклад';
  return [
    ...(sameMoney(from.amount, to.amount) ? [] : [`${name} ${format(from.amount)} → ${format(to.amount)}`]),
    ...(sameMoney(from.bonus, to.bonus) ? [] : [`премиальная ${money(from.bonus ?? '0')} → ${money(to.bonus ?? '0')}`]),
  ];
};

/** Итог блока: плюс — к доплате, минус — переплата. */
export const recalcTotalView = (total: string): {
  label: string;
  amount: number;
  action: string;
  question: string;
} => {
  const value = Number(total);
  return value < 0
    ? { label: 'Переплата (с НДФЛ)', amount: -value, action: 'Учтено', question: 'Переплату учли?' }
    : { label: 'К доплате (с НДФЛ)', amount: value, action: 'Доплачено', question: 'Сотруднику доплатили?' };
};
