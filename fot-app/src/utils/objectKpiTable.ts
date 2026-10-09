import type {
  IObjectKpiObjectStat,
  IObjectKpiReportRow,
  IPeriod,
  IReportPremiumRow,
} from '../api/objectKpi';
import { formatMoneyShort, formatMonthLabel, formatPercent } from './formatMoney';
import { shiftMonth } from './moscowDate';
import { PREMIUM_STATUS_SHORT, PREMIUM_STATUS_TEXT } from './premiumStatus';
import type { ITableColumn, ITableView } from './tableView';

/**
 * Таблицы вкладки «KPI объектов»: описания столбцов, сортировка, фильтры и снимок для xlsx.
 *
 * Строк не больше пары десятков (объекты или месяцы одного объекта), поэтому сортировка и
 * фильтры — на клиенте (общие функции — в tableView.ts). Деньги здесь не считаются — только
 * сравниваются и передаются как пришли с сервера.
 */

export {
  applyTableView,
  buildExportTable,
  columnFilterOptions,
  isColumnFiltered,
  setColumnFilter,
  toggleSort,
} from './tableView';
export type { IFilterOption, SortDir } from './tableView';

export type IKpiTableView = ITableView;

/** Класс ширины колонки в ObjectKpiTable.module.css. */
export type KpiColumnWidth = 'colObject' | 'colManager' | 'colMonth' | 'colMoney' | 'colPercent' | 'colShort';

export interface IKpiColumn<Row> extends ITableColumn<Row> {
  width: KpiColumnWidth;
}

const toSortNumber = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const moneyColumn = <Row,>(
  key: string,
  label: string,
  value: (row: Row) => string | number | null,
  title?: string,
): IKpiColumn<Row> => ({
  key,
  label,
  type: 'money',
  width: 'colMoney',
  title,
  text: row => formatMoneyShort(value(row)),
  sortValue: row => toSortNumber(value(row)),
  exportValue: row => value(row),
});

const percentColumn = <Row,>(value: (row: Row) => string | number | null): IKpiColumn<Row> => ({
  key: 'pct',
  label: '%',
  type: 'percent',
  width: 'colPercent',
  text: row => formatPercent(value(row)),
  sortValue: row => toSortNumber(value(row)),
  exportValue: row => value(row),
});

/** Таблица «Все объекты»: строка на объект за выбранные месяцы. */
export const OBJECT_STAT_COLUMNS: ReadonlyArray<IKpiColumn<IObjectKpiObjectStat>> = [
  {
    key: 'object',
    label: 'Объект',
    type: 'text',
    width: 'colObject',
    text: row => row.object_name,
    sortValue: row => row.object_name,
  },
  {
    key: 'manager',
    label: 'Руководитель',
    type: 'text',
    width: 'colManager',
    text: row => row.manager_names.join(', ') || '—',
    sortValue: row => row.manager_names.join(', ') || null,
  },
  moneyColumn('contract', 'Договор с ДС', row => row.contract_total),
  moneyColumn('ks6', 'КС-6', row => row.ks2_cumulative_before),
  moneyColumn('remainder', 'Остаток', row => row.remainder),
  moneyColumn('ks2', 'КС-2', row => row.fact_amount),
  moneyColumn('plan', 'План', row => row.plan_amount),
  percentColumn(row => row.completion_pct),
];

/** Премия руководителя в строке месяца: состояние запроса, скрытые руководители, статусы. */
export interface IPremiumView {
  state: 'loading' | 'error' | 'ready';
  /** Ключ — «руководитель|месяц»: премия по приказу принадлежит человеку, а не объекту. */
  byKey: ReadonlyMap<string, IReportPremiumRow>;
  /** Руководители с объектами вне скоупа зрителя: совокупную премию не показываем вовсе. */
  hidden: ReadonlySet<number>;
}

export interface IPremiumCell {
  text: string;
  title?: string;
  muted: boolean;
  /** Сумма рассчитанной премии; null — в ячейке подпись, а не деньги. */
  amount: string | null;
}

