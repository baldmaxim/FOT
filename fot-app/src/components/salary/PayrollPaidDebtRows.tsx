import type { FC } from 'react';

import type { IPayrollPaidDebt } from '../../services/payrollPaidDebtsService';
import { formatPaidAmount } from '../../utils/payrollPaid';
import {
  PAID_DEBT_CARRIED_LABEL,
  PAID_DEBT_REPAID_LABEL,
  PAID_DEBT_WRITTEN_OFF_LABEL,
  paidDebtMonth,
  PAYROLL_PAID_DEBT_KINDS,
  type IPaidDebtMonth,
} from '../../utils/payrollPaidDebts';
import styles from './PayrollPaidTable.module.css';

interface IPayrollPaidDebtRowsProps {
  months: readonly string[];
  debts: readonly IPayrollPaidDebt[];
  /** Справа столбец «Итого» (несколько месяцев) — у долгов пустой: сумма по месяцам задвоила бы перенос. */
  withTotal: boolean;
}

const formatValue = (value: number | null | undefined): string => (value == null ? '—' : formatPaidAmount(value));

/**
 * Раскрытая таблица «Подробно», под статьями: «Долги прошлых месяцев (справочно)» из ведомостей бригад — виды
 * долга, закрыто документом 1С, перенесено на следующий месяц и «Погашено из зарплаты месяца». Расшифровка статьи
 * «Погашение долгов прошлых месяцев» в «Удержано» — в «Выплачено» второй раз не входит. Строк нет — блока нет.
 */
export const PayrollPaidDebtRows: FC<IPayrollPaidDebtRowsProps> = ({ months, debts, withTotal }) => {
  const byMonth = new Map(months.map(month => [month, paidDebtMonth(debts, month)]));
  const present = [...byMonth.values()].filter((item): item is IPaidDebtMonth => item !== null);
  if (present.length === 0) return null;

  const kinds = PAYROLL_PAID_DEBT_KINDS.filter(kind => present.some(item => item.kinds.some(line => line.code === kind.code)));
  const renderRow = (key: string, label: string, value: (item: IPaidDebtMonth) => number | null | undefined) => (
    <tr key={key}>
      <th scope="row" className={`${styles.rowHead} ${styles.rowHeadNested}`}>{label}</th>
      {months.map(month => {
        const item = byMonth.get(month);
        return <td key={month} className={styles.value}>{item ? formatValue(value(item)) : '—'}</td>;
      })}
      {withTotal && <td className={styles.value} />}
    </tr>
  );

  return (
    <tbody>
      <tr>
        <th scope="rowgroup" colSpan={months.length + (withTotal ? 2 : 1)} className={styles.groupHead}>
          <span className={styles.groupLabel}>Долги прошлых месяцев (справочно)</span>
        </th>
      </tr>
      {kinds.map(kind => renderRow(kind.code, kind.label, item => item.kinds.find(line => line.code === kind.code)?.amount))}
      {present.some(item => item.writtenOff !== null) && renderRow('written_off', PAID_DEBT_WRITTEN_OFF_LABEL, item => item.writtenOff)}
      {present.some(item => item.carriedForward !== null)
        && renderRow('carried_forward', PAID_DEBT_CARRIED_LABEL, item => item.carriedForward)}
      {renderRow('repaid', PAID_DEBT_REPAID_LABEL, item => item.repaid)}
    </tbody>
  );
};
