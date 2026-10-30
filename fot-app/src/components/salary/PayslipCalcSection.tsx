import type { FC } from 'react';

import type {
  IPayslipSchedule,
  PayrollAbsenceStatus,
  PayrollCalc,
  PayrollCalcCounted,
  PayrollPaidItemCode,
} from '../../services/payrollService';
import {
  calcAbsenceLines,
  calcAmount,
  calcLineAbsence,
  calcLineFormula,
  calcLineLabel,
  calcLinePaidItem,
  calcLines,
  calcMissingNote,
  isCalcCounted,
} from '../../utils/payrollCalc';
import { formatPaidAmount, paidCellKey } from '../../utils/payrollPaid';
import { formatPayslipSchedules } from '../../utils/payrollPayslip';
import styles from './PaidPayslip.module.css';

interface IPayslipCalcSectionProps {
  month: string;
  /** undefined — листок ещё грузится. */
  calc: PayrollCalc | undefined;
  /** Графики месяца — справочно; нет у старого бэкенда. */
  schedules: readonly IPayslipSchedule[] | undefined;
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
 * Блок «Расчёт ФОТ» расчётного листка — по табелю, закрыт он или нет: строки начислений с расшифровкой (из чего
 * сумма — по подстроке на часть), в том числе отпускные и больничные из 1С с днями; дни отсутствий без сумм 1С —
 * строками «из 1С»; удержания «Справочника» и «Итого без НДФЛ»; рядом столбец «1С» для сравнения построчно, если
 * за месяц есть суммы «Оплачено». Графики месяца — справочно. Итог неизвестен (выработка бригады не введена…) — «—»
 * и «без: …»; посчитать нечем — «—».
 */
export const PayslipCalcSection: FC<IPayslipCalcSectionProps> = ({ month, calc, schedules, amounts, payout1c, deducted1c }) => {
  const with1c = payout1c !== null;
  const paid = (code: PayrollPaidItemCode): number | undefined => amounts.get(paidCellKey(month, code));
  const schedulesNote = formatPayslipSchedules(schedules);

  const renderClosed = (closed: PayrollCalcCounted) => {
    const missing = calcMissingNote(closed.missing);
    // Дни отпуска или больничного, оплаченные строкой 1С, — в ней же; отдельной строкой — только без суммы.
    const paidAbsences = new Set(closed.lines.map(line => calcLineAbsence(line.code)));
    return (
      <>
        {schedulesNote && <p className={styles.calcNote}>{schedulesNote}</p>}
        {missing && <p className={styles.calcNote}>{missing}</p>}
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
                const paidItem = calcLinePaidItem(line, closed.lines);
                return (
                  <tr key={line.code}>
                    <th scope="row" className={styles.kind}>
                      <span className={styles.kindName}>{calcLineLabel(line.code)}</span>
                      {calcLineFormula(line).map(text => <span key={text} className={styles.kindNote}>{text}</span>)}
                    </th>
                    <td className={styles.num}>{formatValue(calcAmount(line.amount))}</td>
                    {with1c && <td className={styles.num}>{paidItem ? formatValue(paid(paidItem)) : ''}</td>}
                  </tr>
                );
              })}
              {calcAbsenceLines(closed).filter(line => !paidAbsences.has(line.status)).map(line => {
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
      {calc && !isCalcCounted(calc) && <p className={styles.calcNote}>—</p>}
      {isCalcCounted(calc) && renderClosed(calc)}
    </section>
  );
};
