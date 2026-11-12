/**
 * «Экспорт» вкладки «Расчёты»: xlsx всей выборки экрана. Столбцы и суммы — из тех же функций, что и экран, но по всем
 * строкам выборки, а не только по загруженным. Суммы — NUMERIC-строками, сервер превращает их в числа Excel; что на
 * экране подпись («—», «выработка не внесена», почасовая ставка) — текстом, такие ячейки не попадают в сумму столбца.
 *
 * Отличия от экрана, потому что в ячейке Excel одно значение: «Выплаты на карту» — итог и столбцы по видам выплаты,
 * подсказка ⚠ — столбец «Примечание», подписи под суммами («квартира», «2 вых. · 6 ч») не выгружаются.
 */
import {
  CONTRACT_TYPE_LABELS,
  type IPayrollColumnFilters,
  type IPayrollTermsRow,
  type PayrollPaidMonths,
} from '../services/payrollService';
import { moscowTodayIso } from './moscowDate';
import {
  calcBrigadeOutputSub,
  calcIssuesNote,
  calcSumAmount,
  cardPayoutLines,
  emptyPayrollColumns,
  formatCalcRate,
  isCalcColumn,
  isCalcSumColumn,
  sumAmounts,
  type PayrollCalcAmountColumn,
} from './payrollCalcColumns';
import {
  isPayrollGphRow,
  normalizePayrollColumnFilters,
  PAYROLL_FILTER_COLUMN_LABELS,
  PAYROLL_VALUE_FILTER_COLUMNS,
} from './payrollColumnFilters';
import type { PayrollTableColumn, PayrollTableColumns } from './payrollColumns';
import { formatPaidPeriod } from './payrollPaid';
import {
  isExpandablePayrollColumn,
  payrollSubColumns,
  payrollTableColumnList,
  subColumnAmount,
  type PayrollExpandableColumn,
  type PayrollSubColumn,
  type PayrollTableColumnEntry,
} from './payrollSubColumns';
import { buildExportTable, type ITableColumn, type ITableExportSnapshot, type TableExportColumnType } from './tableView';

type ExportColumn = ITableColumn<IPayrollTermsRow>;

/** Лимиты снимка на сервере (table-snapshot-export.ts). */
const MAX_LABEL_LENGTH = 60;
const MAX_SUBTITLE_LENGTH = 300;
/** Имя файла на сервере — до 150 символов, остальное в нём короткое. */
const MAX_FILE_PERIOD_LENGTH = 100;

const NO_VALUE = '—';

/** Столбцы, где вместо суммы экран подписывает «выработка не внесена». */
const OUTPUT_NOTE_COLUMNS: ReadonlySet<PayrollCalcAmountColumn> = new Set<PayrollCalcAmountColumn>([
  'calc_timesheet', 'calc_net', 'calc_remainder',
]);

/** Префикс подстолбца: названия статей 1С и видов ФОТ могут совпасть, а в шапке Excel нет скобки группы над ними. */
const SUB_LABEL_PREFIX: Partial<Record<PayrollExpandableColumn, string>> = {
  deductions: 'Удержания (1С): ',
  calc_deductions: 'Удержания (ФОТ): ',
};

const CARD_PAYOUT_PREFIX = 'На карту: ';

const exportColumn = (
  key: string,
  label: string,
  type: TableExportColumnType,
  text: (row: IPayrollTermsRow) => string,
): ExportColumn => ({ key, label, type, text, sortValue: () => null });

/** Сумма или подпись вместо неё: «выработка не внесена», иначе «—». */
const calcCellText = (row: IPayrollTermsRow, column: PayrollCalcAmountColumn): string => (
  calcSumAmount(row, column)
  ?? (OUTPUT_NOTE_COLUMNS.has(column) ? calcBrigadeOutputSub(row.calc) : null)
  ?? NO_VALUE
);

/** Оклад — числом; почасовая ставка — текстом с «₽/ч», как на экране: складывать её с окладами нельзя. */
const rateCellText = (row: IPayrollTermsRow): string => {
  const rate = row.calc?.rate ?? null;
  return rate?.calc_type === 'salary' ? rate.amount : formatCalcRate(rate);
};

