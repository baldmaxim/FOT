/**
 * Расчётный листок месяца во вкладке «Зарплата» карточки: статьи «Оплачено» (1С) месяца — для столбца «1С»
 * «Расчёта ФОТ»; «По ставкам ФОТ» — суммы за месяц по ставкам «Справочника» на тот месяц (миграция 324; старый
 * бэкенд без расчёта); графики месяца — справочно.
 */
import type {
  IPayslipRateAllowance,
  IPayslipSchedule,
  PayrollPaidItemCode,
  PayslipRateAllowanceCode,
} from '../services/payrollService';
import { formatPaidAmount, PAYROLL_PAID_GROUPS, paidCellKey, type PayrollPaidTotalKind } from './payrollPaid';

export interface IPayslipLine {
  code: PayrollPaidItemCode;
  label: string;
  amount: number;
}

/** Статьи раздела «Оплачено» (1С) за месяц — в порядке ведомости ЗУП, только с суммой. */
export const payslipLines = (
  month: string,
  amounts: ReadonlyMap<string, number>,
  kind: PayrollPaidTotalKind,
): IPayslipLine[] => PAYROLL_PAID_GROUPS
  .filter(group => group.kind === kind)
  .flatMap(group => group.items)
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
 * из которых он посчитан: «22 из 23 дн.»; у проживания — «630,00 × 9 дн.» (без ставки — «9 дн.»); старый бэкенд
 * дней не отдаёт — без подписи.
 */
export const payslipRateLines = (
  allowances: readonly IPayslipRateAllowance[] | undefined,
): Array<{ code: PayslipRateAllowanceCode; label: string; amount: number; note?: string }> => (allowances ?? [])
  .map(item => ({
    code: item.code,
    label: RATE_ALLOWANCE_LABELS[item.code],
    amount: Number(item.amount),
    ...(item.days ? { note: `${item.days.worked} из ${item.days.norm} дн.` } : {}),
    ...(item.housing_days !== undefined
      ? { note: item.rate ? `${formatPaidAmount(Number(item.rate))} × ${item.housing_days} дн.` : `${item.housing_days} дн.` }
      : {}),
  }))
  .filter(line => Number.isFinite(line.amount));

/**
 * «Графики месяца: «5+2 (Линия С/О)»» — справочно, под «Расчётом ФОТ»; графиков несколько — с датами:
 * «Пятидневка» с 01.09 по 09.09, «6+0 (11 ч)» с 10.09 по 30.09. Нет (старый бэкенд) — null.
 */
export const formatPayslipSchedules = (schedules: readonly IPayslipSchedule[] | undefined): string | null => {
  if (!schedules || schedules.length === 0) return null;
  const dayMonth = (iso: string): string => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
  const items = schedules.length === 1
    ? [`«${schedules[0].name}»`]
    : schedules.map(item => `«${item.name}» с ${dayMonth(item.from)} по ${dayMonth(item.to)}`);
  return `${schedules.length === 1 ? 'График месяца' : 'Графики месяца'}: ${items.join(', ')}`;
};
