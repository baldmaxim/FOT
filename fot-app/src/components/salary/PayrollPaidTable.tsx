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
  /** Префикс id блока статей. */
  idPrefix: string;
}

const formatTotal = (value: number | null): string => (value === null ? '—' : formatPaidAmount(value));

/**
 * «Оплачено» за выбранные месяцы, только чтение (суммы приходят из 1С). Сверху — по таблице итогов
 * «Начислено · Удержано» на месяц, в ряд; под ними — строка «Оплачено» с итогами за все месяцы.
 * Клик по ней раскрывает ниже статьи по группам ведомости ЗУП (по таблице на месяц, лишь статьи с суммой
 * за месяц) — итоги и сама строка при этом не сдвигаются. Узко — таблицы встают друг под друга.
 */
export const PayrollPaidTable: FC<IPayrollPaidTableProps> = ({ paid, idPrefix }) => {
  const detailsId = `${idPrefix}-paid-details`;
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

  /** Шапка таблицы месяца — одна у итогов и у статей: столбцы одинаковой ширины стоят друг под другом. */
  const renderHead = (monthLabel: string) => (
    <thead>
      <tr>
        <td className={styles.corner} />
        <th scope="col" className={styles.monthHead}>{monthLabel}</th>
      </tr>
    </thead>
  );

  return (
    <div className={styles.paid}>
      {/* Итоги месяцев — всегда на месте: раскрытие их не двигает. */}
      <div className={styles.tables}>
        {paid.months.map(month => {
          const monthLabel = formatAccrualMonthLabel(month, withYear);
          return (
            <div key={month} className={styles.scroll}>
              <table className={styles.table} aria-label={`Оплачено, ${monthLabel}`}>
                {renderHead(monthLabel)}
                <tbody>
                  {PAYROLL_PAID_TOTALS.map(({ kind, label }) => (
                    <tr key={kind}>
                      <th scope="row" className={`${styles.rowHead} ${styles.totalHead}`}>{label}</th>
                      <td className={styles.total}>{ready ? formatTotal(paid.totals.byMonth[month][kind]) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={paid.expanded}
        aria-controls={detailsId}
        onClick={paid.toggleExpanded}
      >
        <ChevronRight size={16} className={styles.chevron} aria-hidden="true" />
        <span className={styles.title}>Оплачено</span>
        <span className={styles.summary}>{summary}</span>
      </button>
      {/* Статьи — под строкой «Оплачено»: она остаётся на месте, свернуть можно тем же кликом. */}
      {paid.expanded && ready && (
        <div id={detailsId} className={styles.tables}>
          {paid.months.map(month => {
            const monthLabel = formatAccrualMonthLabel(month, withYear);
            const groups = paid.groupsByMonth[month] ?? [];
            return (
              <div key={month} className={styles.scroll}>
                <table className={styles.table} aria-label={`Оплачено подробно, ${monthLabel}`}>
                  {renderHead(monthLabel)}
                  {/* Сумм по статьям нет — прочерк в столбце сумм, как у пустых итогов. */}
                  {groups.length === 0 && (
                    <tbody>
                      <tr>
                        <td className={styles.rowHead} />
                        <td className={styles.value}>—</td>
                      </tr>
                    </tbody>
                  )}
                  {groups.map(group => (
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
                </table>
              </div>
            );
          })}
        </div>
      )}
      {paid.status === 'loading' && <p className={styles.note}>Загрузка…</p>}
      {paid.status === 'error' && <p className={styles.note} role="alert">Не удалось загрузить суммы</p>}
    </div>
  );
};
