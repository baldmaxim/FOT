import { memo, useEffect, useRef, type FC, type KeyboardEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import type { IPayrollTermsRow } from '../../services/payrollService';
import styles from './PayrollTermsTable.module.css';

interface IPayrollDeductionsTableProps {
  rows: IPayrollTermsRow[];
  /** Подпись месяца под заголовком «Сумма»: «сентябрь 2026». */
  monthLabel: string;
  /** Смена фильтра: прокрутка возвращается наверх. */
  resetKey: string;
  /** Клик по строке — карточка «Подробно»; не передан — строки не кликабельны (нет права на условия). */
  onOpen?: (row: IPayrollTermsRow) => void;
}

/** Оценка до измерения: строка в одну линию ≈ 40px, переносы ФИО и подразделения — выше. */
const ROW_ESTIMATE = 44;
const COLUMN_COUNT = 4;

/**
 * «Расчёты»: сотрудники с выбранными удержаниями — ФИО, подразделение и сумма за месяц.
 * Суммы придут из 1С, пока в столбце «—». Вид таблицы — как у «Условий оплаты» (те же стили,
 * закреплённая шапка, № и ФИО, виртуализация), без чекбоксов, сортировок и шестерёнки.
 */
export const PayrollDeductionsTable: FC<IPayrollDeductionsTableProps> = memo(({ rows, monthLabel, resetKey, onOpen }) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE,
    getItemKey: index => rows[index]?.employee_id ?? index,
    overscan: 15,
  });

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [resetKey]);

  const virtualItems = virtualizer.getVirtualItems();
  const topSpacer = virtualItems[0]?.start ?? 0;
  const lastItem = virtualItems[virtualItems.length - 1];
  const bottomSpacer = lastItem ? virtualizer.getTotalSize() - lastItem.end : 0;

  const handleRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, row: IPayrollTermsRow) => {
    if (!onOpen || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    onOpen(row);
  };

  return (
    <div className={styles.wrap} ref={scrollRef}>
      <table className={`${styles.table} ${styles.tableNoCheck}`}>
        <colgroup>
          <col className={styles.colNum} />
          <col className={styles.colName} />
          <col className={styles.colDept} />
          <col className={styles.colSum} />
        </colgroup>
        <thead>
          <tr>
            <th className={`${styles.stickyNum} ${styles.cellNum}`}>№</th>
            <th className={styles.stickyName}>Сотрудник</th>
            <th>Подразделение</th>
            <th>
              Сумма
              <span className={styles.headPeriod}>{monthLabel}</span>
            </th>
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
                const rowClass = [onOpen ? styles.rowClickable : '', item.index % 2 === 1 ? styles.rowEven : '']
                  .filter(Boolean).join(' ');
                return (
                  <tr
                    key={row.employee_id}
                    ref={virtualizer.measureElement}
                    data-index={item.index}
                    className={rowClass || undefined}
                    tabIndex={onOpen ? 0 : undefined}
                    aria-label={onOpen ? `Условия оплаты: ${row.full_name ?? 'сотрудник'}` : undefined}
                    onClick={onOpen ? () => onOpen(row) : undefined}
                    onKeyDown={onOpen ? event => handleRowKeyDown(event, row) : undefined}
                  >
                    <td className={`${styles.stickyNum} ${styles.cellNum}`}>{item.index + 1}</td>
                    <td className={`${styles.stickyName} ${styles.cellName}`}>
                      <span className={styles.clamp2}>{row.full_name ?? '—'}</span>
                    </td>
                    <td><span className={styles.clamp3}>{row.department_name ?? '—'}</span></td>
                    {/* Суммы удержаний за месяц придут из 1С. */}
                    <td className={styles.cellNumber}>—</td>
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

PayrollDeductionsTable.displayName = 'PayrollDeductionsTable';
