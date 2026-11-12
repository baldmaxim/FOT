import { Fragment, memo, useCallback, useEffect, useMemo, useRef, type FC, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Minus, Plus } from 'lucide-react';

import {
  CONTRACT_TYPE_LABELS,
  type IPayrollColumnFilters,
  type IPayrollTermsRow,
  type PayrollSortDir,
  type PayrollSortKey,
} from '../../services/payrollService';
import { usePayrollAccrualsColumnWidth } from '../../hooks/usePayrollAccrualsColumnWidth';
import {
  accrualLines,
  accrualsByMonthParts,
  formatAccrualPeriodLong,
  formatAccrualPeriodShort,
  type IAccrualMonthPart,
} from '../../utils/payrollAccruals';
import { isCalcColumn, PAYROLL_CALC_HEADER_TITLES } from '../../utils/payrollCalcColumns';
import { payrollTotalState, type IPayrollTotalsStatus } from '../../utils/payrollCalcTotals';
import { countPayrollAmountFilters, isPayrollAmountViewColumn } from '../../utils/payrollCalcView';
import { formatDate } from '../../utils/formatMoney';
import { cx } from '../../utils/motion';
import { isPayrollColumnFilterActive, isPayrollGphRow } from '../../utils/payrollColumnFilters';
import { isSortablePayrollColumn, type PayrollTableColumn, type PayrollTableColumns } from '../../utils/payrollColumns';
import type { PayrollPaidTotalKind } from '../../utils/payrollPaid';
import {
  colClassOf,
  formatMonthly,
  formatPaid,
  formatSalary,
  PAID_KIND_LABELS,
} from '../../utils/payrollTermsTableFormat';
import {
  isExpandablePayrollColumn,
  payrollGroupMarks,
  payrollSubColumns,
  payrollTableColumnList,
  type PayrollExpandableColumn,
  type PayrollSubColumn,
} from '../../utils/payrollSubColumns';
import { isColumnFiltered, type ITableView } from '../../utils/tableView';
import { TableSortHeader } from '../ui/TableSortHeader';
import { PayrollCalcCell } from './PayrollCalcCell';
import { PayrollSortHeader } from './PayrollSortHeader';
import { PayrollSubColumnCell } from './PayrollSubColumnCell';
import { PayrollTotalsRow } from './PayrollTotalsRow';
import styles from './PayrollTermsTable.module.css';

interface IPayrollTermsTableProps {
  rows: IPayrollTermsRow[];
  /** Столбцы таблицы по порядку («Условия оплаты» или «Расчёты»), кроме «№» и «Сотрудника». */
  columns: PayrollTableColumns;
  /** Скрытые шестерёнкой столбцы; «№» и «Сотрудник» видны всегда. */
  hiddenColumns: ReadonlySet<PayrollTableColumn>;
  onEdit: (row: IPayrollTermsRow) => void;
  /** Вызывается с индексом последней отрисованной строки — решение о догрузке у родителя. */
  onLoadMore: (lastVisibleIndex: number) => void;
  /** Смена фильтра или сортировки: прокрутка возвращается наверх. */
  resetKey: string;
  sort: PayrollSortKey;
  dir: PayrollSortDir;
  onSort: (key: PayrollSortKey) => void;
  columnFilters: IPayrollColumnFilters;
  onOpenFilter: (key: PayrollSortKey, anchor: HTMLElement) => void;
  /** Месяцы столбца «Выплачено» (YYYY-MM) по порядку. */
  accrualMonths: string[];
  /** Период сумм «Расчётов» — тех, что пришли в строках. */
  paidPeriod?: string;
  /** Клик по сумме «Удержания (1С)»: окно со статьями; trigger — куда вернуть фокус. */
  onOpenPaidItems?: (row: IPayrollTermsRow, kind: PayrollPaidTotalKind, trigger: HTMLButtonElement) => void;
  /** «Расчёты»: раскрытые «+» столбцы («Доплаты», «Удержания», «Удержания (ФОТ)»); без onToggleExpand «+» нет. */
  expandedColumns?: ReadonlySet<PayrollExpandableColumn>;
  onToggleExpand?: (column: PayrollExpandableColumn) => void;
  /** «Расчёты»: закреплённая снизу строка «Итого» и что для неё готово; нет — строки нет. */
  totalsStatus?: IPayrollTotalsStatus;
  /**
   * «Расчёты»: сортировка и фильтр столбцов сумм на клиенте (payrollCalcView.ts), строки уже с ними. Без него у сумм
   * нет ни стрелки, ни воронки. sort — '' или столбец суммы; тогда серверная сортировка не подсвечивается.
   */
  amountView?: ITableView;
  onAmountSort?: (key: PayrollTableColumn) => void;
  onOpenAmountFilter?: (key: PayrollTableColumn, anchor: HTMLElement) => void;
  /** Клик по «Не посчитано, N чел.» в «Итого» (фильтр «Сумма: —»); нет — подпись не нажимается. */
  onShowUncounted?: () => void;
}

