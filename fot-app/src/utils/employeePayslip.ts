import type { IEmployeePayslipLine, IEmployeePayslipPayout } from '../services/employeePayslipService';
import { pluralDays } from './dateCompact';
import { formatDateShort } from './formatMoney';
import { PAYROLL_PAID_GROUPS } from './payrollPaid';

/** Подписи статей — те же, что в карточке «Зарплаты»; доля бригады — своя. */
const ITEM_LABELS = new Map<string, string>(
  PAYROLL_PAID_GROUPS.flatMap(group => group.items.map(item => [item.code as string, item.label] as const)),
);

/** Подпись строки листка: готовая с сервера (вид удержания) или по коду статьи. */
export const payslipLineLabel = (line: Pick<IEmployeePayslipLine, 'code' | 'name'>): string => {
  if (line.name) return line.name;
  if (line.code === 'brigade') return 'Выработка бригады';
  return (line.code && ITEM_LABELS.get(line.code)) ?? line.code ?? '';
};

/** «182730.00» → «182 730,00». */
export const formatPayslipAmount = (amount: string): string => Number(amount).toLocaleString('ru-RU', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Оклад/ставка без копеек, если их нет: «180 000», «730,5». */
export const formatPayslipRate = (amount: string): string => Number(amount).toLocaleString('ru-RU', {
  maximumFractionDigits: 4,
});

/** «16.31» → «16,31»; «16.00» → «16». */
export const formatVacationDays = (days: string): string => Number(days).toLocaleString('ru-RU', {
  maximumFractionDigits: 2,
});

/** «Начислено за 21 день». */
export const accruedTitle = (worked: { workday: number; dayoff: number } | null): string => {
  if (!worked) return 'Начислено';
  const total = worked.workday + worked.dayoff;
  return `Начислено за ${total} ${pluralDays(total)}`;
};

/** «Аванс от 05.10.26»; при двух ведомостях одного вида в один день — с номером документа. */
export const payoutLabel = (payout: IEmployeePayslipPayout, all: readonly IEmployeePayslipPayout[]): string => {
  const base = `${payout.payment_method} от ${formatDateShort(payout.doc_date)}`;
  const twins = all.filter(item => item.payment_method === payout.payment_method && item.doc_date === payout.doc_date);
  return twins.length > 1 ? `${base}, № ${payout.doc_number}` : base;
};
