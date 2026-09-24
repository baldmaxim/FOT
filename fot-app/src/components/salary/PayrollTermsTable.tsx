import { memo, useEffect, useMemo, useRef, type FC } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import type {
  IPayrollColumnFilters,
  IPayrollTermsRow,
  PayrollSortDir,
  PayrollSortKey,
} from '../../services/payrollService';
import { formatAccrualPeriodLong, formatAccrualPeriodShort } from '../../utils/payrollAccruals';
import { isPayrollColumnFilterActive } from '../../utils/payrollColumnFilters';
import { PAYROLL_TABLE_COLUMNS, type PayrollTableColumn } from '../../utils/payrollColumns';
import { formatPayrollMoney } from '../../utils/payrollFormat';
import { PayrollAccrualsCell } from './PayrollAccrualsCell';
import { PayrollSortHeader } from './PayrollSortHeader';
import styles from './PayrollTermsTable.module.css';

interface IPayrollTermsTableProps {
  rows: IPayrollTermsRow[];
  selected: Set<number>;
  allSelected: boolean;
  /** Право правки страницы. Без него, как и у строки вне скоупа правки, выделять нечего. */
  canEdit: boolean;
  /** Скрытые шестерёнкой столбцы; чекбокс, «№» и «Сотрудник» видны всегда. */
  hiddenColumns: ReadonlySet<PayrollTableColumn>;
  onToggleOne: (employeeId: number) => void;
  onToggleAll: () => void;
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
  /** Месяцы столбца «Начисления» (YYYY-MM) по порядку. */
  accrualMonths: string[];
  /** Клик по ячейке «Начисления» — суммы по месяцам; anchor — кнопка ячейки. */
  onOpenAccruals: (row: IPayrollTermsRow, anchor: HTMLElement) => void;
}

/** Столбцы с сортировкой и фильтром — в порядке таблицы. */
const SORTABLE_COLUMNS: ReadonlyArray<{ key: PayrollSortKey; label: string; className?: string }> = [
  { key: 'name', label: 'Сотрудник', className: 'stickyName' },
  { key: 'department', label: 'Подразделение' },
  { key: 'position', label: 'Должность' },
  { key: 'schedule', label: 'График работы' },
  { key: 'salary', label: 'Оклад' },
  { key: 'bonus', label: 'Премиальная часть' },
  { key: 'housing', label: 'Компенсация проживания' },
];

/** Оценка до измерения: строка в одну линию ≈ 36px, переносы подразделения/должности — выше. */
const ROW_ESTIMATE = 44;
/** Всегда видимые столбцы: чекбокс, «№», «Сотрудник». */
const FIXED_COLUMN_COUNT = 3;

/** Класс ширины колонки (colgroup) для скрываемых столбцов. */
const COL_CLASS: Record<PayrollTableColumn, string> = {
  department: 'colDept',
  position: 'colPosition',
  schedule: 'colSchedule',
  salary: 'colSalary',
  bonus: 'colBonus',
  housing: 'colHousing',
  accruals: 'colAccruals',
};

/** Сумма зависит от вида оплаты: у оклада — месячная, у почасовой — ставка за час. */
const formatSalary = (row: IPayrollTermsRow): string => {
  if (!row.terms_id) return '—';
  const money = row.calc_type === 'salary' ? formatPayrollMoney(row.monthly_salary) : formatPayrollMoney(row.hourly_rate);
  if (money === null) return '—';
  return row.calc_type === 'salary' ? `${money} ₽/мес` : `${money} ₽/час`;
};

const formatMonthly = (row: IPayrollTermsRow, value: string | number | null): string => {
  const money = row.terms_id ? formatPayrollMoney(value) : null;
  return money === null ? '—' : `${money} ₽/мес`;
};

/**
 * Таблица условий оплаты в стиле «Управления кадрами»: фиксированные колонки с переносом,
 * закреплённая шапка, виртуализация строк и догрузка порций при прокрутке.
 */