/** Оценка до измерения: строка в одну линию ≈ 36px, переносы подразделения/должности — выше. */
const ROW_ESTIMATE = 44;
/** Всегда видимые столбцы: «№», «Сотрудник» (и чекбокс, если есть). */
const FIXED_COLUMN_COUNT = 2;
const NO_EXPANDED: ReadonlySet<PayrollExpandableColumn> = new Set();

const renderAccrualLine = (line: IAccrualMonthPart[]): ReactNode => line.map(({ month, name, amount, pending }, index) => (
  <Fragment key={month}>
    {index > 0 && <span className={styles.accrualSep}>; </span>}
    <span className={styles.accrualMonth}>{name}</span>
    {amount === null
      ? (pending ? '\u00a0…' : '\u00a0—')
      : <>:{'\u00a0'}<span className={styles.accrualAmount}>{amount}</span></>}
  </Fragment>
));

/**
 * «Выплачено»: месяцы курсивом, суммы крупнее; две строки поровну (3 + 3), между месяцем и суммой NBSP.
 * Ширину содержимого считает usePayrollAccrualsColumnWidth — разметку менять вместе с accrualsCellWidth («…» там
 * меряется как «—», ширина почти та же). Пока расчёт ФОТ порции идёт — суммы 1С списка, месяц без суммы — «…».
 */
const renderAccruals = (months: string[], row: IPayrollTermsRow): ReactNode => {
  const pending = row.payouts_status === 'pending';
  const parts = accrualsByMonthParts(months, row.payouts, pending);
  if (parts === null) return pending ? '…' : '—';
  const [first, second] = accrualLines(parts);
  return (
    <span className={styles.accruals}>
      {renderAccrualLine(first)}
      {second.length > 0 && <>;<br />{renderAccrualLine(second)}</>}
    </span>
  );
};

/**
 * Таблица условий оплаты в стиле «Управления кадрами»: фиксированные колонки с переносом,
 * закреплённая шапка, виртуализация строк и догрузка порций при прокрутке.
 */
