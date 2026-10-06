import type { FC, MouseEvent } from 'react';

import type { IPayrollTermsRow } from '../../services/payrollService';
import { summarizeAccruals } from '../../utils/payrollAccruals';
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
 * Ячейка «Начисления»: итог за полгода. Клик открывает суммы по месяцам, а не карточку сотрудника.
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

  return (
    <button
      type="button"
      className={styles.button}
      aria-haspopup="dialog"
      aria-label={`Начисления за ${periodLabel}: ${total} ₽. Показать по месяцам`}
      onClick={handleClick}
    >
      <span className={styles.total}>{total} ₽</span>
    </button>
  );
};
