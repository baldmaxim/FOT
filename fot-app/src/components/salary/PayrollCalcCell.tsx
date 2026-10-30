import type { FC } from 'react';
import { AlertTriangle } from 'lucide-react';

import type { IPayrollTermsRow } from '../../services/payrollService';
import { formatDate } from '../../utils/formatMoney';
import {
  calcBrigadeOutputSub,
  calcIssuesNote,
  calcSumAmount,
  cardPayoutLines,
  cardPayoutsTotal,
  formatCalcRate,
  housingKindsLabel,
  isCalcColumn,
  overtimeNote,
  type PayrollCalcSumColumn,
} from '../../utils/payrollCalcColumns';
import { formatPaidAmount } from '../../utils/payrollPaid';
import styles from './PayrollTermsTable.module.css';

/** Столбцы состава зарплаты «Расчётов»: ФОТ по табелю и суммы 1С (payrollCalcColumns.ts). */
export type PayrollCalcCellColumn =
  | PayrollCalcSumColumn | 'calc_rate' | 'paid_recalc' | 'card_payouts';

interface IPayrollCalcCellProps {
  column: PayrollCalcCellColumn;
  row: IPayrollTermsRow;
}

const formatAmount = (value: string | null | undefined): string => (
  value === null || value === undefined ? '—' : formatPaidAmount(Number(value))
);

/**
 * Ячейка состава зарплаты. Закрыт табель или нет — не помечается. В столбцах ФОТ неполный месяц — ⚠ с подсказкой
 * «месяц — причина» (почасовая ставка, нет условий или нормы, нет учтённых часов или ошибка бригады): сумма
 * частичная, «Сумма» — «—». Выработка бригады не введена — без ⚠: подпись «выработка не внесена» под «Начислено по
 * табелю» и «Суммой».
 */
export const PayrollCalcCell: FC<IPayrollCalcCellProps> = ({ column, row }) => {
  // Столбцы ФОТ считаются отдельным запросом после строк: идёт — «…», не удалось — «—» (над таблицей «Повторить»).
  if (row.calc_status && isCalcColumn(column)) {
    return (
      <td className={styles.cellNumber}>
        {row.calc_status === 'pending' ? <span className={styles.calcMuted} aria-label="Считается">…</span> : '—'}
      </td>
    );
  }
  switch (column) {
    case 'calc_rate': {
      const rate = row.calc?.rate ?? null;
      return (
        <td className={styles.cellNumber} title={rate ? `на ${formatDate(rate.as_of)}` : undefined}>
          {formatCalcRate(rate)}
        </td>
      );
    }
    case 'paid_recalc':
      return <td className={styles.cellNumber}>{formatAmount(row.paid_recalc_prev)}</td>;
    case 'card_payouts': {
      const lines = cardPayoutLines(row.card_payouts_by_method);
      const total = cardPayoutsTotal(lines);
      return (
        <td className={styles.cellNumber}>
          {lines.length === 0 ? '—' : lines.map(line => (
            <span key={line.method} className={styles.calcLine}>
              <span className={styles.calcLineLabel}>{line.label}</span>
              {formatAmount(line.amount)}
            </span>
          ))}
          {total !== null && (
            <span className={`${styles.calcLine} ${styles.calcTotal}`}>
              <span className={styles.calcLineLabel}>Итого</span>
              {formatAmount(total)}
            </span>
          )}
        </td>
      );
    }
    default: {
      const note = calcIssuesNote(row.calc);
      const amount = calcSumAmount(row, column);
      // Выработка бригады не введена — подпись под «Начислено по табелю» и «Суммой» (без ⚠).
      const outputSub = column === 'calc_timesheet' || column === 'calc_net' ? calcBrigadeOutputSub(row.calc) : null;
      // Вторая строка: выработка не внесена, вид проживания, из чего переработка.
      const sub = outputSub ?? (amount === null ? null
        : column === 'calc_housing' ? housingKindsLabel(row.calc)
          : column === 'calc_overtime' ? overtimeNote(row.calc) : null);
      return (
        <td
          className={column === 'calc_net' ? `${styles.cellNumber} ${styles.calcTotal}` : styles.cellNumber}
          title={note ?? undefined}
        >
          {formatAmount(amount)}
          {note && <AlertTriangle size={12} className={styles.calcWarn} role="img" aria-label={note} />}
          {sub && <span className={styles.calcSub}>{sub}</span>}
        </td>
      );
    }
  }
};