/** Состояния колонки «Премия»: считается, ошибка, скрыта по доступу, не рассчитана. */
export const premiumCell = (row: IObjectKpiReportRow, premium: IPremiumView): IPremiumCell => {
  const managerId = row.primary_manager_id;
  if (!managerId) return { text: '—', title: 'За месяц нет закреплённого руководителя', muted: false, amount: null };
  if (premium.state === 'loading') return { text: '…', muted: true, amount: null };
  if (premium.state === 'error') return { text: 'н/д', title: 'Не удалось рассчитать премию', muted: true, amount: null };
  if (premium.hidden.has(managerId)) {
    return {
      text: '—',
      title: 'Недоступно: у руководителя есть объекты вне вашего доступа',
      muted: true,
      amount: null,
    };
  }

  const item = premium.byKey.get(`${managerId}|${row.period_month}`);
  if (!item) return { text: '—', title: 'Премия за этот месяц не рассчитывалась', muted: false, amount: null };
  if (item.status !== 'calculated') {
    return {
      text: PREMIUM_STATUS_SHORT[item.status],
      title: PREMIUM_STATUS_TEXT[item.status],
      muted: true,
      amount: null,
    };
  }
  return {
    text: formatMoneyShort(item.premium_amount),
    title: 'Совокупно за все объекты руководителя (п. 3.5)',
    muted: false,
    amount: item.premium_amount,
  };
};

/**
 * Таблица объекта по месяцам. КС-6 — сумма КС-2 за все прошлые месяцы (со стартом из ручного
 * остатка), поэтому в каждой строке «Договор − КС-6 = Остаток» (п. 2.2). КС-2 — акты месяца,
 * у прогнозного месяца — его план.
 */
export const buildMonthColumns = (premium: IPremiumView): Array<IKpiColumn<IObjectKpiReportRow>> => [
  {
    key: 'premium',
    label: 'Премия',
    type: 'money',
    width: 'colMoney',
    text: row => premiumCell(row, premium).text,
    sortValue: row => toSortNumber(premiumCell(row, premium).amount),
    exportValue: row => premiumCell(row, premium).amount,
  },
  {
    key: 'month',
    label: 'Месяц',
    type: 'text',
    width: 'colMonth',
    text: row => formatMonthLabel(row.period_month),
    sortValue: row => row.period_month,
  },
  {
    key: 'manager',
    label: 'Руководитель',
    type: 'text',
    width: 'colManager',
    text: row => row.primary_manager_name ?? '—',
    sortValue: row => row.primary_manager_name,
  },
  moneyColumn('contract', 'Договор с ДС', row => row.contract_total),
  moneyColumn('ks6', 'КС-6', row => row.ks2_cumulative_before),
  moneyColumn('remainder', 'Остаток', row => row.remainder),
  moneyColumn(
    'ks2',
    'КС-2',
    row => row.fact_amount,
    'Подписано за месяц, с учётом уменьшений объёма (п. 3.1, 3.3)',
  ),
  {
    key: 'months_left',
    label: 'Мес.',
    type: 'int',
    width: 'colShort',
    text: row => (row.months_remaining === null ? '—' : String(row.months_remaining)),
    sortValue: row => row.months_remaining,
    exportValue: row => row.months_remaining,
  },
  moneyColumn('plan', 'План месяца', row => row.plan_amount),
  percentColumn(row => row.completion_pct),
];

/** Месяцы окна расчёта по порядку (YYYY-MM). */
export const listWindowMonths = (period: IPeriod): string[] => {
  const result: string[] = [];
  for (let month = period.from; month <= period.to; month = shiftMonth(month, 1)) {
    result.push(month);
    if (result.length > 240) break;  // страховка от кривого окна
  }
  return result;
};

/** Месяц по умолчанию — прошлый (от текущего месяца сервера), если он есть в окне; иначе весь период. */
export const defaultMonths = (options: ReadonlyArray<string>, currentMonth: string): string[] => {
  const previous = shiftMonth(currentMonth, -1);
  return options.includes(previous) ? [previous] : [];
};

