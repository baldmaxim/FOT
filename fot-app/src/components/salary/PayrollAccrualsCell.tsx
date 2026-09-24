import type { FC, MouseEvent } from 'react';

import type { IPayrollTermsRow } from '../../services/payrollService';
import { accrualBarPercent, summarizeAccruals } from '../../utils/payrollAccruals';
import { formatPayrollRubles } from '../../utils/payrollFormat';
import styles from './PayrollAccrualsCell.module.css';

interface IPayrollAccrualsCellProps {
  row: IPayrollTermsRow;
  /** Месяцы окна (YYYY-MM) по порядку. */
  months: string[];
  /** Период для экранного диктора: «март – август 2026». */
  periodLabel: string;
  onOpen: (row: IPayrollTermsRow, anchor: HTMLElement) => void;
}

/**
 * Ячейка «Начисления»: итог за полгода и мини-график по месяцам (масштаб — максимум строки,
 * последний месяц — акцентом). Клик открывает суммы по месяцам, а не карточку сотрудника.
 */
export const PayrollAccrualsCell: FC<IPayrollAccrualsCellProps> = ({ row, months, periodLabel, onOpen }) => {
  const summary = summarizeAccruals(months, row.accruals);
  const total = formatPayrollRubles(summary.total);
  // Данных нет ни за один месяц — открывать нечего, клик работает как клик по строке.
  if (total === null) return <span className={styles.empty}>—</span>;

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onOpen(row, event.currentTarget);
  };

  const lastIndex = summary.values.length - 1;

  return (
    <button
      type="button"
      className={styles.button}
      aria-haspopup="dialog"
      aria-label={`Начисления за ${periodLabel}: ${total} ₽. Показать по месяцам`}
      onClick={handleClick}
    >
      <span className={styles.total}>{total} ₽</span>
      <span className={styles.spark} aria-hidden="true">
        {summary.values.map((value, index) => {
          const percent = accrualBarPercent(value, summary.max);
          return (
            <span key={months[index]} className={styles.slot}>
              {percent > 0 && (
                <span
                  className={index === lastIndex ? `${styles.bar} ${styles.barLast}` : styles.bar}
                  style={{ height: `${percent}%` }}
                />
              )}
            </span>
          );
        })}
      </span>
    </button>
  );
};
