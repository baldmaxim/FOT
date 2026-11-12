import type {
  IPlannedDeduction,
  IPlannedDeductionMonth,
  IStaffDeduction,
} from '../services/staffDeductionService';
import { moscowTodayIso, shiftMonth } from './moscowDate';
import { formatPayrollMoney } from './payrollFormat';
import { staffDeductionColumns, staffDeductionKindLabel } from './staffDeductionTable';
import { buildExportTable, type IRegistryColumn, type ITableExportSnapshot } from './tableView';

/**
 * Плановые удержания (миграция 357) в окнах «Удержания» кадров и «Зарплаты»: вкладка «Плановые удержания» (периоды)
 * и «Удержания за месяц» (помесячные + плановые выбранных месяцев, столбец «Тип»). Экран и xlsx — из одних описаний.
 */

const orDash = (value: string | null): string => value || '—';

/** «2026-11» → «11.2026». */
export const monthNumeric = (month: string): string => {
  const [year, value] = month.split('-');
  return `${value}.${year}`;
};

/** Период планового: «11.2026 – 01.2027», бессрочно — «с 11.2026» (как «с 01.10.2026» у плановой доплаты). */
export const plannedDeductionPeriodLabel = (row: Pick<IPlannedDeduction, 'month_from' | 'month_to'>): string => (
  row.month_to === null
    ? `с ${monthNumeric(row.month_from)}`
    : `${monthNumeric(row.month_from)} – ${monthNumeric(row.month_to)}`
);

/**
 * «Плановые удержания». Ширины: столбец «Последний месяц» (миграция 362) взял место у отдела, должности, вида, суммы
 * и периода — сумма ширин прежняя, иначе на 1280px ✎ и 🗑 уходят за край таблицы.
 */
export const PLANNED_DEDUCTION_COLUMNS: ReadonlyArray<IRegistryColumn<IPlannedDeduction>> = [
  { key: 'full_name', label: 'ФИО', type: 'text', text: row => row.full_name, sortValue: row => row.full_name },
  {
    key: 'department', label: 'Отдел', type: 'text', width: 104,
    text: row => orDash(row.department), sortValue: row => row.department,
  },
  {
    key: 'position', label: 'Должность', type: 'text', width: 128,
    text: row => orDash(row.position), sortValue: row => row.position,
  },
  {
    key: 'kind_name', label: 'Вид удержания', type: 'text', width: 152,
    text: staffDeductionKindLabel, sortValue: staffDeductionKindLabel,
  },
  {
    key: 'amount', label: 'Сумма, ₽/мес', type: 'money', width: 120, nowrap: true, numeric: true,
    text: row => formatPayrollMoney(row.amount) ?? '—',
    sortValue: row => Number(row.amount),
    exportValue: row => row.amount,
  },
  {
    // Сумма в месяце «По» вместо ежемесячной; «—» — во всех месяцах одна.
    key: 'last_month_amount', label: 'Последний месяц, ₽', type: 'money', width: 136, nowrap: true, numeric: true,
    text: row => formatPayrollMoney(row.last_month_amount) ?? '—',
    sortValue: row => (row.last_month_amount === null ? null : Number(row.last_month_amount)),
    exportValue: row => row.last_month_amount,
  },
  {
    // «11.2026 – 01.2027» — 17 знаков; сортировка — по началу.
    key: 'period', label: 'Период', type: 'text', width: 156, nowrap: true,
    text: plannedDeductionPeriodLabel,
    sortValue: row => row.month_from,
  },
];

export type DeductionMonthSource = 'staff' | 'planned';

/**
 * Строка «Удержаний за месяц»: помесячное (staff) или плановое в одном из выбранных месяцев (planned). Ключ —
 * staff:<id> / planned:<id>:<месяц>: id двух таблиц могут совпасть, а одно плановое в нескольких месяцах — несколько строк.
 */
export interface IDeductionMonthRow {
  key: string;
  source: DeductionMonthSource;
  employee_id: number;
  full_name: string;
  department: string | null;
  position: string | null;
  kind_name: string;
  subkind_name: string | null;
  /** YYYY-MM. */
  month: string;
  amount: string;
  can_edit: boolean;
  staff?: IStaffDeduction;
  planned?: IPlannedDeductionMonth;
}

export const DEDUCTION_SOURCE_LABELS: Record<DeductionMonthSource, string> = {
  staff: 'Разовое',
  planned: 'Плановое',
};

/**
 * Помесячные и плановые в одну таблицу: ФИО, сотрудник, месяц, плановые первыми, порядок внутри — как пришли.
 * canEditStaff — право правки помесячной строки (в «Зарплате» — can_edit строки, у кадров — право вкладки).
 */