/** Итог и столбцы по видам выплаты, которые есть в выборке, — в порядке ячейки экрана. */
const cardPayoutColumns = (rows: readonly IPayrollTermsRow[], label: string): ExportColumn[] => {
  const methods = new Set(rows.flatMap(row => cardPayoutLines(row.card_payouts_by_method).map(line => line.method)));
  const ordered = cardPayoutLines([...methods].map(method => ({ method, amount: '0.00' })));
  const amountOf = (row: IPayrollTermsRow, method?: string): string => sumAmounts(
    cardPayoutLines(row.card_payouts_by_method)
      .filter(line => method === undefined || line.method === method)
      .map(line => line.amount),
  ) ?? NO_VALUE;
  return [
    exportColumn('card_payouts', label, 'money', row => amountOf(row)),
    ...ordered.map(({ method, label: methodLabel }) => (
      exportColumn(`card_payouts:${method}`, `${CARD_PAYOUT_PREFIX}${methodLabel}`, 'money', row => amountOf(row, method))
    )),
  ];
};

const subColumnExport = (key: string, parent: PayrollExpandableColumn, sub: PayrollSubColumn): ExportColumn => (
  exportColumn(key, `${SUB_LABEL_PREFIX[parent] ?? ''}${sub.label}`, 'money', row => (
    sub.type === 'column' ? calcCellText(row, sub.column) : subColumnAmount(row, sub) ?? NO_VALUE
  ))
);

const entryColumns = (entry: PayrollTableColumnEntry, rows: readonly IPayrollTermsRow[]): ExportColumn[] => {
  if (entry.kind === 'sub') return [subColumnExport(entry.key, entry.parent, entry.sub)];
  const { key, column: { label } } = entry;
  switch (key) {
    case 'department': return [exportColumn(key, label, 'text', row => row.department_name ?? NO_VALUE)];
    case 'position': return [exportColumn(key, label, 'text', row => row.position_name ?? NO_VALUE)];
    case 'schedule': return [exportColumn(key, label, 'text', row => row.schedule_name ?? NO_VALUE)];
    case 'calc_rate': return [exportColumn(key, label, 'money', rateCellText)];
    case 'deductions': return [exportColumn(key, label, 'money', row => row.paid_deductions_total ?? NO_VALUE)];
    case 'paid_recalc': return [exportColumn(key, label, 'money', row => row.paid_recalc_prev ?? NO_VALUE)];
    case 'fss_payments': return [exportColumn(key, label, 'money', row => row.fss_payments ?? NO_VALUE)];
    case 'card_payouts': return cardPayoutColumns(rows, label);
    default:
      if (key !== 'calc_remainder' && !isCalcSumColumn(key)) return [];
      return [exportColumn(key, label, 'money', row => calcCellText(row, key))];
  }
};

/**
 * Что на экране только в подсказке ⚠. «Выработка не внесена» — только у частичной суммы (несколько месяцев, не в каждом
 * есть выработка): без суммы эта подпись и так стоит в ячейке.
 */
const rowNote = (row: IPayrollTermsRow): string | null => {
  const output = calcSumAmount(row, 'calc_timesheet') === null ? null : calcBrigadeOutputSub(row.calc);
  return [calcIssuesNote(row.calc), output].filter(Boolean).join('; ') || null;
};

const isCalcEntry = (entry: PayrollTableColumnEntry): boolean => (
  entry.kind === 'sub' ? entry.sub.type !== 'paid' : isCalcColumn(entry.key)
);

/** Договор, как подпись под ФИО на экране (миграция 352): ГПХ — «ГПХ», трудовой — пусто. */
const contractCellText = (row: IPayrollTermsRow): string => (
  isPayrollGphRow(row) ? CONTRACT_TYPE_LABELS.gph : ''
);

/** Подписи шапки: в умной таблице Excel они уникальны без учёта регистра и не длиннее лимита сервера. */
const withUniqueLabels = (columns: readonly ExportColumn[]): ExportColumn[] => {
  const used = new Set<string>();
  return columns.map(column => {
    const base = column.label.trim().slice(0, MAX_LABEL_LENGTH).trim();
    let label = base;
    for (let copy = 2; used.has(label.toLocaleLowerCase('ru')); copy += 1) {
      const suffix = ` (${copy})`;
      label = `${base.slice(0, MAX_LABEL_LENGTH - suffix.length).trim()}${suffix}`;
    }
    used.add(label.toLocaleLowerCase('ru'));
    return { ...column, label };
  });
};

/**
 * Столбцы файла: «Сотрудник», «Договор» (если в выборке есть ГПХ), видимые столбцы экрана (без скрытых шестерёнкой
 * и пустых во всей выборке), за раскрытыми «+» — их подстолбцы; «Примечание» — если в выборке есть подсказки ⚠.
 */
