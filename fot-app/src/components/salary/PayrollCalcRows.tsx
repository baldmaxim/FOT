import type { FC, ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

import type { PayrollCalcApi } from '../../hooks/usePayrollCalc';
import type { IPayrollCalcClosed, PayrollAbsenceStatus, PayrollCalcLineCode } from '../../services/payrollService';
import {
  calcAbsenceLines,
  CALC_ABSENCE_LABELS,
  calcAmount,
  calcLineLabel,
  calcMissingNote,
  calcNetTotal,
  calcSourceNote,
  PAYROLL_CALC_LINE_ORDER,
} from '../../utils/payrollCalc';
import { formatPaidAmount } from '../../utils/payrollPaid';
import styles from './PayrollPaidTable.module.css';

interface IPayrollCalcRowsProps {
  calc: PayrollCalcApi;
  /** Справа столбец «Итого» (несколько месяцев). */
  withTotal: boolean;
}

const formatValue = (value: number | null): string => (value === null ? '—' : formatPaidAmount(value));

/**
 * Строка «К выплате (ФОТ)» таблицы «Подробно» — расчёт ФОТ по закрытому табелю, над «Выплачено» из 1С: начислено
 * минус удержано, без НДФЛ. Под суммой — чего в ней нет («без: отпускные») и восстановленная основа; незакрытый
 * месяц — «Табель не закрыт». «Итого» — только когда закрыты все месяцы. Клик раскрывает строки расчёта
 * (статьи с подписями «Оплачено» — сравнение построчно), дни отсутствий, «Начислено» и «Удержано».
 */
export const PayrollCalcRows: FC<IPayrollCalcRowsProps> = ({ calc, withTotal }) => {
  const closed = calc.months
    .map(month => calc.calcs.get(month))
    .filter((item): item is IPayrollCalcClosed => item?.state === 'closed');
  const lineCodes = PAYROLL_CALC_LINE_ORDER.filter(code => closed.some(item => item.lines.some(line => line.code === code)));
  const absenceStatuses = [...new Set(closed.flatMap(item => calcAbsenceLines(item).map(line => line.status)))];

  const headCell = (month: string): ReactNode => {
    const item = calc.calcs.get(month);
    if (!item) return calc.status === 'error' ? '—' : '';
    const source = calcSourceNote(item);
    if (item.state === 'not_closed') return <span className={styles.calcNote}>{source}</span>;
    const missing = calcMissingNote(item.missing);
    return (
      <>
        {formatValue(calcAmount(item.net))}
        {missing && <span className={styles.calcNote}>{missing}</span>}
        {source && <span className={styles.calcNote}>{source}</span>}
      </>
    );
  };

  /** Значение строки по месяцу: незакрытый месяц — пусто, закрытый без значения — прочерк. */
  const renderRow = (key: string, label: string, value: (item: IPayrollCalcClosed) => string) => (
    <tr key={key}>
      <th scope="row" className={`${styles.rowHead} ${styles.rowHeadNested}`}>{label}</th>
      {calc.months.map(month => {
        const item = calc.calcs.get(month);
        return <td key={month} className={styles.value}>{item?.state === 'closed' ? value(item) : ''}</td>;
      })}
      {withTotal && <td className={styles.value} />}
    </tr>
  );

  const lineValue = (code: PayrollCalcLineCode) => (item: IPayrollCalcClosed): string => (
    formatValue(calcAmount(item.lines.find(line => line.code === code)?.amount))
  );
  const absenceValue = (status: PayrollAbsenceStatus) => (item: IPayrollCalcClosed): string => {
    const days = item.absences[status] ?? 0;
    return days > 0 ? `${days} дн.` : '—';
  };

  return (
    <>
      {/* Клик и Enter/Space с кнопки всплывают до строки. */}
      <tbody>
        <tr className={styles.totalRow} onClick={calc.toggleExpanded}>
          <th scope="row" className={`${styles.rowHead} ${styles.totalHead}`}>
            <button type="button" className={styles.totalToggle} aria-expanded={calc.expanded}>
              <ChevronRight size={16} className={styles.chevron} aria-hidden="true" />
              К выплате (ФОТ)
            </button>
          </th>
          {calc.months.map(month => <td key={month} className={styles.total}>{headCell(month)}</td>)}
          {withTotal && (
            <td className={styles.total}>
              {calc.status === 'ready' ? formatValue(calcNetTotal(calc.months.map(month => calc.calcs.get(month)))) : ''}
            </td>
          )}
        </tr>
      </tbody>
      {calc.expanded && closed.length > 0 && (
        <tbody>
          {lineCodes.map(code => renderRow(code, calcLineLabel(code), lineValue(code)))}
          {absenceStatuses.map(status => renderRow(`absence-${status}`, CALC_ABSENCE_LABELS[status], absenceValue(status)))}
          {renderRow('accrued', 'Начислено', item => formatValue(calcAmount(item.accrued)))}
          {renderRow('deducted', 'Удержано', item => formatValue(calcAmount(item.deducted)))}
        </tbody>
      )}
    </>
  );
};
