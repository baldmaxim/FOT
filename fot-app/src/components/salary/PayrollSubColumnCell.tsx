import type { FC } from 'react';
import { AlertTriangle } from 'lucide-react';

import type { IPayrollTermsRow } from '../../services/payrollService';
import { calcIssuesNote } from '../../utils/payrollCalcColumns';
import { formatPaidAmount } from '../../utils/payrollPaid';
import { subColumnAmount, type PayrollAmountSubColumn } from '../../utils/payrollSubColumns';
import styles from './PayrollTermsTable.module.css';

interface IPayrollSubColumnCellProps {
  sub: PayrollAmountSubColumn;
  row: IPayrollTermsRow;
}

/**
 * Ячейка раскрытого столбца: плановая или разовая доплата, вид удержания ФОТ — как прочие столбцы ФОТ («…» пока
 * считается, ⚠ неполного расчёта); статья удержаний 1С — просто сумма.
 */
export const PayrollSubColumnCell: FC<IPayrollSubColumnCellProps> = ({ sub, row }) => {
  const fromCalc = sub.type !== 'paid';
  if (fromCalc && row.calc_status) {
    return (
      <td className={styles.cellNumber}>
        {row.calc_status === 'pending' ? <span className={styles.calcMuted} aria-label="Считается">…</span> : '—'}
      </td>
    );
  }
  const amount = subColumnAmount(row, sub);
  const note = fromCalc ? calcIssuesNote(row.calc) : null;
  return (
    <td className={styles.cellNumber} title={note ?? undefined}>
      {amount === null ? '—' : formatPaidAmount(Number(amount))}
      {note && <AlertTriangle size={12} className={styles.calcWarn} role="img" aria-label={note} />}
    </td>
  );
};
