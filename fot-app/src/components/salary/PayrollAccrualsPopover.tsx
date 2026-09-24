import { useEffect, useId, useLayoutEffect, useRef, useState, type FC } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

import type { IPayrollTermsRow } from '../../services/payrollService';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import {
  accrualBarPercent,
  accrualPeriodCrossesYear,
  formatAccrualMonthLabel,
  formatAccrualPeriodLong,
  summarizeAccruals,
} from '../../utils/payrollAccruals';
import { formatPayrollMoney } from '../../utils/payrollFormat';
import styles from './PayrollAccrualsPopover.module.css';

interface IPayrollAccrualsPopoverProps {
  row: IPayrollTermsRow;
  /** Месяцы окна (YYYY-MM) по порядку. */
  months: string[];
  /** Кнопка ячейки: окно открывается под ней, а если снизу не помещается — над ней. */
  anchor: HTMLElement;
  onClose: () => void;
}

/** Ширина окна — в CSS (.popover), здесь нужна для выравнивания по правому краю ячейки. */
const POPOVER_WIDTH = 340;
const ANCHOR_GAP = 6;
const VIEWPORT_EDGE = 8;
/** Смартфон — лист снизу, как у фильтра столбца. */
const SHEET_MEDIA = '(max-width: 768px)';

const formatAmount = (value: number | null): string => {
  const money = formatPayrollMoney(value);
  return money === null ? '—' : `${money} ₽`;
};

/**
 * Начисления сотрудника по месяцам — табличная расшифровка мини-графика ячейки: точные
 * суммы, итог и среднее. Закрытие — Escape, клик мимо или крестик.
 */
export const PayrollAccrualsPopover: FC<IPayrollAccrualsPopoverProps> = ({ row, months, anchor, onClose }) => {
  const titleId = useId();
  const dismiss = useOverlayDismiss(onClose);
  const popoverRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [isSheet] = useState(() => window.matchMedia(SHEET_MEDIA).matches);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Позиция считается один раз при открытии: окно модальное, таблица под ним не прокручивается.
  // Высота окна известна только после вёрстки — замер до первой отрисовки, без мигания.
  useLayoutEffect(() => {
    const popover = popoverRef.current;
    if (!popover) return;
    if (!isSheet) {
      const rect = anchor.getBoundingClientRect();
      const height = popover.offsetHeight;
      const viewportBottom = window.innerHeight - VIEWPORT_EDGE;
      const below = rect.bottom + ANCHOR_GAP;
      const above = rect.top - ANCHOR_GAP - height;
      const top = below + height <= viewportBottom || above < VIEWPORT_EDGE
        ? Math.max(VIEWPORT_EDGE, Math.min(below, viewportBottom - height))
        : above;
      const left = Math.max(VIEWPORT_EDGE, Math.min(rect.right - POPOVER_WIDTH, window.innerWidth - POPOVER_WIDTH - VIEWPORT_EDGE));
      popover.style.top = `${top}px`;
      popover.style.left = `${left}px`;
    }
    closeRef.current?.focus();
  }, [anchor, isSheet]);

  const summary = summarizeAccruals(months, row.accruals);
  const withYear = accrualPeriodCrossesYear(months);
  const period = formatAccrualPeriodLong(months);
  const lastIndex = months.length - 1;
  const averageLabel = summary.monthsWithData === months.length
    ? 'В среднем за месяц'
    : `В среднем за ${summary.monthsWithData} мес.`;

  return createPortal(
    <>
      <div className={styles.backdrop} {...dismiss} />
      <div
        ref={popoverRef}
        className={isSheet ? `${styles.popover} ${styles.sheet}` : styles.popover}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className={styles.header}>
          <div className={styles.heading}>
            <div id={titleId} className={styles.title}>{row.full_name ?? 'Сотрудник'}</div>
            <div className={styles.subtitle}>Начислено за {period}</div>
          </div>
          <button ref={closeRef} type="button" className={styles.close} aria-label="Закрыть" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <table className={styles.table} aria-label={`Начисления по месяцам, ${period}`}>
          <tbody>
            {months.map((month, index) => {
              const value = summary.values[index];
              const percent = accrualBarPercent(value, summary.max);
              return (
                <tr key={month}>
                  <th scope="row" className={styles.month}>{formatAccrualMonthLabel(month, withYear)}</th>
                  <td className={value === null ? `${styles.amount} ${styles.muted}` : styles.amount}>
                    {formatAmount(value)}
                  </td>
                  <td className={styles.barCell} aria-hidden="true">
                    {percent > 0 && (
                      <span
                        className={index === lastIndex ? `${styles.bar} ${styles.barLast}` : styles.bar}
                        style={{ width: `${percent}%` }}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className={styles.totalRow}>
              <th scope="row" className={styles.month}>Итого</th>
              <td className={styles.amount}>{formatAmount(summary.total)}</td>
              <td aria-hidden="true" />
            </tr>
            <tr className={styles.averageRow}>
              <th scope="row" className={styles.month}>{averageLabel}</th>
              <td className={styles.amount}>{formatAmount(summary.average)}</td>
              <td aria-hidden="true" />
            </tr>
          </tfoot>
        </table>
      </div>
    </>,
    document.body,
  );
};
