import type { FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';

import {
  CALC_TYPE_LABELS,
  payrollService,
  type IPayrollTermsChange,
  type IPlannedSupplementChange,
  type ISalaryChange,
  type PayrollCalcType,
} from '../../services/payrollService';
import { formatDate } from '../../utils/formatMoney';
import { toMoscowDateIso } from '../../utils/moscowDate';
import { formatPayrollMoney } from '../../utils/payrollFormat';
import styles from './PayrollDisclosure.module.css';

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

const formatSupplement = (amount: string | null): string => {
  const money = formatPayrollMoney(amount);
  return money === null ? '—' : `${money} ₽/мес`;
};

const formatSupplementPeriod = (from: string | null, to: string | null): string =>
  `с ${formatDate(from)} по ${formatDate(to)}`;

/** «Изменил: ФИО · дата» — дата изменения по Москве: журнал упорядочен по ней. */
const formatAuthor = (change: IPayrollTermsChange): string => {
  const changedOn = formatDate(toMoscowDateIso(new Date(change.changed_at)));
  return change.changed_by_name ? `Изменил: ${change.changed_by_name} · ${changedOn}` : changedOn;
};

/** Плановая доплата: назначена, заменена («было → стало») или снята. */
const renderSupplementChange = (change: IPlannedSupplementChange & { kind: 'supplement' }) => {
  const prevPeriod = formatSupplementPeriod(change.prev_date_from, change.prev_date_to);
  const samePeriod = change.prev_date_from === change.date_from && change.prev_date_to === change.date_to;
  return (
    <li key={`supplement-${change.id}`} className={styles.item}>
      <div className={styles.itemHead}>
        <span className={styles.itemSecondary}>
          {change.action === 'removed'
            ? 'Плановая доплата'
            : `Плановая доплата ${formatSupplementPeriod(change.date_from, change.date_to)}`}
        </span>
      </div>
      <div className={styles.amounts}>
        {change.action === 'assigned' && (
          <span className={styles.amount}>назначено {formatSupplement(change.amount)}</span>
        )}
        {change.action === 'changed' && (
          <>
            <span className={styles.prevAmount}>
              было {formatSupplement(change.prev_amount)}{samePeriod ? '' : `, ${prevPeriod}`}
            </span>
            <span className={styles.prevAmount} aria-hidden="true">→</span>
            <span className={styles.amount}>стало {formatSupplement(change.amount)}</span>
          </>
        )}
        {change.action === 'removed' && (
          <>
            <span className={styles.amount}>снята</span>
            <span className={styles.prevAmount}>было {formatSupplement(change.prev_amount)}, {prevPeriod}</span>
          </>
        )}
      </div>
      <div className={styles.itemMeta}>{formatAuthor(change)}</div>
    </li>
  );
};

/**
 * «История изменений условий оплаты» — раскрываемый блок, свёрнут по умолчанию.
 * Оклад / ставка и плановая доплата одним журналом, по времени изменения (новые сверху).
 * Было → стало; разница — только при том же виде оплаты (оклад со ставкой не сравнить).
 * Пустая история — не то же самое, что отсутствие условий: пишем нейтрально.
 */
export const SalaryHistorySection: FC<ISalaryHistorySectionProps> = ({ employeeId }) => {
  const historyQuery = useQuery({
    // Под префиксом 'payroll-terms': сохранение условий сбрасывает и эту историю.
    queryKey: ['payroll-terms', 'terms-changes', employeeId],
    queryFn: ({ signal }) => payrollService.getTermsChanges(employeeId, signal),
    staleTime: 30_000,
  });
  const { data } = historyQuery;

  let meta: string;
  if (historyQuery.isPending) meta = 'загрузка…';
  else if (historyQuery.isError) meta = 'не удалось загрузить';
  else meta = data && data.length > 0 ? `записей: ${data.length}` : 'изменений нет';

  return (
    <details className={styles.disclosure}>
      <summary className={styles.summary}>
        <span className={styles.summaryHead}>
          <ChevronRight size={16} className={styles.chevron} aria-hidden="true" />
          <span className={styles.summaryTitle}>История изменений условий оплаты</span>
        </span>
        <span className={historyQuery.isError ? `${styles.summaryMeta} ${styles.summaryMetaError}` : styles.summaryMeta}>
          {meta}
        </span>
      </summary>

      <div className={styles.content}>
        {historyQuery.isPending && <p className={styles.state}>Загрузка…</p>}
        {historyQuery.isError && (
          <div className={styles.stateError}>
            <span>Не удалось загрузить историю</span>
            <button type="button" className={styles.retryButton} onClick={() => { void historyQuery.refetch(); }}>
              Повторить
            </button>
          </div>
        )}

        {data && data.length === 0 && <p className={styles.state}>Изменений условий оплаты пока нет.</p>}

        {data && data.length > 0 && (
          <ul className={styles.list}>
            {data.map(change => {
              if (change.kind === 'supplement') return renderSupplementChange(change);
              const delta = formatDelta(change);
              const calcChanged = change.prev_calc_type !== null && change.prev_calc_type !== change.calc_type;
              return (
                <li key={`salary-${change.effective_from}`} className={styles.item}>
                  <div className={styles.itemHead}>
                    <span className={styles.itemSecondary}>{formatPeriod(change)}</span>
                    {delta && <span className={delta.isDown ? styles.deltaDown : styles.deltaUp}>{delta.text}</span>}
                  </div>
                  <div className={styles.amounts}>
                    {change.prev_amount !== null && change.prev_calc_type !== null ? (
                      <>
                        <span className={styles.prevAmount}>было {formatAmount(change.prev_amount, change.prev_calc_type)}</span>
                        <span className={styles.prevAmount} aria-hidden="true">→</span>
                        <span className={styles.amount}>стало {formatAmount(change.amount, change.calc_type)}</span>
                      </>
                    ) : (
                      <span className={styles.amount}>назначено {formatAmount(change.amount, change.calc_type)}</span>
                    )}
                  </div>
                  {calcChanged && change.prev_calc_type !== null && (
                    <div className={styles.itemMeta}>
                      Смена вида оплаты: {CALC_TYPE_LABELS[change.prev_calc_type]} → {CALC_TYPE_LABELS[change.calc_type]}
                    </div>
                  )}
                  <div className={styles.itemMeta}>{formatAuthor(change)}</div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </details>
  );
};
