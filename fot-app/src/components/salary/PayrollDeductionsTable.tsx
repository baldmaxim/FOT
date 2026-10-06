import { memo, useEffect, useRef, type FC, type KeyboardEvent, type MouseEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown } from 'lucide-react';

import type { IPayrollDeductionKind, IPayrollTermsRow } from '../../services/payrollService';
import { formatDeductionKinds } from '../../utils/payrollDeductions';
import styles from './PayrollTermsTable.module.css';

interface IPayrollDeductionsTableProps {
  rows: IPayrollTermsRow[];
  kinds: IPayrollDeductionKind[];
  /** Право правки «Расчётов»; у строки ещё свой скоуп (can_edit). */
  canEdit: boolean;
  /** Смена фильтра: прокрутка возвращается наверх. */
  resetKey: string;
  /** Клик по ячейке «Удержание» — выпадающий список видов; anchor — кнопка ячейки. */
  onOpenKinds: (row: IPayrollTermsRow, anchor: HTMLElement) => void;
  /** Клик по строке — карточка «Подробно»; не передан — строки не кликабельны (нет права на условия). */
  onOpen?: (row: IPayrollTermsRow) => void;
}

/** Оценка до измерения: строка в одну линию ≈ 40px, переносы ФИО и подразделения — выше. */
const ROW_ESTIMATE = 44;
const COLUMN_COUNT = 5;

/**
 * «Расчёты»: весь штат, у каждого в столбце «Удержание» — его виды через запятую; клик открывает
 * выпадающий список с галочками. Вид таблицы — как у «Условий оплаты» (те же стили, закреплённая
 * шапка, № и ФИО, виртуализация), без чекбоксов, сортировок и шестерёнки.
 */
export const PayrollDeductionsTable: FC<IPayrollDeductionsTableProps> = memo(({
  rows,
  kinds,
  canEdit,
  resetKey,
  onOpenKinds,
  onOpen,
}) => {
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

  const openKinds = (event: MouseEvent<HTMLButtonElement>, row: IPayrollTermsRow) => {
    // Клик по ячейке открывает список, а не карточку.
    event.stopPropagation();
    onOpenKinds(row, event.currentTarget);
  };

  const handleRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, row: IPayrollTermsRow) => {
    // Только клавиши на самой строке: Enter на кнопке «Удержания» открывает список, а не карточку.
    if (!onOpen || event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpen(row);
    }
  };

  return (
    <div className={styles.wrap} ref={scrollRef}>
      <table className={`${styles.table} ${styles.tableNoCheck}`}>
        <colgroup>
          <col className={styles.colNum} />
          <col className={styles.colName} />
          <col className={styles.colDept} />
          <col className={styles.colPosition} />
          <col className={styles.colDeductions} />
        </colgroup>
        <thead>
          <tr>
            <th className={`${styles.stickyNum} ${styles.cellNum}`}>№</th>
            <th className={styles.stickyName}>Сотрудник</th>
            <th>Подразделение</th>
            <th>Должность</th>
            <th>Удержание</th>
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
                const label = formatDeductionKinds(row.deduction_kind_ids ?? [], kinds);
                const editable = canEdit && row.can_edit !== false;
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
                    <td><span className={styles.clamp3}>{row.position_name ?? '—'}</span></td>
                    <td className={styles.cellDeductions}>
                      {editable ? (
                        <button
                          type="button"
                          className={styles.kindsButton}
                          aria-haspopup="dialog"
                          aria-label={`Удержание: ${label || 'нет'}. Изменить`}
                          onClick={event => openKinds(event, row)}
                        >
                          <span className={`${styles.kindsValue} ${styles.clamp2}`}>{label || '—'}</span>
                          <ChevronDown size={14} className={styles.kindsChevron} aria-hidden="true" />
                        </button>
                      ) : (
                        <span className={`${styles.kindsText} ${styles.clamp2}`}>{label || '—'}</span>
                      )}
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

PayrollDeductionsTable.displayName = 'PayrollDeductionsTable';