export const payrollCalcExportColumns = (params: {
  rows: readonly IPayrollTermsRow[];
  columns: PayrollTableColumns;
  hidden: ReadonlySet<PayrollTableColumn>;
  expanded: ReadonlySet<PayrollExpandableColumn>;
}): ExportColumn[] => {
  const { rows, columns, hidden, expanded } = params;
  const empty = emptyPayrollColumns(rows, columns);
  const subColumns = new Map<PayrollExpandableColumn, PayrollSubColumn[]>();
  for (const { key } of columns) {
    if (isExpandablePayrollColumn(key)) subColumns.set(key, payrollSubColumns(rows, key));
  }
  const entries = payrollTableColumnList(
    columns.filter(({ key }) => !hidden.has(key) && !empty.has(key)),
    expanded,
    subColumns,
  );
  const withContract = rows.some(isPayrollGphRow);
  const withNote = entries.some(isCalcEntry) && rows.some(row => rowNote(row) !== null);
  return withUniqueLabels([
    exportColumn('name', PAYROLL_FILTER_COLUMN_LABELS.name, 'text', row => row.full_name ?? NO_VALUE),
    ...(withContract ? [exportColumn('contract', 'Договор', 'text', contractCellText)] : []),
    ...entries.flatMap(entry => entryColumns(entry, rows)),
    ...(withNote ? [exportColumn('note', 'Примечание', 'text', row => rowNote(row) ?? '')] : []),
  ]);
};

/** Фильтры столбцов текстом: «Должность: Монтажник, Маляр; Сотрудник: Иванов»; нет — ''. */
export const describePayrollColumnFilters = (filters: IPayrollColumnFilters): string => {
  const { values, text, contract } = normalizePayrollColumnFilters(filters);
  return [
    ...(text?.name ? [`${PAYROLL_FILTER_COLUMN_LABELS.name}: ${text.name}`] : []),
    ...(contract ? [`Договор: ${CONTRACT_TYPE_LABELS[contract]}`] : []),
    ...PAYROLL_VALUE_FILTER_COLUMNS.flatMap(column => {
      const selected = values?.[column];
      return selected
        ? [`${PAYROLL_FILTER_COLUMN_LABELS[column]}: ${selected.map(value => value ?? '(пусто)').join(', ')}`]
        : [];
    }),
  ].join('; ');
};

const clipText = (text: string, maxLength: number): string => (
  text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}…`
);

export interface IPayrollCalcExportParams {
  rows: readonly IPayrollTermsRow[];
  columns: PayrollTableColumns;
  hidden: ReadonlySet<PayrollTableColumn>;
  expanded: ReadonlySet<PayrollExpandableColumn>;
  months: PayrollPaidMonths;
  /** Название выбранного отдела или бригады; null — «Все отделы». */
  departmentName: string | null;
  /** «Категория» и «Объект» месяца (как в «Своде»); null или нет — «Все». */
  categoryLabel?: string | null;
  objectName?: string | null;
  /** Поиск по ФИО, как он применён к строкам. */
  search: string;
  filters: IPayrollColumnFilters;
  /** Фильтры столбцов сумм (на экране, payrollCalcView.ts) текстом; нет — ''. */
  amountFilters?: string;
}

/** Снимок для xlsx: над таблицей — период, отдел, поиск, фильтры столбцов и дата выгрузки. */
export const buildPayrollCalcExport = (params: IPayrollCalcExportParams): ITableExportSnapshot => {
  const isoDate = moscowTodayIso();
  const period = formatPaidPeriod(params.months);
  const filtersText = [describePayrollColumnFilters(params.filters), params.amountFilters ?? ''].filter(Boolean).join('; ');
  const conditions = [
    `Период: ${period}`,
    `Отдел: ${params.departmentName ?? 'все отделы'}`,
    ...(params.categoryLabel ? [`Категория: ${params.categoryLabel}`] : []),
    ...(params.objectName ? [`Объект: ${params.objectName}`] : []),
    ...(params.search ? [`Поиск: «${params.search}»`] : []),
    ...(filtersText ? [`Фильтры: ${filtersText}`] : []),
  ].join('. ');
  // Дата — последней и всегда: обрезается только длинный список условий.
  const dateSuffix = `. Дата выгрузки: ${isoDate.split('-').reverse().join('.')}`;
  return buildExportTable({
    title: 'Расчёты',
    subtitle: `${clipText(conditions, MAX_SUBTITLE_LENGTH - dateSuffix.length)}${dateSuffix}`,
    fileName: `Расчёты_${period.slice(0, MAX_FILE_PERIOD_LENGTH)}_${isoDate}.xlsx`.replace(/[\s/\\:*?"<>|]+/g, '_'),
    columns: payrollCalcExportColumns(params),
    rows: params.rows,
  });
};
