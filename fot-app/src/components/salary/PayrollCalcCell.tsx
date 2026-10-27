import type { FC } from 'react';
import { AlertTriangle } from 'lucide-react';

import type { IPayrollTermsRow } from '../../services/payrollService';
import { formatDate } from '../../utils/formatMoney';
import {
  calcIssuesNote,
  calcNotClosed,
  calcSumAmount,
  cardPayoutLines,
  formatCalcRate,
  housingKindsLabel,
  type PayrollCalcSumColumn,
} from '../../utils/payrollCalcColumns';
import { formatPaidAmount } from '../../utils/payrollPaid';
import styles from './PayrollTermsTable.module.css';

/** Столбцы состава зарплаты «Расчётов»: ФОТ по закрытому табелю и суммы 1С (payrollCalcColumns.ts). */
export type PayrollCalcCellColumn =
  | PayrollCalcSumColumn | 'calc_rate' | 'paid_vacation' | 'paid_sick' | 'paid_recalc' | 'card_payouts';

interface IPayrollCalcCellProps {
  column: PayrollCalcCellColumn;
  row: IPayrollTermsRow;
}

const formatAmount = (value: string | null | undefined): string => (
  value === null || value === undefined ? '—' : formatPaidAmount(Number(value))
);

/**
 * Ячейка состава зарплаты. В столбцах ФОТ незакрытый или неполный месяц — ⚠ с подсказкой «месяц — причина»:
 * сумма частичная или её нет; «Начислено по табелю» без суммы при незакрытом табеле — «не закрыт».
 */
export const PayrollCalcCell: FC<IPayrollCalcCellProps> = ({ column, row }) => {
  switch (column) {
    case 'calc_rate': {
      const rate = row.calc?.rate ?? null;
      return (
        <td className={styles.cellNumber} title={rate ? `на ${formatDate(rate.as_of)}` : undefined}>
          {formatCalcRate(rate)}
        </td>
      );
    }
    case 'paid_vacation':
      return <td className={styles.cellNumber}>{formatAmount(row.paid_vacation)}</td>;
    case 'paid_sick':
      return <td className={styles.cellNumber}>{formatAmount(row.paid_sick_leave)}</td>;
    case 'paid_recalc':
      return <td className={styles.cellNumber}>{formatAmount(row.paid_recalc_prev)}</td>;
    case 'card_payouts': {
      const lines = cardPayoutLines(row.card_payouts);
      return (
        <td className={styles.cellNumber}>
          {lines.length === 0 ? '—' : lines.map(line => (
            <span key={line.label} className={styles.calcLine}>
              <span className={styles.calcLineLabel}>{line.label}</span>
              {formatAmount(line.amount)}
            </span>
          ))}
        </td>
      );
    }
    default: {
      const note = calcIssuesNote(row.calc);
      const amount = calcSumAmount(row, column);
      const notClosed = column === 'calc_timesheet' && amount === null && calcNotClosed(row.calc);
      const kinds = column === 'calc_housing' && amount !== null ? housingKindsLabel(row.calc) : null;
      return (
        <td className={styles.cellNumber} title={note ?? undefined}>
          {notClosed ? <span className={styles.calcMuted}>не закрыт</span> : formatAmount(amount)}
          {note && !notClosed && <AlertTriangle size={12} className={styles.calcWarn} role="img" aria-label={note} />}
          {kinds && <span className={styles.calcSub}>{kinds}</span>}
        </td>
      );
    }
  }
};
