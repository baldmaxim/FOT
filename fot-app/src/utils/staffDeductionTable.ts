import type { IStaffDeduction } from '../services/staffDeductionService';
import { formatMonthLabel } from './formatMoney';
import { moscowTodayIso } from './moscowDate';
import { formatPayrollMoney } from './payrollFormat';
import { buildExportTable, type IRegistryColumn, type ITableExportSnapshot } from './tableView';

/**
 * Таблица удержаний — вкладка «Удержания» «Управления кадрами» и «Удержания» «Справочника» «Зарплаты» (те же записи):
 * столбцы для экрана, сортировки, фильтров и выгрузки в xlsx (общие функции — в tableView.ts). «Место» и «Дата
 * нарушения» (миграция 383) — у вида «Нарушение техники безопасности», у остальных «—».
 */

const orDash = (value: string | null): string => value || '—';

/** Вид с подвидом: «Спецодежда — Каска»; без подвида — просто вид. */
export const staffDeductionKindLabel = (row: Pick<IStaffDeduction, 'kind_name' | 'subkind_name'>): string => (
  row.subkind_name ? `${row.kind_name} — ${row.subkind_name}` : row.kind_name
);

/** Что показывают столбцы удержания: и помесячное, и строка «Удержаний за месяц» с плановыми (миграция 357). */
type StaffDeductionCells = Pick<
  IStaffDeduction,
  | 'full_name' | 'department' | 'position' | 'kind_name' | 'subkind_name' | 'month' | 'amount'
  | 'violation_object_name' | 'violation_place' | 'violation_date'
>;

/** Место нарушения (миграция 383): «ЖК Сад 69, корпус 2»; только уточнение — оно; ничего — пусто. */
export const violationPlaceLabel = (row: Pick<StaffDeductionCells, 'violation_object_name' | 'violation_place'>): string => (
  [row.violation_object_name, row.violation_place].filter(Boolean).join(', ')
);

/** «2026-11-25» → «25.11.2026». */
const isoToDotted = (iso: string): string => iso.split('-').reverse().join('.');

export const staffDeductionColumns = <Row extends StaffDeductionCells>(): Array<IRegistryColumn<Row>> => [
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
    key: 'violation_place',
    label: 'Место',
    type: 'text',
    width: 168,
    text: row => violationPlaceLabel(row) || '—',
    sortValue: row => violationPlaceLabel(row) || null,
  },
  {
    key: 'violation_date',
    label: 'Дата нарушения',
    type: 'text',
    width: 112,
    nowrap: true,
    text: row => (row.violation_date ? isoToDotted(row.violation_date) : '—'),
    sortValue: row => row.violation_date ?? null,
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

export const STAFF_DEDUCTION_COLUMNS: ReadonlyArray<IRegistryColumn<IStaffDeduction>> = staffDeductionColumns<IStaffDeduction>();

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