export const PayrollTermsTable: FC<IPayrollTermsTableProps> = memo(({
  rows,
  selected,
  allSelected,
  canEdit,
  hiddenColumns,
  onToggleOne,
  onToggleAll,
  onEdit,
  onLoadMore,
  resetKey,
  sort,
  dir,
  onSort,
  columnFilters,
  onOpenFilter,
  accrualMonths,
  onOpenAccruals,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const accrualPeriodShort = useMemo(() => formatAccrualPeriodShort(accrualMonths), [accrualMonths]);
  const accrualPeriodLong = useMemo(() => formatAccrualPeriodLong(accrualMonths), [accrualMonths]);

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

  const shown = (column: PayrollTableColumn) => !hiddenColumns.has(column);
  const visibleColumns = PAYROLL_TABLE_COLUMNS.filter(column => shown(column.key));
  const columnCount = FIXED_COLUMN_COUNT + visibleColumns.length;
  const sortableHeaders = SORTABLE_COLUMNS.filter(column => column.key === 'name' || shown(column.key));

  return (
    <div className={styles.wrap} ref={scrollRef}>
      <table className={styles.table}>
        <colgroup>
          <col className={styles.colCheck} />
          <col className={styles.colNum} />
          <col className={styles.colName} />
          {visibleColumns.map(column => <col key={column.key} className={styles[COL_CLASS[column.key]]} />)}
        </colgroup>
        <thead>
          <tr>
            <th className={`${styles.stickyCheck} ${styles.cellCheck}`}>
              <input
                type="checkbox"
                className={styles.check}
                aria-label="Выделить всех загруженных"
                checked={allSelected}
                disabled={!canEdit}
                onChange={onToggleAll}
              />
            </th>
            <th className={`${styles.stickyNum} ${styles.cellNum}`}>№</th>
            {sortableHeaders.map(column => (
              <PayrollSortHeader
                key={column.key}
                sortKey={column.key}
                label={column.label}
                className={column.className ? styles[column.className] : undefined}
                activeKey={sort}
                dir={dir}
                onSort={onSort}
                onOpenFilter={onOpenFilter}
                filterActive={isPayrollColumnFilterActive(columnFilters, column.key)}
              />
            ))}
            {/*
              Период вместо «посл. полгода»: видно, что текущий месяц не входит. Сортировки и фильтра
              нет — начисления придут из 1С ЗУП, сервер их пока не отдаёт.
            */}
            {shown('accruals') && (
              <th title={`Начисления за последние полгода: ${accrualPeriodLong}`}>
                Начисления
                <span className={styles.headPeriod}>{accrualPeriodShort}</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columnCount} className={styles.empty}>Сотрудники не найдены</td>
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
                const isSelected = selected.has(row.employee_id);
                // Чередование — по индексу строки, а не :nth-child: spacer-строка виртуализации
                // сдвигала бы чётность, и полосы «прыгали» при прокрутке.
                const rowClass = [
                  item.index % 2 === 1 ? styles.rowEven : '',
                  isSelected ? styles.rowSelected : '',
                ].filter(Boolean).join(' ');
                return (
                  // Строка кликабельна, как в «Текущих сотрудниках»: открывает окно условий оплаты.
                  <tr
                    key={row.employee_id}
                    ref={virtualizer.measureElement}
                    data-index={item.index}
                    className={`${styles.rowClickable}${rowClass ? ` ${rowClass}` : ''}`}
                    tabIndex={0}
                    aria-label={`Условия оплаты: ${row.full_name ?? 'сотрудник'}`}
                    onClick={() => onEdit(row)}
                    onKeyDown={event => {
                      // Только клавиши на самой строке: пробел на чекбоксе внутри должен выделять, а не открывать окно.
                      if (event.target !== event.currentTarget) return;
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onEdit(row);
                      }
                    }}
                  >
                    {/* Выделение не открывает окно — как ячейка чекбокса у кадров. */}
                    <td className={`${styles.stickyCheck} ${styles.cellCheck}`} onClick={event => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        className={styles.check}
                        aria-label={`Выделить ${row.full_name ?? ''}`}
                        checked={isSelected}
                        disabled={!canEdit || row.can_edit === false}
                        onChange={() => onToggleOne(row.employee_id)}
                      />
                    </td>
                    <td className={`${styles.stickyNum} ${styles.cellNum}`}>{item.index + 1}</td>
                    <td className={`${styles.stickyName} ${styles.cellName}`}>
                      <span className={styles.clamp2}>{row.full_name ?? '—'}</span>
                    </td>
                    {shown('department') && <td><span className={styles.clamp3}>{row.department_name ?? '—'}</span></td>}
                    {shown('position') && <td><span className={styles.clamp3}>{row.position_name ?? '—'}</span></td>}
                    {shown('schedule') && (
                      <td className={styles.cellOneLine} title={row.schedule_name ?? undefined}>
                        {row.schedule_name ?? '—'}
                      </td>
                    )}
                    {shown('salary') && <td className={styles.cellNumber}>{formatSalary(row)}</td>}
                    {shown('bonus') && <td className={styles.cellNumber}>{formatMonthly(row, row.bonus_amount)}</td>}
                    {shown('housing') && <td className={styles.cellNumber}>{formatMonthly(row, row.housing_compensation)}</td>}
                    {/* Без данных — «—», клик как по строке; с данными — итог и мини-график, клик открывает месяцы. */}
                    {shown('accruals') && (
                      <td className={styles.cellAccruals}>
                        <PayrollAccrualsCell
                          row={row}
                          months={accrualMonths}
                          periodLabel={accrualPeriodLong}
                          onOpen={onOpenAccruals}
                        />
                      </td>
                    )}
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
      </table>
    </div>
  );
});

PayrollTermsTable.displayName = 'PayrollTermsTable';
