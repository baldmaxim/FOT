import type { FC } from 'react';
import { useQuery } from '@tanstack/react-query';

import type { IEmployeePayout1c } from '../../services/payroll1cPayoutsService';
import { payrollService } from '../../services/payrollService';
import { isCalcCounted, payslipRemainder } from '../../utils/payrollCalc';
import { formatPaidAmount, paidPayout, type PayrollPaidTotals } from '../../utils/payrollPaid';
import { payslipRateLines } from '../../utils/payrollPayslip';
import { PayslipCalcSection } from './PayslipCalcSection';
import { PayslipDebtSection } from './PayslipDebtSection';
import disclosure from './PayrollDisclosure.module.css';
import styles from './PaidPayslip.module.css';

interface IPaidPayslipProps {
  employeeId: number;
  month: string;
  amounts: ReadonlyMap<string, number>;
  totals: PayrollPaidTotals;
  /** Ведомости выплаты 1С за месяц начисления и их сумма (справочно, миграция 328); null — ведомостей нет. */
  transfers: readonly IEmployeePayout1c[];
  transferred: number | null;
  /** Ведомости не загрузились — «Остаток» не считается (иначе весь ФОТ выглядел бы остатком). */
  transfersFailed: boolean;
}

const formatTotal = (value: number | null): string => (value === null ? '—' : formatPaidAmount(value));

/** YYYY-MM-DD → ДД.ММ.ГГГГ. */
const formatDocDate = (date: string): string => date.split('-').reverse().join('.');

/**
 * Выбранный месяц вкладки «Зарплата» — расчётный листок, порядок как в «Условиях» (расчёт над выплаченным):
 *  - «Расчёт ФОТ» по табелю, закрыт он или нет (PayslipCalcSection) — с формулами и столбцом «1С»: в нём все статьи
 *    «Оплачено» месяца (без пары в ФОТ — своими строками); расчёта нет — таблица из строк 1С. Отдельных таблиц 1С
 *    («Начислено за N дней», «Удержано») нет (решение 30.10.2026). Старый бэкенд без расчёта — блок «По ставкам ФОТ»;
 *  - долги прошлых месяцев из ведомости бригады (PayslipDebtSection) — расшифровка строки «Погашение долгов»;
 *  - «Перечислено (1С)» — ведомости выплаты за месяц начисления (дата ведомости бывает уже в следующем месяце);
 *  - «Остаток (с НДФЛ)» — итог ФОТ минус перечисленное: НДФЛ в итоге ФОТ не вычтен, поэтому он сидит в остатке.
 */
export const PaidPayslip: FC<IPaidPayslipProps> = ({
  employeeId, month, amounts, totals, transfers, transferred, transfersFailed,
}) => {
  const payslipQuery = useQuery({
    // Под префиксом 'payroll-terms': сохранение карточки перечитывает и листок (оклад).
    queryKey: ['payroll-terms', 'payslip', employeeId, month],
    queryFn: ({ signal }) => payrollService.getPayslip(employeeId, month, signal),
    staleTime: 30_000,
  });
  const info = payslipQuery.data;
  const rateLines = payslipRateLines(info?.rate_allowances);
  const calc = info?.calc;
  const hasPaid = totals.accrued !== null || totals.deducted !== null;
  const remainder = payslipRemainder(calc, transfersFailed ? 'error' : transferred ?? 0);

  return (
    <div className={styles.payslip}>
      {/* Суммы 1С есть — блок и без расчёта ФОТ (старый бэкенд, ошибка листка): их строками. */}
      {(payslipQuery.isPending || calc || hasPaid) && (
        <PayslipCalcSection
          month={month}
          loading={payslipQuery.isPending}
          calc={calc}
          schedules={info?.schedules}
          amounts={amounts}
          accrued1c={totals.accrued}
          deducted1c={totals.deducted}
          payout1c={hasPaid ? paidPayout(totals) : null}
        />
      )}
      {payslipQuery.isError && (
        <div className={`${disclosure.stateError} ${styles.note}`}>
          <span>Не удалось загрузить листок</span>
          <button type="button" className={disclosure.retryButton} onClick={() => { void payslipQuery.refetch(); }}>
            Повторить
          </button>
        </div>
      )}

      {info && !calc && rateLines.length > 0 && (
        <section className={styles.part} aria-label="По ставкам ФОТ">
          <p className={styles.partTitle}>По ставкам ФОТ</p>
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
                {rateLines.map(line => (
                  <tr key={line.code}>
                    <th scope="row" className={styles.kind}>
                      <span className={styles.kindName}>{line.label}</span>
                      {line.note && <span className={styles.kindNote}>{line.note}</span>}
                    </th>
                    <td className={styles.num}>{formatPaidAmount(line.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <PayslipDebtSection employeeId={employeeId} month={month} />

      {transfers.length > 0 && (
        <section className={styles.part} aria-label="Перечислено (1С)">
          <p className={styles.partTitle}>Перечислено (1С)</p>
          <div className={styles.scroll}>
            <table className={styles.table}>
              <colgroup>
                <col className={styles.dateCol} />
                <col />
                <col className={styles.sumCol} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Дата</th>
                  <th scope="col">Ведомость</th>
                  <th scope="col" className={styles.num}>Сумма</th>
                </tr>
              </thead>
              <tbody>
                {transfers.map((doc, index) => (
                  <tr key={`${doc.document_id}-${index}`}>
                    <td className={styles.nowrap}>{formatDocDate(doc.doc_date)}</td>
                    <th scope="row" className={styles.kind}>
                      <span className={styles.kindName}>№ {doc.doc_number}</span>
                      <span className={styles.kindNote}>{doc.payment_method}</span>
                    </th>
                    <td className={styles.num}>{formatPaidAmount(Number(doc.amount))}</td>
                  </tr>
                ))}
              </tbody>
              {transfers.length > 1 && (
                <tfoot>
                  <tr>
                    <th scope="row" colSpan={2}>Всего перечислено</th>
                    <td className={styles.num}>{formatTotal(transferred)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </section>
      )}

      {isCalcCounted(calc) && (
        <section className={styles.part} aria-label="Остаток">
          <div className={styles.scroll}>
            <table className={`${styles.table} ${styles.remainderTable}`}>
              <colgroup>
                <col />
                <col className={styles.sumCol} />
              </colgroup>
              <tfoot>
                <tr>
                  <th scope="row">Остаток (с НДФЛ)</th>
                  <td className={styles.num}>{formatTotal(remainder)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      )}

    </div>
  );
};
