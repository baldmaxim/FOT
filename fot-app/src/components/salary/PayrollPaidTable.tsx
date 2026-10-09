import type { CSSProperties, FC } from 'react';
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
 * «Оплачено» за выбранные месяцы, только чтение (суммы приходят из 1С). Месяцы — столбцами: добавили месяц —
 * таблица наращивается. Сверху — итог «Выплачено» по месяцам; под ним строка «Оплачено» с итогом за все месяцы.
 * Клик по ней раскрывает ниже статьи по группам ведомости ЗУП (с удержаниями) — с теми же столбцами месяцев,
 * итоги и сама строка при этом не сдвигаются. Обе таблицы прокручиваются вбок вместе, подписи закреплены слева.
 */
export const PayrollPaidTable: FC<IPayrollPaidTableProps> = ({ paid, idPrefix }) => {
  const detailsId = `${idPrefix}-paid-details`;
  const withYear = accrualPeriodCrossesYear(paid.months);
  const ready = paid.status === 'ready';
  // Ширина таблиц — по числу месяцев: столбцы итогов и статей совпадают (см. .table в CSS).
  const widthVars = { '--paid-months': paid.months.length } as CSSProperties;

  // «июль 2026 — сентябрь 2026 · выплачено 1 234 ₽» — пустой итог не называем.
  const summary = [
    formatMonthsLabel(paid.months),
    ...(ready
      ? PAYROLL_PAID_TOTALS
        .filter(({ kind }) => paid.totals.overall[kind] !== null)
        .map(({ kind, label }) => `${label.toLowerCase()} ${formatTotal(paid.totals.overall[kind])} ₽`)
      : []),
  ].join(' · ');

  /** Шапка — одна у итогов и у статей: столбцы месяцев стоят друг под другом. */
  const head = (
    <thead>
      <tr>
        <td className={styles.corner} />
        {paid.months.map(month => (
          <th key={month} scope="col" className={styles.monthHead}>{formatAccrualMonthLabel(month, withYear)}</th>
        ))}
      </tr>
    </thead>
  );

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
      <div className={styles.scroll} style={widthVars}>
        <div className={styles.inner}>
          {/* Итоги — всегда на месте: раскрытие их не двигает. */}
          <table className={styles.table} aria-label="Выплачено по месяцам">
            {head}
            <tbody>
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
            </tbody>
          </table>

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
            <table id={detailsId} className={styles.table} aria-label="Оплачено подробно по месяцам">
              {head}
              {/* Сумм по статьям нет — прочерк в столбцах месяцев, как у пустых итогов. */}
              {paid.groups.length === 0 && (
                <tbody>
                  <tr>
                    <td className={styles.rowHead} />
                    {paid.months.map(month => <td key={month} className={styles.value}>—</td>)}
                  </tr>
                </tbody>
              )}
              {paid.groups.map(group => (
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
            </table>
          )}
        </div>
      </div>
      {paid.status === 'loading' && <p className={styles.note}>Загрузка…</p>}
      {paid.status === 'error' && <p className={styles.note} role="alert">Не удалось загрузить суммы</p>}
    </div>
  );
};