export const buildDeductionMonthRows = <Staff extends IStaffDeduction>(
  staff: ReadonlyArray<Staff> | undefined,
  planned: ReadonlyArray<IPlannedDeductionMonth> | undefined,
  canEditStaff: (row: Staff) => boolean,
): IDeductionMonthRow[] | undefined => {
  if (!staff || !planned) return undefined;
  const common = (row: IStaffDeduction | IPlannedDeductionMonth, amount: string) => ({
    employee_id: row.employee_id,
    full_name: row.full_name,
    department: row.department,
    position: row.position,
    kind_name: row.kind_name,
    subkind_name: row.subkind_name,
    month: row.month,
    amount,
  });
  // Плановые первыми: при равных ФИО, сотруднике и месяце порядок — как в списке. Сумма планового — этого месяца
  // (в последнем — своя, миграция 362), как в расчёте.
  const rows: IDeductionMonthRow[] = [
    ...planned.map(row => ({
      ...common(row, row.month_amount), key: `planned:${row.id}:${row.month}`, source: 'planned' as const,
      can_edit: row.can_edit, planned: row,
    })),
    ...staff.map(row => ({
      ...common(row, row.amount), key: `staff:${row.id}`, source: 'staff' as const, can_edit: canEditStaff(row),
      staff: row,
    })),
  ];
  const order = new Map(rows.map((row, index) => [row.key, index]));
  return rows.sort((a, b) => a.full_name.localeCompare(b.full_name, 'ru')
    || a.employee_id - b.employee_id
    || a.month.localeCompare(b.month)
    || order.get(a.key)! - order.get(b.key)!);
};

/**
 * Ширины «Удержаний за месяц»: столбец «Тип» добавил 100px — отдел, должность и вид уже (как в «Доплате за месяц»),
 * иначе на 1280px ✎ и 🗑 уходят за край таблицы.
 */
const MONTH_COLUMN_WIDTHS: Readonly<Record<string, number>> = { department: 112, position: 144, kind_name: 184 };

/** «Удержания за месяц»: столбцы кадров и «Тип» (Разовое / Плановое) после «Вида удержания». */
export const DEDUCTION_MONTH_COLUMNS: ReadonlyArray<IRegistryColumn<IDeductionMonthRow>> = (() => {
  const base = staffDeductionColumns<IDeductionMonthRow>()
    .map(column => ({ ...column, width: MONTH_COLUMN_WIDTHS[column.key] ?? column.width }));
  const kindIndex = base.findIndex(column => column.key === 'kind_name');
  const source: IRegistryColumn<IDeductionMonthRow> = {
    key: 'source', label: 'Тип', type: 'text', width: 100, nowrap: true,
    text: row => DEDUCTION_SOURCE_LABELS[row.source],
    sortValue: row => DEDUCTION_SOURCE_LABELS[row.source],
  };
  return [...base.slice(0, kindIndex + 1), source, ...base.slice(kindIndex + 1)];
})();

const snapshot = <Row,>(title: string, columns: ReadonlyArray<IRegistryColumn<Row>>) =>
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

export const buildDeductionMonthExport = snapshot('Удержания', DEDUCTION_MONTH_COLUMNS);
export const buildPlannedDeductionExport = snapshot('Плановые удержания', PLANNED_DEDUCTION_COLUMNS);

/**
 * Что сделает «Убрать» (то же правило — на сервере, plannedDeductionRemovalAction): начинается с текущего месяца или
 * позже либо кончилось до него — удалить; идёт — закрыть месяцем перед текущим (прошлые месяцы остаются).
 */
export const plannedDeductionRemoval = (
  row: Pick<IPlannedDeduction, 'month_from' | 'month_to'>,
  currentMonth: string,
): 'remove' | 'close' => (
  row.month_from >= currentMonth || (row.month_to !== null && row.month_to < currentMonth) ? 'remove' : 'close'
);

/** Вопрос перед «Убрать»: с какого месяца не удерживать или что строка удалится. */
export const plannedDeductionRemovalQuestion = (row: IPlannedDeduction, todayIso: string): string => {
  const currentMonth = todayIso.slice(0, 7);
  const subject = `${row.full_name}, ${staffDeductionKindLabel(row)}, ${plannedDeductionPeriodLabel(row)}`;
  return plannedDeductionRemoval(row, currentMonth) === 'remove'
    ? `Удалить плановое удержание: ${subject}?`
    : `Убрать плановое удержание с ${monthNumeric(currentMonth)}: ${subject}? По ${monthNumeric(shiftMonth(currentMonth, -1))} удержание останется.`;
};
