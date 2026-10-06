import type { FC } from 'react';
import { ChevronRight } from 'lucide-react';

import type { PayrollPaidApi } from '../../hooks/usePayrollPaid';
import { accrualPeriodCrossesYear, formatAccrualMonthLabel, formatAccrualPeriodLong } from '../../utils/payrollAccruals';
import {
  formatPaidAmount,
  PAYROLL_PAID_TOTALS,
  paidCellKey,
  type IPayrollPaidItem,
} from '../../utils/payrollPaid';
import styles from './PayrollPaidTable.module.css';

interface IPayrollPaidTableProps {
  paid: PayrollPaidApi;
  /** Префикс id заголовка и таблицы. */
  idPrefix: string;
}

const formatTotal = (value: number | null): string => (value === null ? '—' : formatPaidAmount(value));

/**
 * «Оплачено» за выбранный месяц, только чтение (суммы приходят из 1С). Свёрнуто (по умолчанию) —
 * только итоги «Начислено · Удержано», они же — в заголовке. Раскрыто — статьи по группам ведомости
 * ЗУП, но лишь те, по которым сумма есть; итоги остаются внизу. Узко — таблица прокручивается вбок,
 * подписи строк закреплены слева.
 */
export const PayrollPaidTable: FC<IPayrollPaidTableProps> = ({ paid, idPrefix }) => {
  const labelId = `${idPrefix}-paid`;
  const tableId = `${idPrefix}-paid-table`;
  const withYear = accrualPeriodCrossesYear(paid.months);
  const ready = paid.status === 'ready';

  // «сентябрь 2026 · начислено 1 234 ₽ · удержано 100 ₽» — пустые итоги не называем.
  const summary = [
    formatAccrualPeriodLong(paid.months),
    ...(ready
      ? PAYROLL_PAID_TOTALS
        .filter(({ kind }) => paid.totals.overall[kind] !== null)
        .map(({ kind, label }) => `${label.toLowerCase()} ${formatTotal(paid.totals.overall[kind])} ₽`)
      : []),
  ].join(' · ');

  const renderRow = (item: IPayrollPaidItem, nested: boolean) => (
    <tr key={item.code}>
      <th scope="row" className={nested ? `${styles.rowHead} ${styles.rowHeadNested}` : styles.rowHead}>
        {item.label}
      </th>
      {paid.months.map(month => {
        const value = paid.amounts.get(paidCellKey(month, item.code));
        return <td key={month} className={styles.value}>{value === undefined ? '—' : formatPaidAmount(value)}</td>;
      })}
    </tr>
  );

  return (
    <div className={styles.paid}>
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={paid.expanded}
        aria-controls={tableId}
        onClick={paid.toggleExpanded}
      >
        <ChevronRight size={16} className={styles.chevron} aria-hidden="true" />
        <span id={labelId} className={styles.title}>Оплачено</span>
        <span className={styles.summary}>{summary}</span>
      </button>
      <div className={styles.scroll}>
        <table id={tableId} className={styles.table} aria-labelledby={labelId}>
          <thead>
            <tr>
              <td className={styles.corner} />
              {paid.months.map(month => (
                <th key={month} scope="col" className={styles.monthHead}>{formatAccrualMonthLabel(month, withYear)}</th>
              ))}
            </tr>
          </thead>
          {paid.expanded && ready && paid.groups.map(group => (
            <tbody key={group.label ?? 'main'}>
              {group.label && (
                <tr>
                  <th scope="rowgroup" colSpan={paid.months.length + 1} className={styles.groupHead}>
                    <span className={styles.groupLabel}>{group.label}</span>
                  </th>
                </tr>
              )}
              {group.items.map(item => renderRow(item, group.label !== null))}
            </tbody>
          ))}
          <tfoot>
            {PAYROLL_PAID_TOTALS.map(({ kind, label }) => (
              <tr key={kind}>
                <th scope="row" className={`${styles.rowHead} ${styles.totalHead}`}>{label}</th>
                {paid.months.map(month => (
                  <td key={month} className={styles.total}>
                    {ready ? formatTotal(paid.totals.byMonth[month][kind]) : ''}
                  </td>
                ))}
              </tr>
            ))}
          </tfoot>
        </table>
      </div>
      {paid.status === 'loading' && <p className={styles.note}>Загрузка…</p>}
      {paid.status === 'error' && <p className={styles.note} role="alert">Не удалось загрузить суммы</p>}
    </div>
  );
};
