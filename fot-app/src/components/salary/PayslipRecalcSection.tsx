import { Fragment, useState, type FC } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { payrollRecalcQueryOptions } from '../../hooks/usePayrollPaid';
import { payrollService } from '../../services/payrollService';
import { formatAccrualMonthLabel } from '../../utils/payrollAccruals';
import { formatPaidAmount } from '../../utils/payrollPaid';
import { recalcTermsNotes, recalcTotalView } from '../../utils/payrollRecalc';
import disclosure from './PayrollDisclosure.module.css';
import payslip from './PaidPayslip.module.css';
import styles from './PayslipRecalcSection.module.css';

interface IPayslipRecalcSectionProps {
  employeeId: number;
}

const formatSum = (amount: string | null): string => (amount === null ? '—' : formatPaidAmount(Number(amount)));

/**
 * Блок «Пересчёт» вкладки «Зарплата»: сколько доплатить после правки оклада задним числом. Месяцы, выплаченные до
 * правки: итог по прежним условиям, по текущим и разница; месяцы и «Стало» те же, что в левой таблице. Один на
 * сотрудника: при выборе другого месяца не меняется. Правок нет или загрузка не удалась — блока нет. Доплата сама
 * в расчёт следующего месяца не идёт: прошлые месяцы уже считаются по новому окладу.
 */
export const PayslipRecalcSection: FC<IPayslipRecalcSectionProps> = ({ employeeId }) => {
  const queryClient = useQueryClient();
  const recalcQuery = useQuery(payrollRecalcQueryOptions(employeeId));
  const [confirming, setConfirming] = useState(false);
  const recalc = recalcQuery.data;

  const settleMutation = useMutation({
    mutationFn: (recordIds: readonly number[]) => payrollService.settleRecalc(employeeId, recordIds),
    onSuccess: async () => {
      setConfirming(false);
      await queryClient.invalidateQueries({ queryKey: payrollRecalcQueryOptions(employeeId).queryKey });
    },
  });

  if (!recalc || recalc.months.length === 0) return null;
  const total = recalcTotalView(recalc.total);

  return (
    <div className={payslip.payslip}>
      <section className={payslip.part} aria-label="Пересчёт">
        <p className={payslip.partTitle}>Пересчёт</p>
        <div className={payslip.scroll}>
          <table className={`${payslip.table} ${styles.table}`}>
            <colgroup>
              <col />
              <col className={styles.sumCol} />
              <col className={styles.sumCol} />
              <col className={styles.sumCol} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Месяц</th>
                <th scope="col" className={payslip.num}>Было</th>
                <th scope="col" className={payslip.num}>Стало</th>
                <th scope="col" className={payslip.num}>Доплата</th>
              </tr>
            </thead>
            <tbody>
              {recalc.months.map(row => {
                const notes = recalcTermsNotes(row.terms_from, row.terms_to);
                return (
                  <Fragment key={row.month}>
                    <tr className={notes.length > 0 ? styles.withNote : undefined}>
                      <th scope="row" className={payslip.kind}>{formatAccrualMonthLabel(row.month, true)}</th>
                      <td className={payslip.num}>{formatSum(row.was)}</td>
                      <td className={payslip.num}>{formatSum(row.became)}</td>
                      <td className={payslip.num}>{formatSum(row.difference)}</td>
                    </tr>
                    {notes.length > 0 && (
                      // Подпись во всю ширину: в столбце месяца на телефоне она рвалась бы на пять строк.
                      <tr>
                        <td colSpan={4} className={styles.note}>
                          {notes.map(note => <span key={note} className={payslip.kindNote}>{note}</span>)}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={3}>{total.label}</th>
                <td className={payslip.num}>{formatPaidAmount(total.amount)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        {recalc.can_settle && (
          <div className={styles.actions}>
            {confirming ? (
              <>
                <span className={styles.question}>{total.question}</span>
                <button
                  type="button"
                  className={styles.primary}
                  disabled={settleMutation.isPending}
                  onClick={() => settleMutation.mutate(recalc.record_ids)}
                >
                  Да
                </button>
                <button
                  type="button"
                  className={styles.secondary}
                  disabled={settleMutation.isPending}
                  onClick={() => { setConfirming(false); settleMutation.reset(); }}
                >
                  Отмена
                </button>
              </>
            ) : (
              <button type="button" className={styles.secondary} onClick={() => setConfirming(true)}>
                {total.action}
              </button>
            )}
          </div>
        )}
        {settleMutation.isError && (
          <p className={`${disclosure.stateError} ${styles.error}`} role="alert">
            {settleMutation.error.message || 'Не удалось отметить доплату'}
          </p>
        )}
      </section>
    </div>
  );
};
