import type { FC } from 'react';
import { ChevronRight } from 'lucide-react';

import type { PayrollCalcCounted } from '../../services/payrollService';
import { buildHoursDaysTable, formatHours, type IHoursDayRow } from '../../utils/payrollHoursDays';
import disclosure from './PayrollDisclosure.module.css';
import table from './PaidPayslip.module.css';
import styles from './PayslipHoursDays.module.css';

interface IPayslipHoursDaysProps {
  calc: PayrollCalcCounted;
}

const hoursCell = (minutes: number | null): string => (minutes === null || minutes === 0 ? '—' : formatHours(minutes));

/** «График» дня: снимок нормы; плановая Сб/Вс — «квота». */
const normCell = (row: IHoursDayRow): string => (row.quota ? 'квота' : hoursCell(row.normMinutes));

/** «В оклад» дня: доля бригады и почасовой сегмент — словом, их платит не оклад. */
const contractCell = (row: IHoursDayRow): string => {
  if (row.brigade) return 'доля бригады';
  if (row.hourlyMinutes > 0) return 'по ставке';
  return hoursCell(row.contractMinutes);
};

/**
 * «Часы по дням» под «Расчётом ФОТ» месяца с окладом по часам (свёрнуто): по каждой дате — норма графика (снимок при
 * закрытии; у предварительного — по графикам на сейчас), часы табеля к оплате, сколько из них в оклад и в
 * «Переработку». Итог — те же часы, что в формуле. Даты после «табеля по» — серые, у них только норма. Снимка нормы
 * нет (месяц закрыт до миграции 368) — без столбца «График». Расшифровки нет — ничего.
 */
export const PayslipHoursDays: FC<IPayslipHoursDaysProps> = ({ calc }) => {
  const data = buildHoursDaysTable(calc);
  if (!data) return null;
  const { rows, hasNorm, quota, totals } = data;

  return (
    <details className={`${disclosure.disclosure} ${styles.block}`}>
      <summary className={disclosure.summary}>
        <span className={disclosure.summaryHead}>
          <ChevronRight size={16} className={disclosure.chevron} aria-hidden="true" />
          <span className={styles.title}>Часы по дням</span>
        </span>
      </summary>
      <div className={table.scroll}>
        <table className={`${table.table} ${styles.table}`}>
          <thead>
            <tr>
              <th scope="col">Дата</th>
              {hasNorm && <th scope="col" className={table.num}>График</th>}
              <th scope="col" className={table.num}>Табель</th>
              <th scope="col" className={table.num}>В оклад</th>
              <th scope="col" className={table.num}>Перераб.</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.date} className={row.future ? styles.future : undefined}>
                <th scope="row" className={table.nowrap}>{row.label}</th>
                {hasNorm && <td className={table.num}>{normCell(row)}</td>}
                <td className={table.num}>{hoursCell(row.paidMinutes)}</td>
                <td className={table.num}>{contractCell(row)}</td>
                <td className={table.num}>{hoursCell(row.overtimeMinutes)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            {quota && (
              <tr className={styles.quotaRow}>
                <th scope="row">{quota.label}</th>
                <td className={table.num}>{formatHours(quota.minutes)}</td>
                <td colSpan={3} />
              </tr>
            )}
            <tr>
              <th scope="row">Итого</th>
              {hasNorm && <td className={table.num}>{totals.norm === null ? '—' : formatHours(totals.norm)}</td>}
              <td className={table.num}>{formatHours(totals.paid)}</td>
              <td className={table.num}>{formatHours(totals.contract)}</td>
              <td className={table.num}>{hoursCell(totals.overtime)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </details>
  );
};
