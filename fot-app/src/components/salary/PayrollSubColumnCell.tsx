import type { FC } from 'react';
import { AlertTriangle } from 'lucide-react';

import type { IPayrollTermsRow } from '../../services/payrollService';
import { calcIssuesNote } from '../../utils/payrollCalcColumns';
import { cx } from '../../utils/motion';
import { formatPaidAmount } from '../../utils/payrollPaid';
import { subColumnAmount, type PayrollAmountSubColumn } from '../../utils/payrollSubColumns';
import styles from './PayrollTermsTable.module.css';

interface IPayrollSubColumnCellProps {
  sub: PayrollAmountSubColumn;
  row: IPayrollTermsRow;
  /** Оформление группы «+» (линии), PayrollTermsTable. */
  className?: string;
}

/**
 * Ячейка раскрытого столбца: плановая или разовая доплата, вид удержания ФОТ — как прочие столбцы ФОТ («…» пока
 * считается, ⚠ неполного расчёта); статья удержаний 1С — просто сумма.
 */
export const PayrollSubColumnCell: FC<IPayrollSubColumnCellProps> = ({ sub, row, className }) => {
  const cellClass = cx(styles.cellNumber, className);
  const fromCalc = sub.type !== 'paid';
  if (fromCalc && row.calc_status) {
    return (
      <td className={cellClass}>
        {row.calc_status === 'pending' ? <span className={styles.calcMuted} aria-label="Считается">…</span> : '—'}
      </td>
    );
  }
  const amount = subColumnAmount(row, sub);
  const note = fromCalc ? calcIssuesNote(row.calc) : null;
  return (
    <td className={cellClass} title={note ?? undefined}>
      {amount === null ? '—' : formatPaidAmount(Number(amount))}
      {note && <AlertTriangle size={12} className={styles.calcWarn} role="img" aria-label={note} />}
    </td>
  );
};
