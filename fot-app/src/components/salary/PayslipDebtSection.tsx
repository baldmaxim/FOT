import type { FC } from 'react';
import { useQuery } from '@tanstack/react-query';

import { paidDebtsQueryOptions } from '../../hooks/usePayrollPaid';
import { formatPaidAmount } from '../../utils/payrollPaid';
import {
  PAID_DEBT_CARRIED_LABEL,
  PAID_DEBT_REPAID_LABEL,
  PAID_DEBT_WRITTEN_OFF_LABEL,
  paidDebtMonth,
} from '../../utils/payrollPaidDebts';
import styles from './PaidPayslip.module.css';

interface IPayslipDebtSectionProps {
  employeeId: number;
  month: string;
}

/**
 * Расчётный листок «Истории выплат»: «Долги прошлых месяцев (справочно)» из ведомости бригады — виды долга,
 * закрыто документом 1С, перенесено на следующий месяц и итог «Погашено из зарплаты месяца». Расшифровка строки
 * «Погашение долгов прошлых месяцев» в «Удержано» — второй раз в итоги не входит. Строк нет (или не загрузились) — раздела нет.
 */
export const PayslipDebtSection: FC<IPayslipDebtSectionProps> = ({ employeeId, month }) => {
  const debtsQuery = useQuery(paidDebtsQueryOptions(employeeId, month, month));
  const debt = debtsQuery.data ? paidDebtMonth(debtsQuery.data, month) : null;
  if (!debt) return null;

  return (
    <section className={styles.part} aria-label="Долги прошлых месяцев">
      <p className={styles.partTitle}>Долги прошлых месяцев (справочно)</p>
      <div className={styles.scroll}>
        <table className={styles.table}>
          <colgroup>
            <col />
            <col className={styles.sumCol} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Вид</th>
              <th scope="col" className={styles.num}>Сумма</th>
            </tr>
          </thead>
          <tbody>
            {debt.kinds.map(kind => (
              <tr key={kind.code}>
                <th scope="row" className={styles.kind}>{kind.label}</th>
                <td className={styles.num}>{formatPaidAmount(kind.amount)}</td>
              </tr>
            ))}
            {debt.writtenOff !== null && (
              <tr>
                <th scope="row" className={styles.kind}>{PAID_DEBT_WRITTEN_OFF_LABEL}</th>
                <td className={styles.num}>{formatPaidAmount(debt.writtenOff)}</td>
              </tr>
            )}
            {debt.carriedForward !== null && (
              <tr>
                <th scope="row" className={styles.kind}>{PAID_DEBT_CARRIED_LABEL}</th>
                <td className={styles.num}>{formatPaidAmount(debt.carriedForward)}</td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">{PAID_DEBT_REPAID_LABEL}</th>
              <td className={styles.num}>{debt.repaid === null ? '—' : formatPaidAmount(debt.repaid)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
};
