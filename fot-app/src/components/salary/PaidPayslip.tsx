import type { FC } from 'react';
import { useQuery } from '@tanstack/react-query';

import { payrollService } from '../../services/payrollService';
import { pluralDays } from '../../utils/dateCompact';
import { formatPaidAmount, paidCellKey, type PayrollPaidTotals } from '../../utils/payrollPaid';
import {
  formatPayslipTerms,
  PAYSLIP_MAIN_ITEM,
  payslipLines,
  payslipPeriodParts,
  payslipRateLines,
} from '../../utils/payrollPayslip';
import disclosure from './PayrollDisclosure.module.css';
import styles from './PaidPayslip.module.css';

interface IPaidPayslipProps {
  employeeId: number;
  month: string;
  /** Текущая должность: должность на прошлый месяц ФОТ не хранит. */
  positionName: string | null;
  amounts: ReadonlyMap<string, number>;
  totals: PayrollPaidTotals;
}

const formatTotal = (value: number | null): string => (value === null ? '—' : formatPaidAmount(value));

/**
 * Выбранный месяц вкладки «История выплат» — расчётный листок по подобию ЗУП. «Начислено за N дней»: первая строка —
 * должность и оклад, период, отработано дней (рабочие по графику / выходные сверх графика) и сумма
 * «По трудовому договору»; ниже прочие начисления и «Всего начислено». Затем «Удержано» и «Всего удержано».
 * Суммы — «Оплачено» из 1С (уже загружены историей), период, дни и оклад — из ФОТ: грузятся при выборе месяца.
 * Ниже — «По ставкам ФОТ» (проезд — пропорционально дням, доплата за проживание или за общежитие) по ставкам того
 * месяца; в «Всего начислено» они не входят.
 */
export const PaidPayslip: FC<IPaidPayslipProps> = ({ employeeId, month, positionName, amounts, totals }) => {
  const payslipQuery = useQuery({
    // Под префиксом 'payroll-terms': сохранение карточки перечитывает и листок (оклад).
    queryKey: ['payroll-terms', 'payslip', employeeId, month],
    queryFn: ({ signal }) => payrollService.getPayslip(employeeId, month, signal),
    staleTime: 30_000,
  });
  const info = payslipQuery.data;
  const accruals = payslipLines(month, amounts, 'accrued');
  const deductions = payslipLines(month, amounts, 'deducted');
  const mainAmount = amounts.get(paidCellKey(month, PAYSLIP_MAIN_ITEM));
  const days = info?.worked_days ?? null;
  const daysTotal = days ? days.workday + days.dayoff : 0;
  const terms = info ? formatPayslipTerms(info.terms) : null;
  const period = info ? payslipPeriodParts(info.period_from, info.period_to) : null;
  const rateLines = payslipRateLines(info?.rate_allowances);

  // Пока табель грузится — многоточие, нет данных — прочерк: суммы видны сразу.
  const fromInfo = (value: number | undefined): string => {
    if (payslipQuery.isPending) return '…';
    return value === undefined ? '—' : String(value);
  };

  return (
    <div className={styles.payslip}>
      <section className={styles.part} aria-label="Начислено">
        <p className={styles.partTitle}>
          {daysTotal > 0 ? `Начислено за ${daysTotal} ${pluralDays(daysTotal)}` : 'Начислено'}
        </p>
        <div className={styles.scroll}>
          <table className={styles.table}>
            <colgroup>
              <col />
              <col className={styles.periodCol} />
              <col className={styles.daysCol} />
              <col className={styles.daysCol} />
              <col className={styles.sumCol} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col" rowSpan={2}>Вид</th>
                <th scope="col" rowSpan={2}>Период</th>
                <th scope="colgroup" colSpan={2} className={styles.center}>Отработано, дн.</th>
                <th scope="col" rowSpan={2} className={styles.num}>Сумма</th>
              </tr>
              <tr>
                <th scope="col" className={styles.center}>раб.</th>
                <th scope="col" className={styles.center}>вых.</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row" className={styles.kind}>
                  <span className={styles.kindName}>{positionName || 'По трудовому договору'}</span>
                  {terms && <span className={styles.kindNote}>{terms}</span>}
                </th>
                <td className={styles.period}>
                  {period
                    ? <><span className={styles.nowrap}>{period[0]}</span> <span className={styles.nowrap}>{period[1]}</span></>
                    : (payslipQuery.isPending ? '…' : '—')}
                </td>
                <td className={styles.center}>{fromInfo(days?.workday)}</td>
                <td className={styles.center}>{fromInfo(days?.dayoff)}</td>
                <td className={styles.num}>{mainAmount === undefined ? '—' : formatPaidAmount(mainAmount)}</td>
              </tr>
              {accruals.map(line => (
                <tr key={line.code}>
                  <th scope="row" className={styles.kind}>{line.label}</th>
                  <td colSpan={3} />
                  <td className={styles.num}>{formatPaidAmount(line.amount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={4}>Всего начислено</th>
                <td className={styles.num}>{formatTotal(totals.accrued)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        {payslipQuery.isError && (
          <div className={`${disclosure.stateError} ${styles.note}`}>
            <span>Не удалось загрузить дни табеля и оклад</span>
            <button type="button" className={disclosure.retryButton} onClick={() => { void payslipQuery.refetch(); }}>
              Повторить
            </button>
          </div>
        )}
      </section>

      {deductions.length > 0 && (
        <section className={styles.part} aria-label="Удержано">
          <p className={styles.partTitle}>Удержано</p>
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
                {deductions.map(line => (
                  <tr key={line.code}>
                    <th scope="row" className={styles.kind}>{line.label}</th>
                    <td className={styles.num}>{formatPaidAmount(line.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Всего удержано</th>
                  <td className={styles.num}>{formatTotal(totals.deducted)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      )}

      {rateLines.length > 0 && (
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
    </div>
  );
};
