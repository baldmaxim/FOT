import type { FC } from 'react';

import type { IEmployeePayslipLine, IEmployeePayslipReady } from '../../services/employeePayslipService';
import {
  accruedTitle,
  formatPayslipAmount,
  formatPayslipRate,
  payoutLabel,
  payslipLineLabel,
} from '../../utils/employeePayslip';
import { formatDate } from '../../utils/formatMoney';
import { formatMonthLabel } from '../../utils/timesheetApprovalPeriod';
import styles from './EmployeePayslip.module.css';

interface IEmployeePayslipProps {
  payslip: IEmployeePayslipReady;
}

interface IRowProps {
  label: string;
  notes?: string[];
  amount: string;
}

const Row: FC<IRowProps> = ({ label, notes = [], amount }) => (
  <tr>
    <th scope="row">
      <span className={styles.kindName}>{label}</span>
      {notes.map(note => <span key={note} className={styles.kindNote}>{note}</span>)}
    </th>
    <td className={styles.num}>{formatPayslipAmount(amount)}</td>
  </tr>
);

const TotalRow: FC<{ label: string; amount: string }> = ({ label, amount }) => (
  <tr className={styles.total}>
    <th scope="row">{label}</th>
    <td className={styles.num}>{formatPayslipAmount(amount)}</td>
  </tr>
);

/** Строка оклада: должность, у расчёта ФОТ — оклад/ставка по частям. */
const contractNotes = (payslip: IEmployeePayslipReady): string[] => {
  const multi = payslip.salary_parts.length > 1;
  return payslip.salary_parts.map(part => {
    const rate = part.calc_type === 'hourly'
      ? `Ставка ${formatPayslipRate(part.amount)} ₽/ч`
      : `Оклад ${formatPayslipRate(part.amount)} ₽`;
    if (!multi) return rate;
    const days = part.days === null ? '' : ` · ${part.days}\u00a0дн.`;
    return `${rate} · ${formatDate(part.from)}–${formatDate(part.to)}${days}`;
  });
};

const accrualLabel = (line: IEmployeePayslipLine, payslip: IEmployeePayslipReady): string => (
  line.code === 'contract' && payslip.position_name ? payslip.position_name : payslipLineLabel(line)
);

/**
 * Расчётный лист месяца в ЛК: как бумажный листок 1С, но компактно — «Начислено» слева, «Удержано/Выплачено» справа
 * (на телефоне — друг под другом). Источник сумм не показывается.
 */
export const EmployeePayslip: FC<IEmployeePayslipProps> = ({ payslip }) => {
  const worked = payslip.worked_days;
  const meta = [
    payslip.period_from && payslip.period_to
      ? `с ${formatDate(payslip.period_from)} по ${formatDate(payslip.period_to)}`
      : null,
    worked ? `отработано ${worked.workday}\u00a0раб., ${worked.dayoff}\u00a0вых.` : null,
  ].filter((item): item is string => item !== null);

  return (
    <article className={styles.sheet} aria-label={`Расчётный лист за ${formatMonthLabel(payslip.month)}`}>
      <header className={styles.head}>
        <h2 className={styles.name}>{payslip.full_name}</h2>
        <span className={styles.month}>{formatMonthLabel(payslip.month)}</span>
      </header>

      <div className={styles.columns}>
        <section className={styles.block} aria-label="Начислено">
          <h3 className={styles.blockTitle}>{accruedTitle(worked)}</h3>
          {meta.length > 0 && <p className={styles.meta}>{meta.join(' · ')}</p>}
          <table className={styles.table}>
            <tbody>
              {payslip.accruals.map(line => (
                <Row
                  key={line.key}
                  label={accrualLabel(line, payslip)}
                  notes={line.code === 'contract' ? contractNotes(payslip) : []}
                  amount={line.amount}
                />
              ))}
            </tbody>
            <tfoot>
              <TotalRow label="Всего начислено" amount={payslip.accrued_total} />
            </tfoot>
          </table>
        </section>

        <section className={styles.block} aria-label="Удержано и выплачено">
          <h3 className={styles.blockTitle}>Удержано</h3>
          <table className={styles.table}>
            {payslip.deductions.length > 0 && (
              <tbody>
                {payslip.deductions.map(line => (
                  <Row key={line.key} label={payslipLineLabel(line)} amount={line.amount} />
                ))}
              </tbody>
            )}
            <tfoot>
              <TotalRow label="Всего удержано" amount={payslip.deducted_total} />
            </tfoot>
          </table>

          {payslip.paid_total !== null && (
            <>
              <h3 className={styles.blockTitle}>Выплачено</h3>
              <table className={styles.table}>
                <tbody>
                  {payslip.payouts.map(payout => (
                    <Row key={payout.document_id} label={payoutLabel(payout, payslip.payouts)} amount={payout.amount} />
                  ))}
                </tbody>
                <tfoot>
                  <TotalRow label="Всего выплачено" amount={payslip.paid_total} />
                </tfoot>
              </table>
            </>
          )}
        </section>
      </div>

      {payslip.balance !== null && (
        <footer className={styles.balance}>
          <span>Сальдо</span>
          <span className={styles.num}>{formatPayslipAmount(payslip.balance)}</span>
        </footer>
      )}
    </article>
  );
};
