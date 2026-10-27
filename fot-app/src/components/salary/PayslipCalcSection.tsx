import type { FC } from 'react';

import type { IPayrollCalcClosed, PayrollAbsenceStatus, PayrollCalc, PayrollPaidItemCode } from '../../services/payrollService';
import {
  calcAbsenceLines,
  calcAmount,
  calcLineDaysNote,
  calcLineLabel,
  calcLinePaidItem,
  calcLines,
  calcMissingNote,
  calcSourceNote,
} from '../../utils/payrollCalc';
import { formatPaidAmount, paidCellKey } from '../../utils/payrollPaid';
import styles from './PaidPayslip.module.css';

interface IPayslipCalcSectionProps {
  month: string;
  /** undefined — листок ещё грузится. */
  calc: PayrollCalc | undefined;
  /** Суммы «Оплачено» (1С) истории: столбец «1С» — если за месяц они есть. */
  amounts: ReadonlyMap<string, number>;
  /** «К выплате» 1С за месяц (начислено − удержано); null — сумм 1С нет. */
  payout1c: number | null;
  deducted1c: number | null;
}

/** Отсутствие — статья «Оплачено» с его суммой (отпускные и больничные считает только 1С). */
const ABSENCE_PAID_ITEM: Partial<Record<PayrollAbsenceStatus, PayrollPaidItemCode>> = {
  vacation: 'vacation',
  sick: 'sick_leave',
};

const formatValue = (value: number | null | undefined): string => (
  value === null || value === undefined ? '—' : formatPaidAmount(value)
);

/**
 * Блок «Расчёт ФОТ» расчётного листка: по закрытому табелю — строки начислений с днями, дни отсутствий (суммы —
 * только из 1С), удержания «Справочника» и «Итого без НДФЛ»; рядом столбец «1С» для сравнения построчно, если
 * за месяц есть суммы «Оплачено». Табель не закрыт — только пометка.
 */
export const PayslipCalcSection: FC<IPayslipCalcSectionProps> = ({ month, calc, amounts, payout1c, deducted1c }) => {
  const with1c = payout1c !== null;
  const paid = (code: PayrollPaidItemCode): number | undefined => amounts.get(paidCellKey(month, code));

  const renderClosed = (closed: IPayrollCalcClosed) => {
    const notes = [calcSourceNote(closed), calcMissingNote(closed.missing)].filter(Boolean);
    return (
      <>
        {notes.length > 0 && <p className={styles.calcNote}>{notes.join(' · ')}</p>}
        <div className={styles.scroll}>
          <table className={`${styles.table} ${styles.calcTable}`}>
            <colgroup>
              <col />
              <col className={styles.sumCol} />
              {with1c && <col className={styles.sumCol} />}
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Вид</th>
                <th scope="col" className={styles.num}>ФОТ</th>
                {with1c && <th scope="col" className={styles.num}>1С</th>}
              </tr>
            </thead>
            <tbody>
              {calcLines(closed).map(line => {
                const note = calcLineDaysNote(line);
                const paidItem = calcLinePaidItem(line, closed.lines);
                return (
                  <tr key={line.code}>
                    <th scope="row" className={styles.kind}>
                      <span className={styles.kindName}>{calcLineLabel(line.code)}</span>
                      {note && <span className={styles.kindNote}>{note}</span>}
                    </th>
                    <td className={styles.num}>{formatValue(calcAmount(line.amount))}</td>
                    {with1c && <td className={styles.num}>{paidItem ? formatValue(paid(paidItem)) : ''}</td>}
                  </tr>
                );
              })}
              {calcAbsenceLines(closed).map(line => {
                const item = ABSENCE_PAID_ITEM[line.status];
                return (
                  <tr key={line.status}>
                    <th scope="row" className={styles.kind}>
                      <span className={styles.kindName}>{line.label}</span>
                      <span className={styles.kindNote}>{line.days} дн.</span>
                    </th>
                    <td className={`${styles.num} ${styles.calcMuted}`}>{item ? 'из 1С' : '—'}</td>
                    {with1c && <td className={styles.num}>{item ? formatValue(paid(item)) : '—'}</td>}
                  </tr>
                );
              })}
              <tr className={styles.calcSubtotal}>
                <th scope="row">Начислено</th>
                <td className={styles.num}>{formatValue(calcAmount(closed.accrued))}</td>
                {with1c && <td className={styles.num} />}
              </tr>
              {closed.deductions.map(deduction => (
                <tr key={deduction.kind_id}>
                  <th scope="row" className={styles.kind}>{deduction.kind}</th>
                  <td className={styles.num}>{formatValue(calcAmount(deduction.amount))}</td>
                  {with1c && <td className={styles.num} />}
                </tr>
              ))}
              <tr className={styles.calcSubtotal}>
                <th scope="row">Удержано</th>
                <td className={styles.num}>{formatValue(calcAmount(closed.deducted))}</td>
                {with1c && <td className={styles.num}>{formatValue(deducted1c)}</td>}
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Итого без НДФЛ</th>
                <td className={styles.num}>{formatValue(calcAmount(closed.net))}</td>
                {with1c && <td className={styles.num}>{formatValue(payout1c)}</td>}
              </tr>
            </tfoot>
          </table>
        </div>
      </>
    );
  };

  return (
    <section className={styles.part} aria-label="Расчёт ФОТ">
      <p className={styles.partTitle}>Расчёт ФОТ</p>
      {!calc && <p className={styles.calcNote}>…</p>}
      {calc?.state === 'not_closed' && <p className={styles.calcNote}>{calcSourceNote(calc)}</p>}
      {calc?.state === 'closed' && renderClosed(calc)}
    </section>
  );
};