export const PayrollTermsTable: FC<IPayrollTermsTableProps> = memo(({
  rows,
  columns,
  hiddenColumns,
  onEdit,
  onLoadMore,
  resetKey,
  sort,
  dir,
  onSort,
  columnFilters,
  onOpenFilter,
  accrualMonths,
  paidPeriod,
  onOpenPaidItems,
  expandedColumns = NO_EXPANDED,
  onToggleExpand,
  totalsStatus,
  amountView,
  onAmountSort,
  onOpenAmountFilter,
  onShowUncounted,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const accrualPeriodShort = useMemo(() => formatAccrualPeriodShort(accrualMonths), [accrualMonths]);
  const accrualPeriodLong = useMemo(() => formatAccrualPeriodLong(accrualMonths), [accrualMonths]);
  const accrualsWidth = usePayrollAccrualsColumnWidth(rows, accrualMonths);
  // Подстолбцы раскрываемых столбцов — по загруженным строкам; без onToggleExpand («Условия оплаты») их нет.
  const subColumns = useMemo(() => {
    const result = new Map<PayrollExpandableColumn, PayrollSubColumn[]>();
    if (!onToggleExpand) return result;
    for (const { key } of columns) {
      if (isExpandablePayrollColumn(key)) result.set(key, payrollSubColumns(rows, key));
    }
    return result;
  }, [columns, onToggleExpand, rows]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE,
    // Строки измеряются: высота зависит от переносов, постоянная оценка у низа копила бы ошибку.
    getItemKey: index => rows[index]?.employee_id ?? index,
    overscan: 15,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const lastVisibleIndex = virtualItems.length > 0 ? virtualItems[virtualItems.length - 1].index : -1;

  useEffect(() => {
    onLoadMore(lastVisibleIndex);
  }, [lastVisibleIndex, onLoadMore]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [resetKey]);

  const topSpacer = virtualItems[0]?.start ?? 0;
  const lastItem = virtualItems[virtualItems.length - 1];
  const bottomSpacer = lastItem ? virtualizer.getTotalSize() - lastItem.end : 0;

  // Один список видимых столбцов с раскрытыми подстолбцами — для colgroup, шапки, ячеек и colSpan.
  // В useMemo: виртуализация перерисовывает таблицу при каждой прокрутке, а «Итого» считается по этому списку.
  const tableColumns = useMemo(
    () => payrollTableColumnList(columns.filter(column => !hiddenColumns.has(column.key)), expandedColumns, subColumns),
    [columns, hiddenColumns, expandedColumns, subColumns],
  );
  const columnCount = FIXED_COLUMN_COUNT + tableColumns.length;
  // Группы «+» как в Excel: итог с «+» темнее, у раскрытой — скобка над шапкой и линии; классы по ключу столбца.
  const withPlus = useMemo(
    () => new Set([...subColumns].filter(([, subs]) => subs.length > 0).map(([key]) => key)),
    [subColumns],
  );
  const groupClasses = useMemo(() => {
    const groupMarks = payrollGroupMarks(tableColumns, withPlus);
    return new Map(tableColumns.map((entry, index) => {
      const mark = groupMarks[index];
      const lines = cx(mark.leftLine && styles.groupLineLeft, mark.last && styles.groupLineRight);
      return [entry.key, {
        head: cx(lines, mark.total && styles.groupTotalHead, mark.inGroup && styles.groupHead,
          mark.first && styles.groupHeadFirst, mark.last && styles.groupHeadLast),
        cell: cx(lines, mark.total && styles.groupTotal),
      }] as const;
    }));
  }, [tableColumns, withPlus]);
  const groupCellClass = useCallback((key: string) => groupClasses.get(key)?.cell, [groupClasses]);

  const renderSortHeader = (key: PayrollSortKey, label: string, className?: string) => (
    <PayrollSortHeader
      key={key}
      sortKey={key}
      label={label}
      className={className}
      activeKey={amountView?.sort ? null : sort}
      dir={dir}
      onSort={onSort}
      onOpenFilter={onOpenFilter}
      filterActive={isPayrollColumnFilterActive(columnFilters, key)}
    />
  );

  /** Сумма «Удержания (1С)»: со статьями — кнопка, открывающая окно со статьями. */
  const renderPaidCell = (
    column: PayrollTableColumn,
    row: IPayrollTermsRow,
    kind: PayrollPaidTotalKind,
    total: string | null | undefined,
    hasDetails: boolean,
  ): ReactNode => (
    <td key={column} className={cx(styles.cellNumber, groupClasses.get(column)?.cell)}>
      {hasDetails && onOpenPaidItems ? (
        // Своя кнопка: клик открывает окно статей, а не карточку строки.
        <button
          type="button"
          className={styles.paidButton}
          aria-haspopup="dialog"
          aria-label={`${PAID_KIND_LABELS[kind]}: ${row.full_name ?? 'сотрудник'}, ${formatPaid(total)} ₽`}
          onClick={event => {
            event.stopPropagation();
            onOpenPaidItems(row, kind, event.currentTarget);
          }}
        >
          {formatPaid(total)}
        </button>
      ) : formatPaid(total)}
    </td>
  );

  /**
   * Шапка столбца суммы «Расчётов»: сортировка и воронка на клиенте, «+» раскрытия и период под подписью. Пока суммы
   * столбца не готовы (как его «Итого»), кнопки неактивны: по части строк порядок и варианты фильтра были бы неверны.
   */
  const renderAmountHeader = (column: PayrollTableColumns[number], view: ITableView): ReactNode => {
    const ready = totalsStatus !== undefined && payrollTotalState(totalsStatus, isCalcColumn(column.key)) === 'ready';
    const toggle = isExpandablePayrollColumn(column.key) ? renderExpandToggle(column.key, column.label) : null;
    return (
      <TableSortHeader
        key={column.key}
        sortKey={column.key}
        label={column.label}
        className={groupClasses.get(column.key)?.head || undefined}
        title={PAYROLL_CALC_HEADER_TITLES[column.key]}
        activeKey={view.sort}
        dir={view.dir}
        onSort={key => onAmountSort?.(key)}
        onOpenFilter={(key, anchor) => onOpenAmountFilter?.(key, anchor)}
        filterActive={isColumnFiltered(view, column.key)}
        disabled={!ready}
        extra={toggle ? <span className={styles.headExtra}>{toggle}</span> : undefined}
      >
        {paidPeriod && column.key !== 'calc_rate' && (
          <span className={`${styles.headPeriod} ${styles.headPeriodWrap}`}>{paidPeriod}</span>
        )}
      </TableSortHeader>
    );
  };

  /** Шапка столбца; у сумм «Оплачено» — период под подписью, без сортировки и фильтра. */
  const renderHeader = (column: PayrollTableColumns[number]): ReactNode => {
    if (isSortablePayrollColumn(column.key)) return renderSortHeader(column.key, column.label);
    if (amountView && isPayrollAmountViewColumn(column.key)) return renderAmountHeader(column, amountView);
    if (column.key === 'accruals') {
      // Период вместо «посл. полгода»: видно, что текущий месяц не входит. Сортировки и фильтра нет.
      return (
        <th key={column.key} title={`Выплачено за последние полгода (начислено − удержано), ₽: ${accrualPeriodLong}`}>
          Выплачено, ₽
          <span className={styles.headPeriod}>{accrualPeriodShort}</span>
        </th>
      );
    }
    // «Оклад» — ставка на конец периода, не сумма за месяцы: периода под подписью нет.
    const toggle = isExpandablePayrollColumn(column.key) ? renderExpandToggle(column.key, column.label) : null;
    return (
      <th key={column.key} className={groupClasses.get(column.key)?.head || undefined} title={PAYROLL_CALC_HEADER_TITLES[column.key]}>
        {toggle ? <span className={styles.headToggle}>{column.label}{toggle}</span> : column.label}
        {paidPeriod && column.key !== 'calc_rate' && (
          <span className={`${styles.headPeriod} ${styles.headPeriodWrap}`}>{paidPeriod}</span>
        )}
      </th>
    );
  };

  /** «+»/«−» раскрываемого столбца — только когда есть что раскрыть. */
  const renderExpandToggle = (column: PayrollExpandableColumn, label: string): ReactNode => {
    if (!onToggleExpand || !withPlus.has(column)) return null;
    const expanded = expandedColumns.has(column);
    const Icon = expanded ? Minus : Plus;
    return (
      <button
        type="button"
        className={styles.expandButton}
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Свернуть' : 'Раскрыть'} «${label}»`}
        onClick={() => onToggleExpand(column)}
      >
        <Icon size={14} aria-hidden="true" />
      </button>
    );
  };

  /** Шапка подстолбца: подпись без капса и период, как у соседей; у прежних столбцов ФОТ — их подсказка. */
  const renderSubHeader = (key: string, sub: PayrollSubColumn): ReactNode => (
    <th key={key} className={cx(styles.subHead, groupClasses.get(key)?.head)} title={sub.type === 'column' ? PAYROLL_CALC_HEADER_TITLES[sub.column] : undefined}>
      {sub.label}
      {paidPeriod && <span className={`${styles.headPeriod} ${styles.headPeriodWrap}`}>{paidPeriod}</span>}
    </th>
  );

  /** Ячейка подстолбца: переработка, проезд, проживание — прежней ячейкой ФОТ, прочие — своей. */
  const renderSubCell = (key: string, sub: PayrollSubColumn, row: IPayrollTermsRow): ReactNode => (
    sub.type === 'column'
      ? <PayrollCalcCell key={key} column={sub.column} row={row} className={groupClasses.get(key)?.cell} />
      : <PayrollSubColumnCell key={key} sub={sub} row={row} className={groupClasses.get(key)?.cell} />
  );

  const renderCell = (column: PayrollTableColumn, row: IPayrollTermsRow): ReactNode => {
    switch (column) {
      case 'department':
        return <td key={column}><span className={styles.clamp3}>{row.department_name ?? '—'}</span></td>;
      case 'position':
        return <td key={column}><span className={styles.clamp3}>{row.position_name ?? '—'}</span></td>;
      case 'schedule':
        return (
          <td key={column} className={styles.cellOneLine} title={row.schedule_name ?? undefined}>
            {row.schedule_name ?? '—'}
          </td>
        );
      case 'salary':
        return <td key={column} className={styles.cellNumber}>{formatSalary(row)}</td>;
      case 'bonus':
        return <td key={column} className={styles.cellNumber}>{formatMonthly(row, row.bonus_amount)}</td>;
      case 'housing':
        // Ставка квартиры — за день (миграция 339).
        return <td key={column} className={styles.cellNumber}>{formatMonthly(row, row.housing_compensation, '₽/день')}</td>;
      case 'accruals':
        return <td key={column} className={styles.cellAccruals}>{renderAccruals(accrualMonths, row)}</td>;
      case 'deductions': {
        const total = row.paid_deductions_total;
        return renderPaidCell(column, row, 'deducted', total, total !== null && total !== undefined && (row.paid_deductions?.length ?? 0) > 0);
      }
      default:
        // Состав зарплаты «Расчётов»: ФОТ по закрытому табелю и суммы 1С.
        return <PayrollCalcCell key={column} column={column} row={row} className={groupClasses.get(column)?.cell} />;
    }
  };

  return (
    <div className={cx(styles.wrap, totalsStatus && styles.wrapTotals)} ref={scrollRef}>
      <table className={styles.table}>
        <colgroup>
          <col className={styles.colNum} />
          <col className={styles.colName} />
          {tableColumns.map(entry => (
            <col
              key={entry.key}
              className={styles[colClassOf(entry)]}
              style={entry.key === 'accruals' ? { width: accrualsWidth } : undefined}
            />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className={`${styles.stickyNum} ${styles.cellNum}`}>№</th>
            {renderSortHeader('name', 'Сотрудник', styles.stickyName)}
            {tableColumns.map(entry => (entry.kind === 'column' ? renderHeader(entry.column) : renderSubHeader(entry.key, entry.sub)))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columnCount} className={styles.empty}>
                {/* Фильтр сумм отбирает только посчитанные строки: пока счёт идёт, «не найдены» было бы неправдой. */}
                {amountView && countPayrollAmountFilters(amountView) > 0 && totalsStatus
                  && (totalsStatus.rows === 'pending' || totalsStatus.calc === 'pending')
                  ? 'Загрузка…'
                  : 'Сотрудники не найдены'}
              </td>
            </tr>
          ) : (
            <>
              {topSpacer > 0 && (
                <tr aria-hidden="true" className={styles.spacer}>
                  <td colSpan={columnCount} style={{ height: topSpacer }} />
                </tr>
              )}
              {virtualItems.map(item => {
                const row = rows[item.index];
                // Чередование — по индексу строки, а не :nth-child: spacer-строка виртуализации
                // сдвигала бы чётность, и полосы «прыгали» при прокрутке.
                const rowClass = item.index % 2 === 1 ? styles.rowEven : '';
                return (
                  // Строка кликабельна, как в «Текущих сотрудниках»: открывает карточку во вкладке «Подробно».
                  <tr
                    key={row.employee_id}
                    ref={virtualizer.measureElement}
                    data-index={item.index}
                    className={`${styles.rowClickable}${rowClass ? ` ${rowClass}` : ''}`}
                    tabIndex={0}
                    aria-label={`Условия оплаты: ${row.full_name ?? 'сотрудник'}`}
                    onClick={() => onEdit(row)}
                    onKeyDown={event => {
                      // Только клавиши на самой строке, а не на элементах внутри неё.
                      if (event.target !== event.currentTarget) return;
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onEdit(row);
                      }
                    }}
                  >
                    <td className={`${styles.stickyNum} ${styles.cellNum}`}>{item.index + 1}</td>
                    <td className={`${styles.stickyName} ${styles.cellName}`}>
                      <span className={styles.clamp2}>{row.full_name ?? '—'}</span>
                      {isPayrollGphRow(row) && (
                        <span className={styles.contractMark}>{CONTRACT_TYPE_LABELS.gph}</span>
                      )}
                      {row.employment_status === 'fired' && (
                        <span className={styles.dismissedMark}>
                          {row.dismissal_date ? `Уволен ${formatDate(row.dismissal_date)}` : 'Уволен'}
                        </span>
                      )}
                    </td>
                    {tableColumns.map(entry => (
                      entry.kind === 'column' ? renderCell(entry.key, row) : renderSubCell(entry.key, entry.sub, row)
                    ))}
                  </tr>
                );
              })}
              {bottomSpacer > 0 && (
                <tr aria-hidden="true" className={styles.spacer}>
                  <td colSpan={columnCount} style={{ height: bottomSpacer }} />
                </tr>
              )}
            </>
          )}
        </tbody>
        {totalsStatus && rows.length > 0 && (
          <PayrollTotalsRow
            rows={rows}
            columns={tableColumns}
            status={totalsStatus}
            groupCellClass={groupCellClass}
            onShowUncounted={onShowUncounted}
          />
        )}
      </table>
    </div>
  );
});

PayrollTermsTable.displayName = 'PayrollTermsTable';
