import type { FC } from 'react';
import { ChevronRight } from 'lucide-react';

import type { PayrollPaidApi } from '../../hooks/usePayrollPaid';
import { accrualPeriodCrossesYear, formatAccrualMonthLabel } from '../../utils/payrollAccruals';
import { formatMonthsLabel } from '../../utils/monthsSelection';
import {
  formatPaidAmount,
  PAYROLL_PAID_TOTALS,
  paidCellKey,
  type IPayrollPaidItem,
} from '../../utils/payrollPaid';
import styles from './PayrollPaidTable.module.css';

interface IPayrollPaidTableProps {
  paid: PayrollPaidApi;
  /** Префикс id блока таблиц. */
  idPrefix: string;
}

const formatTotal = (value: number | null): string => (value === null ? '—' : formatPaidAmount(value));

/**
 * «Оплачено» за выбранные месяцы, только чтение (суммы приходят из 1С): по таблице на месяц, в ряд,
 * под ними — строка «Оплачено» с итогами за все месяцы. Свёрнуто (по умолчанию) — в таблицах только
 * итоги «Начислено · Удержано». Раскрыто — статьи по группам ведомости ЗУП, но лишь те, по которым за
 * месяц есть сумма; итоги остаются внизу. Узко — таблицы встают друг под друга, каждая прокручивается
 * вбок, подписи строк закреплены слева.
 */
export const PayrollPaidTable: FC<IPayrollPaidTableProps> = ({ paid, idPrefix }) => {
  const tablesId = `${idPrefix}-paid-tables`;
  const withYear = accrualPeriodCrossesYear(paid.months);
  const ready = paid.status === 'ready';

  // «июль 2026 — сентябрь 2026 · начислено 1 234 ₽ · удержано 100 ₽» — пустые итоги не называем.
  const summary = [
    formatMonthsLabel(paid.months),
    ...(ready
      ? PAYROLL_PAID_TOTALS
        .filter(({ kind }) => paid.totals.overall[kind] !== null)
        .map(({ kind, label }) => `${label.toLowerCase()} ${formatTotal(paid.totals.overall[kind])} ₽`)
      : []),
  ].join(' · ');

  const renderRow = (month: string, item: IPayrollPaidItem, nested: boolean) => {
    const value = paid.amounts.get(paidCellKey(month, item.code));
    return (
      <tr key={item.code}>
        <th scope="row" className={nested ? `${styles.rowHead} ${styles.rowHeadNested}` : styles.rowHead}>
          {item.label}
        </th>
        <td className={styles.value}>{value === undefined ? '—' : formatPaidAmount(value)}</td>
      </tr>
    );
  };

  return (
    <div className={styles.paid}>
      <div id={tablesId} className={styles.tables}>
        {paid.months.map(month => {
          const monthLabel = formatAccrualMonthLabel(month, withYear);
          return (
            <div key={month} className={styles.scroll}>
              <table className={styles.table} aria-label={`Оплачено, ${monthLabel}`}>
                <thead>
                  <tr>
                    <td className={styles.corner} />
                    <th scope="col" className={styles.monthHead}>{monthLabel}</th>
                  </tr>
                </thead>
                {paid.expanded && ready && (paid.groupsByMonth[month] ?? []).map(group => (
                  <tbody key={group.label ?? 'main'}>
                    {group.label && (
                      <tr>
                        <th scope="rowgroup" colSpan={2} className={styles.groupHead}>
                          <span className={styles.groupLabel}>{group.label}</span>
                        </th>
                      </tr>
                    )}
                    {group.items.map(item => renderRow(month, item, group.label !== null))}
                  </tbody>
                ))}
                <tfoot>
                  {PAYROLL_PAID_TOTALS.map(({ kind, label }) => (
                    <tr key={kind}>
                      <th scope="row" className={`${styles.rowHead} ${styles.totalHead}`}>{label}</th>
                      <td className={styles.total}>{ready ? formatTotal(paid.totals.byMonth[month][kind]) : ''}</td>
                    </tr>
                  ))}
                </tfoot>
              </table>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={paid.expanded}
        aria-controls={tablesId}
        onClick={paid.toggleExpanded}
      >
        <ChevronRight size={16} className={styles.chevron} aria-hidden="true" />
        <span className={styles.title}>Оплачено</span>
        <span className={styles.summary}>{summary}</span>
      </button>
      {paid.status === 'loading' && <p className={styles.note}>Загрузка…</p>}
      {paid.status === 'error' && <p className={styles.note} role="alert">Не удалось загрузить суммы</p>}
    </div>
  );
};
