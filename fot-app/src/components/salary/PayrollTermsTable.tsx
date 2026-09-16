import { memo, useEffect, useRef, type FC } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import type { IPayrollTermsRow } from '../../services/payrollService';
import styles from './PayrollTermsTable.module.css';

interface IPayrollTermsTableProps {
  rows: IPayrollTermsRow[];
  selected: Set<number>;
  allSelected: boolean;
  onToggleOne: (employeeId: number) => void;
  onToggleAll: () => void;
  onEdit: (row: IPayrollTermsRow) => void;
  /** Вызывается с индексом последней отрисованной строки — решение о догрузке у родителя. */
  onLoadMore: (lastVisibleIndex: number) => void;
  /** Смена фильтра: прокрутка возвращается наверх. */
  resetKey: string;
}

/** Оценка до измерения: строка в одну линию ≈ 36px, переносы подразделения/должности — выше. */
const ROW_ESTIMATE = 44;
const COLUMN_COUNT = 12;

const formatMoney = (value: string | number | null): string | null => {
  if (value === null || value === undefined) return null;
  const num = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(num)) return null;
  return num.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/** Сумма зависит от вида оплаты: у оклада — месячная, у почасовой — ставка за час. */
const formatSalary = (row: IPayrollTermsRow): string => {
  if (!row.terms_id) return '—';
  const money = row.calc_type === 'salary' ? formatMoney(row.monthly_salary) : formatMoney(row.hourly_rate);
  if (money === null) return '—';
  return row.calc_type === 'salary' ? `${money} ₽/мес` : `${money} ₽/час`;
};

const formatMonthly = (row: IPayrollTermsRow, value: string | number | null): string => {
  const money = row.terms_id ? formatMoney(value) : null;
  return money === null ? '—' : `${money} ₽/мес`;
};

/** YYYY-MM-DD → ДД.ММ.ГГГГ, как даты в «Управлении кадрами». */
const formatDate = (value: string | null): string => {
  if (!value) return '—';
  const [year, month, day] = value.slice(0, 10).split('-');
  return year && month && day ? `${day}.${month}.${year}` : value;
};

/**
 * Таблица условий оплаты в стиле «Управления кадрами»: фиксированные колонки с переносом,
 * закреплённая шапка, виртуализация строк и догрузка порций при прокрутке.
 */
export const PayrollTermsTable: FC<IPayrollTermsTableProps> = memo(({
  rows,
  selected,
  allSelected,
  onToggleOne,
  onToggleAll,
  onEdit,
  onLoadMore,
  resetKey,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);

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

  return (
    <div className={styles.wrap} ref={scrollRef}>
      <table className={styles.table}>
        <colgroup>
          <col className={styles.colCheck} />
          <col className={styles.colNum} />
          <col className={styles.colName} />
          <col className={styles.colDept} />
          <col className={styles.colPosition} />
          <col className={styles.colSchedule} />
          <col className={styles.colMoney} />
          <col className={styles.colMoney} />
          <col className={styles.colMoney} />
          <col className={styles.colMoney} />
          <col className={styles.colDate} />
          <col className={styles.colAction} />
        </colgroup>
        <thead>
          <tr>
            <th className={`${styles.stickyCheck} ${styles.cellCheck}`}>
              <input
                type="checkbox"
                className={styles.check}
                aria-label="Выделить всех загруженных"
                checked={allSelected}
                onChange={onToggleAll}
              />
            </th>
            <th className={`${styles.stickyNum} ${styles.cellNum}`}>№</th>
            <th className={styles.stickyName}>Сотрудник</th>
            <th>Подразделение</th>
            <th>Должность</th>
            <th>График работы</th>
            <th>Оклад</th>
            <th>Премиальная часть</th>
            <th>Компенсация проживания</th>
            <th>Начисления за посл. полгода</th>
            <th>Действует с</th>
            <th aria-label="Действия" />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={COLUMN_COUNT} className={styles.empty}>Сотрудники не найдены</td>
            </tr>
          ) : (
            <>
              {topSpacer > 0 && (
                <tr aria-hidden="true" className={styles.spacer}>
                  <td colSpan={COLUMN_COUNT} style={{ height: topSpacer }} />
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
                  <tr
                    key={row.employee_id}
                    ref={virtualizer.measureElement}
                    data-index={item.index}
                    className={rowClass || undefined}
                  >
                    <td className={`${styles.stickyCheck} ${styles.cellCheck}`}>
                      <input
                        type="checkbox"
                        className={styles.check}
                        aria-label={`Выделить ${row.full_name ?? ''}`}
                        checked={isSelected}
                        onChange={() => onToggleOne(row.employee_id)}
                      />
                    </td>
                    <td className={`${styles.stickyNum} ${styles.cellNum}`}>{item.index + 1}</td>
                    <td className={`${styles.stickyName} ${styles.cellName}`}>
                      <span className={styles.clamp2}>{row.full_name ?? '—'}</span>
                    </td>
                    <td><span className={styles.clamp3}>{row.department_name ?? '—'}</span></td>
                    <td><span className={styles.clamp3}>{row.position_name ?? '—'}</span></td>
                    <td className={styles.cellOneLine} title={row.schedule_name ?? undefined}>
                      {row.schedule_name ?? '—'}
                    </td>
                    <td className={styles.cellNumber}>{formatSalary(row)}</td>
                    <td className={styles.cellNumber}>{formatMonthly(row, row.bonus_amount)}</td>
                    <td className={styles.cellNumber}>{formatMonthly(row, row.housing_compensation)}</td>
                    {/* Фактические начисления придут из 1С ЗУП — импорта пока нет. */}
                    <td className={styles.cellNumber}>—</td>
                    <td className={styles.cellNumber}>{formatDate(row.effective_from)}</td>
                    <td className={styles.cellAction}>
                      <button
                        type="button"
                        className={styles.linkButton}
                        onClick={() => onEdit(row)}
                      >
                        {row.terms_id ? 'Изменить' : 'Назначить'}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {bottomSpacer > 0 && (
                <tr aria-hidden="true" className={styles.spacer}>
                  <td colSpan={COLUMN_COUNT} style={{ height: bottomSpacer }} />
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
