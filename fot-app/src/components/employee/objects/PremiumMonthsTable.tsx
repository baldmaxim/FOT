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
  /** Подпись окна: «август 2025 — июль 2026». */
  rangeLabel: string;
}

const STATUS_LABEL: Record<IPremiumMonth['status'], string> = {
  no_scale: 'шкала не действует',
  not_assigned: 'не были закреплены',
  no_plan: 'план не определён',
  data_incomplete: 'нет данных по объекту',
  calculated: '',
};

/**
 * Выбор месяца — настоящая кнопка в первой ячейке, а не role="button" на строке:
 * роль на <tr> ломает табличную семантику для скринридера, а min-height у <td>
 * работает непредсказуемо. Клик по остальной части строки оставлен как удобство мышью.
 */
export const PremiumMonthsTable: FC<IPremiumMonthsTableProps> = ({
  months,
  selected,
  onSelect,
  rangeLabel,
}) => (
  <section className={styles.months}>
    <div className={styles.monthsHead}>
      Расчёт по месяцам
      <span className={styles.monthsRange}>{rangeLabel}</span>
    </div>
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
              /* Приглушаем месяцы вне итога: их факт виден в строке, но в плитку
                 «Итого по рассчитанным месяцам» не входит — без метки это выглядит
                 как несходящаяся сумма. */
              className={[
                styles.row,
                month.period_month === selected ? styles.rowActive : '',
                month.status === 'calculated' ? '' : styles.rowMuted,
              ].filter(Boolean).join(' ')}
              onClick={() => onSelect(month.period_month)}
            >
              <td className={styles.monthCell}>
                <button
                  type="button"
                  className={styles.monthButton}
                  aria-pressed={month.period_month === selected}
                  onClick={(event) => { event.stopPropagation(); onSelect(month.period_month); }}
                >
                  <span>{formatMonthLabel(month.period_month)}</span>
                  {month.status !== 'calculated' && (
                    <span className={styles.status}>{STATUS_LABEL[month.status]}</span>
                  )}
                </button>
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
