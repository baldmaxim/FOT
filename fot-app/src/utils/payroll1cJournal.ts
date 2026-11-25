/**
 * Ведомости выплаты 1С на экране: журнал «Ведомости 1С», состав ведомости и окно ведомостей сотрудника из ячейки
 * «Выплаты на карту (1С)». Деньги складываются в копейках.
 */
import type {
  IEmployeePayout1c,
  IPayoutJournalLine,
  IPayoutJournalListDoc,
  PayoutOrigin,
  PayoutResolution,
} from '../services/payroll1cPayoutsService';
import type { PayrollPaidMonths } from '../services/payrollService';
import { formatAccrualMonthLabel } from './payrollAccruals';
import { formatDate } from './formatMoney';
import { formatPaidAmount } from './payrollPaid';
import type { IRegistryColumn } from './tableView';

export const PAYOUT_ORIGIN_LABELS: Readonly<Record<PayoutOrigin, string>> = {
  api: 'API 1С',
  file: 'Файл 1С',
  register: 'Регистр ЗУП',
  generator: 'Загрузка ФОТ',
  brigade_sheet: 'Ведомость бригады',
  to_pay: 'ЗП к выплате (ЗУП2)',
};

const ORGANIZATIONS: Readonly<Record<string, string>> = { '7736255508': 'СУ-10', '7705794997': 'СМ' };
export const payoutOrganizationLabel = (inn: string): string => ORGANIZATIONS[inn] ?? inn;

export const PAYOUT_RESOLUTION_LABELS: Readonly<Record<PayoutResolution, string>> = {
  auto_id_fot: 'По ID_FOT',
  auto_id_all: 'По коду физлица 1С',
  confirmed: 'По ФИО',
  unmatched: 'Без сотрудника',
};

export const PAYOUT_STATE_LABELS = { active: 'Действует', cancelled: 'Отменена в 1С' } as const;
const TOTAL_LABEL = 'Итого';

const toCents = (amount: string): number => Math.round(Number(amount) * 100);
const money = (amount: string): string => formatPaidAmount(Number(amount));
const centsText = (cents: number): string => (cents / 100).toFixed(2);
const monthLabel = (month: string): string => formatAccrualMonthLabel(month, true);

export const isCancelledPayout = (doc: IPayoutJournalListDoc): boolean => doc.state === 'cancelled';

/** Столбцы журнала: как журнал ведомостей 1С. «Сумма» — по документу 1С; отменённые — с отметкой «Состояние». */
export const PAYOUT_JOURNAL_COLUMNS: ReadonlyArray<IRegistryColumn<IPayoutJournalListDoc>> = [
  { key: 'doc_date', label: 'Дата', type: 'text', width: 100, nowrap: true,
    text: doc => formatDate(doc.doc_date), sortValue: doc => doc.doc_date },
  { key: 'doc_number', label: 'Номер', type: 'text', width: 120, nowrap: true,
    text: doc => doc.doc_number, sortValue: doc => doc.doc_number },
  { key: 'organization', label: 'Организация', type: 'text', width: 160, nowrap: true,
    text: doc => payoutOrganizationLabel(doc.organization_inn), sortValue: doc => payoutOrganizationLabel(doc.organization_inn) },
  { key: 'period_month', label: 'Период', type: 'text', width: 140, nowrap: true,
    text: doc => monthLabel(doc.period_month), sortValue: doc => doc.period_month },
  { key: 'payment_method', label: 'Вид', type: 'text', width: 170,
    text: doc => doc.payment_method, sortValue: doc => doc.payment_method },
  { key: 'total_amount', label: 'Сумма', type: 'money', width: 130, nowrap: true, numeric: true,
    text: doc => money(doc.total_amount), sortValue: doc => toCents(doc.total_amount), exportValue: doc => doc.total_amount },
  { key: 'employees', label: 'Сотрудников', type: 'int', width: 160, nowrap: true, numeric: true,
    text: doc => String(doc.employees), sortValue: doc => doc.employees, exportValue: doc => doc.employees },
  { key: 'unmatched', label: 'Без сотрудника', type: 'money', width: 180, nowrap: true, numeric: true,
    title: 'Строки ведомости, которые не привязаны к сотруднику ФОТ: их суммы нет в «Выплатах на карту»',
    text: doc => (doc.unmatched_lines === 0 ? '—' : money(doc.unmatched_amount)),
    sortValue: doc => (doc.unmatched_lines === 0 ? null : toCents(doc.unmatched_amount)),
    exportValue: doc => (doc.unmatched_lines === 0 ? null : doc.unmatched_amount) },
  { key: 'comment', label: 'Комментарий', type: 'text',
    text: doc => doc.comment ?? '—', sortValue: doc => doc.comment },
  { key: 'origin', label: 'Откуда', type: 'text', width: 170, nowrap: true,
    text: doc => PAYOUT_ORIGIN_LABELS[doc.origin] ?? doc.origin, sortValue: doc => PAYOUT_ORIGIN_LABELS[doc.origin] ?? doc.origin },
  { key: 'state', label: 'Состояние', type: 'text', width: 160, nowrap: true,
    title: 'Отменена в 1С — ведомость распровели или удалили: её суммы не учитываются',
    text: doc => PAYOUT_STATE_LABELS[doc.state], sortValue: doc => PAYOUT_STATE_LABELS[doc.state] },
];

