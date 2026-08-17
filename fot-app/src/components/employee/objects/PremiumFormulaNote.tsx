import type { FC } from 'react';

import type { IPremiumMonth } from '../../../api/objectKpi';
import {
  formatCoefficient,
  formatMoney,
  formatMoneyWhole,
  formatPercent2,
} from '../../../utils/formatMoney';
import styles from './premium.module.css';

/**
 * Расчёт строками — чтобы премию можно было проверить глазами, не открывая приказ.
 * Точки интерполяции берутся из ответа: шкала версионируется, зашивать её нельзя.
 */
export const PremiumFormulaNote: FC<{ month: IPremiumMonth }> = ({ month }) => {
  if (month.status !== 'calculated') return null;

  const { interpolation: k } = month;
  const prorated = month.eligible_assignment_days < month.days_in_month;

  return (
    <div className={styles.formula}>
      <span>
        Выполнение = {formatMoney(month.total_fact)} ÷ {formatMoney(month.total_plan)} × 100 ={' '}
        <b>{formatPercent2(month.completion_pct)}</b>
      </span>
      {k && k.lower_pct !== null && k.upper_pct !== null && (
        <span>
          K = {formatCoefficient(k.lower_coef)} + ({formatPercent2(month.completion_pct).replace(' %', '')} −{' '}
          {Number(k.lower_pct)}) ÷ ({Number(k.upper_pct)} − {Number(k.lower_pct)}) × (
          {formatCoefficient(k.upper_coef)} − {formatCoefficient(k.lower_coef)}) ={' '}
          <b>{formatCoefficient(month.coefficient)}</b>
        </span>
      )}
      {k && (k.lower_pct === null || k.upper_pct === null) && (
        <span>
          K = <b>{formatCoefficient(month.coefficient)}</b>{' '}
          {k.lower_pct === null ? '(ниже минимального порога шкалы)' : '(максимум шкалы)'}
        </span>
      )}
      {prorated && (
        <span>
          База = {formatMoney(month.base_amount)} × {month.eligible_assignment_days} ÷{' '}
          {month.days_in_month} дн. = <b>{formatMoney(month.base_prorated)}</b>
        </span>
      )}
      <span>
        Премия = {formatMoney(month.base_prorated)} × {formatCoefficient(month.coefficient)} ={' '}
        <b>{formatMoneyWhole(month.premium_amount)}</b>
      </span>
    </div>
  );
};
