import type { FC } from 'react';
import { useQuery } from '@tanstack/react-query';

import {
  CALC_TYPE_LABELS,
  payrollService,
  type ISalaryChange,
  type PayrollCalcType,
} from '../../services/payrollService';
import { formatDate } from '../../utils/formatMoney';
import { formatPayrollMoney } from '../../utils/payrollFormat';
import styles from './SalaryHistorySection.module.css';

interface ISalaryHistorySectionProps {
  employeeId: number;
}

const UNIT: Record<PayrollCalcType, string> = { salary: '₽/мес', hourly: '₽/час' };

const formatAmount = (value: string | null, calcType: PayrollCalcType): string => {
  const money = formatPayrollMoney(value);
  return money === null ? '—' : `${money} ${UNIT[calcType]}`;
};

/**
 * Разница приходит строкой NUMERIC со знаком. Знак рисуем сами («+» / «−»),
 * модуль — строкой без минуса: считать деньги в JS не нужно.
 */
const formatDelta = (change: ISalaryChange): { text: string; isDown: boolean } | null => {
  if (change.diff === null) return null;
  const isDown = change.diff.startsWith('-');
  const sign = isDown ? '−' : '+';
  const money = formatPayrollMoney(change.diff.replace(/^-/, ''));
  if (money === null) return null;
  const percent = change.diff_percent === null ? '' : ` (${sign}${change.diff_percent.replace(/^-/, '').replace('.', ',')}%)`;
  return { text: `${sign}${money} ₽${percent}`, isDown };
};

const formatPeriod = (change: ISalaryChange): string => (
  change.effective_to
    ? `с ${formatDate(change.effective_from)} по ${formatDate(change.effective_to)}`
    : `с ${formatDate(change.effective_from)}, действует`
);

/**
 * История оклада / ставки: было → стало. Разница — только при том же виде оплаты:
 * оклад в месяц со ставкой в час не сравнить. Свой запрос — ошибка не блокирует форму.
 */
export const SalaryHistorySection: FC<ISalaryHistorySectionProps> = ({ employeeId }) => {
  const historyQuery = useQuery({
    // Под префиксом 'payroll-terms': сохранение условий сбрасывает и эту историю.
    queryKey: ['payroll-terms', 'salary-history', employeeId],
    queryFn: ({ signal }) => payrollService.getSalaryHistory(employeeId, signal),
    staleTime: 30_000,
  });
  const { data } = historyQuery;

  return (
    <section className={styles.section}>
      <h3 className={styles.title}>История изменения зарплаты</h3>

      {historyQuery.isPending && <p className={styles.state}>Загрузка…</p>}
      {historyQuery.isError && (
        <div className={styles.stateError}>
          <span>Не удалось загрузить историю</span>
          <button type="button" className={styles.retryButton} onClick={() => { void historyQuery.refetch(); }}>
            Повторить
          </button>
        </div>
      )}

      {data && data.length === 0 && <p className={styles.state}>Условия оплаты ещё не назначались</p>}

      {data && data.length > 0 && (
        <ul className={styles.list}>
          {data.map(change => {
            const delta = formatDelta(change);
            const calcChanged = change.prev_calc_type !== null && change.prev_calc_type !== change.calc_type;
            return (
              <li key={change.effective_from} className={styles.item}>
                <div className={styles.itemHead}>
                  <span className={styles.period}>{formatPeriod(change)}</span>
                  {delta && (
                    <span className={delta.isDown ? styles.deltaDown : styles.deltaUp}>{delta.text}</span>
                  )}
                </div>
                <div className={styles.amounts}>
                  {change.prev_amount !== null && change.prev_calc_type !== null ? (
                    <>
                      <span className={styles.prevAmount}>было {formatAmount(change.prev_amount, change.prev_calc_type)}</span>
                      <span className={styles.arrow} aria-hidden="true">→</span>
                      <span className={styles.amount}>стало {formatAmount(change.amount, change.calc_type)}</span>
                    </>
                  ) : (
                    <span className={styles.amount}>назначено {formatAmount(change.amount, change.calc_type)}</span>
                  )}
                </div>
                {calcChanged && change.prev_calc_type !== null && (
                  <div className={styles.meta}>
                    Смена вида оплаты: {CALC_TYPE_LABELS[change.prev_calc_type]} → {CALC_TYPE_LABELS[change.calc_type]}
                  </div>
                )}
                {change.changed_by_name && <div className={styles.meta}>Изменил: {change.changed_by_name}</div>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};
