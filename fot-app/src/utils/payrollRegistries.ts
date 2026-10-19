import type {
  ICompensationStop,
  IDeductionRegistryRow,
  IHousingAllowanceRow,
  IPayrollSupplementRow,
} from '../services/payrollRegistryService';
import { formatDate, formatMonthLabel } from './formatMoney';
import { moscowTodayIso } from './moscowDate';
import { formatPayrollMoney } from './payrollFormat';
import { buildExportTable, type IRegistryColumn, type ITableExportSnapshot } from './tableView';

/**
 * Таблицы окна «Справочник» на «Расчётах»: столбцы для экрана, сортировки, фильтров и выгрузки в xlsx
 * (общие функции — в tableView.ts). Экран и xlsx строятся из одних описаний — разойтись не могут.
 */

interface IEmployeeRow {
  full_name: string;
  department: string | null;
  position: string | null;
}

const orDash = (value: string | null): string => value || '—';
const money = (value: string | null): string => formatPayrollMoney(value) ?? '—';
const moneySort = (value: string | null): number | null => (value === null ? null : Number(value));

/** ФИО, Отдел, Должность — первые три столбца каждой таблицы; ширины уже — где столбцов больше. */
const employeeColumns = <Row extends IEmployeeRow>(widths = { department: 140, position: 148 }): Array<IRegistryColumn<Row>> => [
  { key: 'full_name', label: 'ФИО', type: 'text', text: row => row.full_name, sortValue: row => row.full_name },
  {
    key: 'department', label: 'Отдел', type: 'text', width: widths.department,
    text: row => orDash(row.department), sortValue: row => row.department,
  },
  {
    key: 'position', label: 'Должность', type: 'text', width: widths.position,
    text: row => orDash(row.position), sortValue: row => row.position,
  },
];

const moneyColumn = <Row,>(label: string, value: (row: Row) => string | null, width = 128): IRegistryColumn<Row> => ({
  key: 'amount',
  label,
  type: 'money',
  width,
  nowrap: true,
  numeric: true,
  text: row => money(value(row)),
  sortValue: row => moneySort(value(row)),
  exportValue: row => value(row),
});

const dateColumn = <Row,>(key: string, label: string, value: (row: Row) => string | null, width = 112): IRegistryColumn<Row> => ({
  key,
  label,
  type: 'text',
  width,
  nowrap: true,
  text: row => formatDate(value(row)),
  sortValue: row => value(row),
});

export const HOUSING_COLUMNS: ReadonlyArray<IRegistryColumn<IHousingAllowanceRow>> = [
  ...employeeColumns<IHousingAllowanceRow>(),
  moneyColumn<IHousingAllowanceRow>('Сумма, ₽/мес', row => row.amount),
  // Заголовок одной строкой: «ДЕЙСТВУЕТ С» + стрелка и воронка.
  dateColumn<IHousingAllowanceRow>('effective_from', 'Действует с', row => row.effective_from, 160),
];

/** Период доплаты: плановая — «01.10.2026 – 31.12.2026», разовая — «октябрь 2026». */
export const supplementPeriod = (row: IPayrollSupplementRow): string => (
  row.kind === 'one_time'
    ? (row.month ? formatMonthLabel(row.month) : '—')
    : `${formatDate(row.date_from)} – ${formatDate(row.date_to)}`
);

export const SUPPLEMENT_KIND_LABELS: Record<IPayrollSupplementRow['kind'], string> = {
  planned: 'Плановая',
  one_time: 'Разовая',
};

/** Семь столбцов: отдел и должность уже — таблица без прокрутки влезает в окно на 1280px. */
export const SUPPLEMENT_COLUMNS: ReadonlyArray<IRegistryColumn<IPayrollSupplementRow>> = [
  ...employeeColumns<IPayrollSupplementRow>({ department: 112, position: 144 }),
  {
    key: 'kind', label: 'Вид', type: 'text', width: 92, nowrap: true,
    text: row => SUPPLEMENT_KIND_LABELS[row.kind], sortValue: row => SUPPLEMENT_KIND_LABELS[row.kind],
  },
  moneyColumn<IPayrollSupplementRow>('Сумма, ₽', row => row.amount, 112),
  {
    key: 'period', label: 'Период', type: 'text', width: 190, nowrap: true,
    text: supplementPeriod,
    // Разовая — с первого числа месяца: в одном порядке с плановыми.
    sortValue: row => (row.kind === 'one_time' ? (row.month ? `${row.month}-01` : null) : row.date_from),
  },
  {
    key: 'reason', label: 'Основание', type: 'text', width: 144,
    text: row => orDash(row.reason), sortValue: row => row.reason,
  },
];

export const COMPENSATION_STOP_COLUMNS: ReadonlyArray<IRegistryColumn<ICompensationStop>> = [
  ...employeeColumns<ICompensationStop>(),
  // Заголовок одной строкой: «НЕ ВЫПЛАЧИВАТЬ С» + стрелка и воронка.
  dateColumn<ICompensationStop>('date_from', 'Не выплачивать с', row => row.date_from, 196),
  {
    // Пусто — бессрочно: выплату ещё не возобновили.
    key: 'date_to', label: 'По', type: 'text', width: 112, nowrap: true,
    text: row => (row.date_to ? formatDate(row.date_to) : 'бессрочно'),
    sortValue: row => row.date_to,
  },
];

const NO_KINDS = '—';

export const DEDUCTION_COLUMNS: ReadonlyArray<IRegistryColumn<IDeductionRegistryRow>> = [
  ...employeeColumns<IDeductionRegistryRow>(),
  {
    key: 'kinds', label: 'Вид удержания', type: 'text', width: 220,
    text: row => (row.kinds.length > 0 ? row.kinds.join(', ') : NO_KINDS),
    sortValue: row => (row.kinds.length > 0 ? row.kinds.join(', ') : null),
    // Фильтр — по отдельным видам: «ТМЦ» находит и «ТМЦ, Питание».
    filterValues: row => (row.kinds.length > 0 ? row.kinds : [NO_KINDS]),
  },
  moneyColumn<IDeductionRegistryRow>('Сумма, ₽/мес', row => row.amount),
];

/** Снимок xlsx таблицы: «Название_2026-10-19.xlsx», подзаголовок — дата выгрузки. */
const buildSnapshot = <Row,>(title: string, columns: ReadonlyArray<IRegistryColumn<Row>>) =>
  (rows: ReadonlyArray<Row>): ITableExportSnapshot => {
    const isoDate = moscowTodayIso();
    return buildExportTable({
      title,
      subtitle: `Дата выгрузки: ${isoDate.split('-').reverse().join('.')}`,
      fileName: `${title.replace(/\s+/g, '_')}_${isoDate}.xlsx`,
      columns,
      rows,
    });
  };

export const buildHousingExport = buildSnapshot('Доплата за проживание', HOUSING_COLUMNS);
export const buildSupplementExport = buildSnapshot('Доплата', SUPPLEMENT_COLUMNS);
export const buildCompensationStopExport = buildSnapshot('Не выплачивать', COMPENSATION_STOP_COLUMNS);
export const buildDeductionExport = buildSnapshot('Удержания', DEDUCTION_COLUMNS);

/** Ключ строки «Доплаты»: у плановой — сотрудник (она одна), у разовой — её id. */
export const supplementRowKey = (row: IPayrollSupplementRow): string => (
  row.kind === 'planned' ? `planned-${row.employee_id}` : `once-${row.id}`
);