/** «Итого» журнала: только действующие ведомости — суммы отменённых в «Выплатах на карту» не участвуют. */
export const payoutJournalTotals = (docs: ReadonlyArray<IPayoutJournalListDoc>) => {
  const active = docs.filter(doc => !isCancelledPayout(doc));
  if (active.length === 0) return null;
  const total = centsText(active.reduce((sum, doc) => sum + toCents(doc.total_amount), 0));
  const unmatched = centsText(active.reduce((sum, doc) => sum + toCents(doc.unmatched_amount), 0));
  return {
    display: { doc_date: TOTAL_LABEL, total_amount: money(total), unmatched: Number(unmatched) === 0 ? '—' : money(unmatched) },
    export: { doc_date: TOTAL_LABEL, total_amount: total, unmatched: Number(unmatched) === 0 ? null : unmatched },
  };
};

/** Поиск журнала: номер ведомости и ФИО её строк. */
export const payoutJournalSearchText = (doc: IPayoutJournalListDoc): string => (
  [doc.doc_number, doc.zup2_number, doc.names].filter(Boolean).join(' · ')
);

/** Столбцы состава ведомости. */
export const PAYOUT_LINE_COLUMNS: ReadonlyArray<IRegistryColumn<IPayoutJournalLine>> = [
  { key: 'full_name_1c', label: 'ФИО в 1С', type: 'text',
    text: line => line.full_name_1c, sortValue: line => line.full_name_1c },
  { key: 'employee_name', label: 'Сотрудник ФОТ', type: 'text', width: 220,
    text: line => line.employee_name ?? '—', sortValue: line => line.employee_name },
  { key: 'month', label: 'Месяц', type: 'text', width: 130, nowrap: true,
    text: line => monthLabel(line.month), sortValue: line => line.month },
  { key: 'amount', label: 'Сумма', type: 'money', width: 130, nowrap: true, numeric: true,
    text: line => money(line.amount), sortValue: line => toCents(line.amount), exportValue: line => line.amount },
  { key: 'basis', label: 'Основание', type: 'text', width: 220,
    text: line => line.basis ?? '—', sortValue: line => line.basis },
  { key: 'resolution', label: 'Как найден', type: 'text', width: 170, nowrap: true,
    title: 'Как строка 1С привязана к сотруднику ФОТ',
    text: line => PAYOUT_RESOLUTION_LABELS[line.resolution] ?? line.resolution,
    sortValue: line => PAYOUT_RESOLUTION_LABELS[line.resolution] ?? line.resolution },
];

export const payoutLinesTotals = (lines: ReadonlyArray<IPayoutJournalLine>) => {
  if (lines.length === 0) return null;
  const total = centsText(lines.reduce((sum, line) => sum + toCents(line.amount), 0));
  return { display: { full_name_1c: TOTAL_LABEL, amount: money(total) }, export: { full_name_1c: TOTAL_LABEL, amount: total } };
};

/** Период запроса ведомостей сотрудника: первый и последний месяц; «весь период» — без границ. */
export const payoutMonthsRange = (months: PayrollPaidMonths): { from: string; to: string } => {
  if (months === 'all' || months.length === 0) return { from: '2000-01', to: '2099-12' };
  const sorted = [...months].sort();
  return { from: sorted[0], to: sorted[sorted.length - 1] };
};

export interface IEmployeePayoutMonth {
  month: string;
  documents: IEmployeePayout1c[];
  totalCents: number;
}

/**
 * Ведомости сотрудника за месяцы таблицы, по месяцам начисления (по возрастанию): только выбранные месяцы — в запросе
 * диапазон, между ними могут быть невыбранные. Итог — как «Выплаты на карту (1С)» ячейки.
 */
export const employeePayoutMonths = (
  rows: ReadonlyArray<IEmployeePayout1c>,
  months: PayrollPaidMonths,
): { months: IEmployeePayoutMonth[]; totalCents: number } => {
  const selected = months === 'all' || months.length === 0 ? null : new Set(months);
  const byMonth = new Map<string, IEmployeePayoutMonth>();
  for (const row of rows) {
    if (selected && !selected.has(row.month)) continue;
    const entry = byMonth.get(row.month) ?? { month: row.month, documents: [], totalCents: 0 };
    entry.documents.push(row);
    entry.totalCents += toCents(row.amount);
    byMonth.set(row.month, entry);
  }
  const list = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
  return { months: list, totalCents: list.reduce((sum, entry) => sum + entry.totalCents, 0) };
};
