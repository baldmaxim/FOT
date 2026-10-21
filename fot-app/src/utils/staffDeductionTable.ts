import type { IStaffDeduction } from '../services/staffDeductionService';
import { formatMonthLabel } from './formatMoney';
import { moscowTodayIso } from './moscowDate';
import { formatPayrollMoney } from './payrollFormat';
import { buildExportTable, type IRegistryColumn, type ITableExportSnapshot } from './tableView';

/**
 * Таблица удержаний — вкладка «Удержания» «Управления кадрами» и «Удержания» «Справочника» «Зарплаты» (те же записи):
 * столбцы для экрана, сортировки, фильтров и выгрузки в xlsx (общие функции — в tableView.ts).
 */

const orDash = (value: string | null): string => value || '—';

/** Вид с подвидом: «Спецодежда — Каска»; без подвида — просто вид. */
export const staffDeductionKindLabel = (row: Pick<IStaffDeduction, 'kind_name' | 'subkind_name'>): string => (
  row.subkind_name ? `${row.kind_name} — ${row.subkind_name}` : row.kind_name
);

export const STAFF_DEDUCTION_COLUMNS: ReadonlyArray<IRegistryColumn<IStaffDeduction>> = [
  {
    key: 'full_name',
    label: 'ФИО',
    type: 'text',
    text: row => row.full_name,
    sortValue: row => row.full_name,
  },
  {
    key: 'department',
    label: 'Отдел',
    type: 'text',
    width: 140,
    text: row => orDash(row.department),
    sortValue: row => row.department,
  },
  {
    key: 'position',
    label: 'Должность',
    type: 'text',
    width: 148,
    text: row => orDash(row.position),
    sortValue: row => row.position,
  },
  {
    key: 'kind_name',
    label: 'Вид удержания',
    type: 'text',
    width: 200,
    text: staffDeductionKindLabel,
    sortValue: staffDeductionKindLabel,
  },
  {
    key: 'month',
    label: 'Месяц',
    type: 'text',
    width: 132,
    nowrap: true,
    text: row => formatMonthLabel(row.month),
    sortValue: row => row.month,
  },
  {
    key: 'amount',
    label: 'Сумма, ₽',
    type: 'money',
    width: 120,
    nowrap: true,
    numeric: true,
    text: row => formatPayrollMoney(row.amount) ?? '—',
    sortValue: row => Number(row.amount),
    exportValue: row => row.amount,
  },
];

/** Удержание в выбранных месяцах; пустой выбор — «Весь период». */
export const staffDeductionInMonths = (row: IStaffDeduction, months: ReadonlyArray<string>): boolean => (
  months.length === 0 || months.includes(row.month)
);

export const buildStaffDeductionExport = (rows: ReadonlyArray<IStaffDeduction>): ITableExportSnapshot => {
  const isoDate = moscowTodayIso();
  return buildExportTable({
    title: 'Удержания',
    subtitle: `Дата выгрузки: ${isoDate.split('-').reverse().join('.')}`,
    fileName: `Удержания_${isoDate}.xlsx`,
    columns: STAFF_DEDUCTION_COLUMNS,
    rows,
  });
};
