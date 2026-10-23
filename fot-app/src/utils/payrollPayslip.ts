/**
 * Расчётный листок месяца в «Истории выплат» — по подобию листка ЗУП: начислено и удержано по статьям.
 * Суммы — «Оплачено» из 1С; период, дни и оклад — из ФОТ (табель и условия оплаты). «По ставкам ФОТ» —
 * суммы за месяц по ставкам «Справочника» на тот месяц (миграция 324); проезд — пропорционально дням.
 */
import type {
  IPayslipRateAllowance,
  IPayslipTerms,
  PayrollPaidItemCode,
  PayslipRateAllowanceCode,
} from '../services/payrollService';
import { formatDate } from './formatMoney';
import { formatPaidAmount, PAYROLL_PAID_GROUPS, paidCellKey, type PayrollPaidTotalKind } from './payrollPaid';

/** Статья «По трудовому договору» — первая строка листка: с должностью, окладом, периодом и днями. */
export const PAYSLIP_MAIN_ITEM: PayrollPaidItemCode = 'contract';

export interface IPayslipLine {
  code: PayrollPaidItemCode;
  label: string;
  amount: number;
}

/** Статьи раздела за месяц — в порядке ведомости ЗУП, только с суммой; основная статья — отдельно, не здесь. */
export const payslipLines = (
  month: string,
  amounts: ReadonlyMap<string, number>,
  kind: PayrollPaidTotalKind,
): IPayslipLine[] => PAYROLL_PAID_GROUPS
  .filter(group => group.kind === kind)
  .flatMap(group => group.items)
  .filter(item => item.code !== PAYSLIP_MAIN_ITEM)
  .flatMap(item => {
    const amount = amounts.get(paidCellKey(month, item.code));
    return amount === undefined ? [] : [{ code: item.code, label: item.label, amount }];
  });

const RATE_ALLOWANCE_LABELS: Record<PayslipRateAllowanceCode, string> = {
  travel: 'Проезд',
  housing: 'Доплата за проживание',
  dormitory_allowance: 'Доплата за общежитие',
};

/**
 * «По ставкам ФОТ»: подпись и сумма; нет строк (или старый бэкенд) — пусто, секции нет. У проезда — дни,
 * из которых он посчитан: «22 из 23 дн.»; старый бэкенд дней не отдаёт — без подписи.
 */
export const payslipRateLines = (
  allowances: readonly IPayslipRateAllowance[] | undefined,
): Array<{ code: PayslipRateAllowanceCode; label: string; amount: number; note?: string }> => (allowances ?? [])
  .map(item => ({
    code: item.code,
    label: RATE_ALLOWANCE_LABELS[item.code],
    amount: Number(item.amount),
    ...(item.days ? { note: `${item.days.worked} из ${item.days.norm} дн.` } : {}),
  }))
  .filter(line => Number.isFinite(line.amount));

const formatTermsAmount = (terms: IPayslipTerms): string | null => {
  const value = terms.amount === null ? Number.NaN : Number(terms.amount);
  if (!Number.isFinite(value)) return null;
  return terms.calc_type === 'hourly' ? `${formatPaidAmount(value)} ₽/ч` : formatPaidAmount(value);
};

/**
 * Оклад или ставка месяца: «Оклад: 130 000,00», «Ставка: 500,00 ₽/ч». Сменились в месяце — каждая с границей:
 * «Оклад: 120 000,00 по 14.07.2026, Оклад: 130 000,00 с 15.07.2026». null — условий с суммой нет.
 */
export const formatPayslipTerms = (terms: readonly IPayslipTerms[]): string | null => {
  const parts = terms.flatMap((item, index) => {
    const amount = formatTermsAmount(item);
    if (amount === null) return [];
    const label = item.calc_type === 'hourly' ? 'Ставка' : 'Оклад';
    let bound = '';
    if (terms.length > 1) {
      bound = index === 0 && item.effective_to ? ` по ${formatDate(item.effective_to)}` : ` с ${formatDate(item.effective_from)}`;
    }
    return [`${label}: ${amount}${bound}`];
  });
  return parts.length > 0 ? parts.join(', ') : null;
};

/** Период двумя частями — «с 01.07.2026», «по 31.07.2026»: в узкой колонке каждая на своей строке. null — периода нет. */
export const payslipPeriodParts = (from: string | null, to: string | null): [string, string] | null => (
  from && to ? [`с ${formatDate(from)}`, `по ${formatDate(to)}`] : null
);
