import type { FC } from 'react';

import type { IPremiumMonth } from '../../../api/objectKpi';
import {
  formatCoefficient,
  formatMoney,
  formatMoneyWhole,
  formatMonthLabel,
  formatPercent2,
} from '../../../utils/formatMoney';
import styles from './premium.module.css';

interface IPremiumMonthsTableProps {
  months: IPremiumMonth[];
  selected: string | null;
  onSelect: (periodMonth: string) => void;
}

const STATUS_LABEL: Record<IPremiumMonth['status'], string> = {
  no_scale: 'шкала не действует',
  not_assigned: 'не были закреплены',
  no_plan: 'план не определён',
  data_incomplete: 'нет данных по объекту',
  calculated: '',
};

export const PremiumMonthsTable: FC<IPremiumMonthsTableProps> = ({ months, selected, onSelect }) => (
  <section className={styles.months}>
    <div className={styles.monthsHead}>Расчёт по месяцам</div>
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Месяц</th>
            <th className={styles.num}>План</th>
            <th className={styles.num}>Факт</th>
            <th className={styles.num}>%</th>
            <th className={styles.num}>K</th>
            <th className={styles.num}>База</th>
            <th className={styles.num}>Премия</th>
          </tr>
        </thead>
        <tbody>
          {months.map((month) => (
            <tr
              key={month.period_month}
              className={`${styles.row} ${month.period_month === selected ? styles.rowActive : ''}`}
              onClick={() => onSelect(month.period_month)}
            >
              <td>
                {formatMonthLabel(month.period_month)}
                {month.status !== 'calculated' && (
                  <> · <span className={styles.status}>{STATUS_LABEL[month.status]}</span></>
                )}
              </td>
              <td className={styles.num}>{formatMoney(month.total_plan)}</td>
              <td className={styles.num}>{formatMoney(month.total_fact)}</td>
              <td className={styles.num}>{formatPercent2(month.completion_pct)}</td>
              <td className={styles.num}>{formatCoefficient(month.coefficient)}</td>
              <td className={styles.num}>{formatMoney(month.base_prorated)}</td>
              <td className={styles.num}>{formatMoneyWhole(month.premium_amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </section>
);
