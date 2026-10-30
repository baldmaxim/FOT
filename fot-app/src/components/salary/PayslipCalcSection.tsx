import type { FC } from 'react';

import type {
  IPayslipSchedule,
  PayrollCalc,
  PayrollCalcCounted,
  PayrollPaidItemCode,
} from '../../services/payrollService';
import {
  ABSENCE_PAID_ITEM,
  calcAbsenceLines,
  calcAmount,
  calcLineAbsence,
  calcLineFormula,
  calcLineLabel,
  calcLinePaidItem,
  calcLines,
  calcMissingNote,
  calcPaidOnlyAccruals,
  isCalcCounted,
  payslipDeductionRows,
} from '../../utils/payrollCalc';
import { formatPaidAmount, paidCellKey } from '../../utils/payrollPaid';
import { formatPayslipSchedules, payslipLines } from '../../utils/payrollPayslip';
import styles from './PaidPayslip.module.css';

interface IPayslipCalcSectionProps {
  month: string;
  /** Листок ещё грузится — «…». */
  loading: boolean;
  /** Расчёт ФОТ месяца; нет (старый бэкенд, ошибка) — только 1С, если суммы есть. */
  calc: PayrollCalc | undefined;
  /** Графики месяца — справочно; нет у старого бэкенда. */
  schedules: readonly IPayslipSchedule[] | undefined;
  /** Суммы «Оплачено» (1С) истории: столбец «1С» — если за месяц они есть. */
  amounts: ReadonlyMap<string, number>;
  /** Итоги 1С за месяц; payout1c null — сумм 1С нет, столбца «1С» нет. */
  accrued1c: number | null;
  deducted1c: number | null;
  payout1c: number | null;
}

const formatValue = (value: number | null | undefined): string => (
  value === null || value === undefined ? '—' : formatPaidAmount(value)
);

/**
 * Блок «Расчёт ФОТ» расчётного листка — по табелю, закрыт он или нет: строки начислений с расшифровкой (из чего
 * сумма — по подстроке на часть), в том числе отпускные и больничные из 1С с днями; дни отсутствий без сумм 1С —
 * строками «из 1С»; удержания и «Итого без НДФЛ»; рядом столбец «1С» для сравнения построчно, если за месяц есть
 * суммы «Оплачено». Статьи 1С без пары в ФОТ («Допработы», «Премия»…, удержания 1С) — своими строками с ФОТ «—»,
 * одноимённые вид удержания «Справочника» и статья 1С — одной строкой: столбец «1С» сходится с итогами. Расчёта ФОТ
 * нет, а суммы 1С есть — та же таблица из строк 1С. Графики месяца — справочно. Итог неизвестен (выработка бригады
 * не введена…) — «—» и «без: …»; посчитать нечем — «—».
 */
export const PayslipCalcSection: FC<IPayslipCalcSectionProps> = ({
  month, loading, calc, schedules, amounts, accrued1c, deducted1c, payout1c,
}) => {
  const with1c = payout1c !== null;
  const paid = (code: PayrollPaidItemCode): number | undefined => amounts.get(paidCellKey(month, code));
  const schedulesNote = formatPayslipSchedules(schedules);

  /** counted null — расчёта ФОТ нет: строки только из 1С. */
  const renderTable = (counted: PayrollCalcCounted | null) => {
    const missing = counted ? calcMissingNote(counted.missing) : null;
    const lines = counted ? calcLines(counted) : [];
    // Дни отпуска или больничного, оплаченные строкой 1С, — в ней же; отдельной строкой — только без суммы.
    const paidAbsences = new Set(lines.map(line => calcLineAbsence(line.code)));
    const absences = counted ? calcAbsenceLines(counted).filter(line => !paidAbsences.has(line.status)) : [];
    const paidOnly = with1c ? calcPaidOnlyAccruals(counted, payslipLines(month, amounts, 'accrued')) : [];
    const deductions = with1c
      ? payslipDeductionRows(counted?.deductions ?? [], payslipLines(month, amounts, 'deducted'))
      : (counted?.deductions ?? []).map(item => ({ key: `kind-${item.kind_id}`, label: item.kind, fot: item.amount, paid: null }));
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
              {counted && lines.map(line => {
                const paidItem = calcLinePaidItem(line, counted.lines);
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
              {absences.map(line => {
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
              {paidOnly.map(line => (
                <tr key={`paid-${line.code}`}>
                  <th scope="row" className={styles.kind}>{line.label}</th>
                  <td className={styles.num}>—</td>
                  <td className={styles.num}>{formatPaidAmount(line.amount)}</td>
                </tr>
              ))}
              <tr className={styles.calcSubtotal}>
                <th scope="row">Начислено</th>
                <td className={styles.num}>{formatValue(counted ? calcAmount(counted.accrued) : null)}</td>
                {with1c && <td className={styles.num}>{formatValue(accrued1c)}</td>}
              </tr>
              {deductions.map(row => (
                <tr key={row.key}>
                  <th scope="row" className={styles.kind}>{row.label}</th>
                  <td className={styles.num}>{formatValue(calcAmount(row.fot))}</td>
                  {with1c && <td className={styles.num}>{row.paid === null ? '' : formatPaidAmount(row.paid)}</td>}
                </tr>
              ))}
              <tr className={styles.calcSubtotal}>
                <th scope="row">Удержано</th>
                <td className={styles.num}>{formatValue(counted ? calcAmount(counted.deducted) : null)}</td>
                {with1c && <td className={styles.num}>{formatValue(deducted1c)}</td>}
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Итого без НДФЛ</th>
                <td className={styles.num}>{formatValue(counted ? calcAmount(counted.net) : null)}</td>
                {with1c && <td className={styles.num}>{formatValue(payout1c)}</td>}
              </tr>
            </tfoot>
          </table>
        </div>
      </>
    );
  };

  let body;
  if (loading) body = <p className={styles.calcNote}>…</p>;
  else if (isCalcCounted(calc)) body = renderTable(calc);
  else if (with1c) body = renderTable(null);
  else body = <p className={styles.calcNote}>—</p>;

  return (
    <section className={styles.part} aria-label="Расчёт ФОТ">
      <p className={styles.partTitle}>Расчёт ФОТ</p>
      {body}
    </section>
  );
};
