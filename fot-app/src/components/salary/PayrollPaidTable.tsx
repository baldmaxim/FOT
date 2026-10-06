import type { FC } from 'react';
import { ChevronRight } from 'lucide-react';

import type { PayrollPaidApi } from '../../hooks/usePayrollPaid';
import { accrualPeriodCrossesYear, formatAccrualMonthLabel, formatAccrualPeriodLong } from '../../utils/payrollAccruals';
import {
  formatPaidAmount,
  PAYROLL_PAID_GROUPS,
  PAYROLL_PAID_TOTALS,
  paidCellId,
  paidCellKey,
  type IPayrollPaidItem,
} from '../../utils/payrollPaid';
import styles from './PayrollPaidTable.module.css';

interface IPayrollPaidTableProps {
  paid: PayrollPaidApi;
  /** Префикс id ячеек: по нему карточка ставит фокус на первую ячейку с ошибкой. */
  idPrefix: string;
  readOnly?: boolean;
}

const formatTotal = (value: number | null): string => (value === null ? '—' : formatPaidAmount(value));

/**
 * «Оплачено» за выбранный месяц. Свёрнуто (по умолчанию) — только итоги «Начислено · Удержано»,
 * они же — в заголовке. Раскрыто — статьи по группам ведомости ЗУП, ячейки —
 * поля ввода; итоги остаются внизу и пересчитываются по мере ввода. Без права правки и пока суммы
 * не загружены — текст. Узко — таблица прокручивается вбок, подписи строк закреплены слева.
 */
export const PayrollPaidTable: FC<IPayrollPaidTableProps> = ({ paid, idPrefix, readOnly = false }) => {
  const labelId = `${idPrefix}-paid`;
  const tableId = `${idPrefix}-paid-table`;
  const errorId = `${idPrefix}-paid-error`;
  const withYear = accrualPeriodCrossesYear(paid.months);
  const ready = paid.status === 'ready';
  const editable = ready && !readOnly;
  const hasErrors = paid.invalidKeys.size > 0;

  // «сентябрь 2026 · начислено 1 234 ₽ · удержано 100 ₽» — пустые итоги не называем.
  const summary = [
    formatAccrualPeriodLong(paid.months),
    ...(ready
      ? PAYROLL_PAID_TOTALS
        .filter(({ kind }) => paid.totals.overall[kind] !== null)
        .map(({ kind, label }) => `${label.toLowerCase()} ${formatTotal(paid.totals.overall[kind])} ₽`)
      : []),
  ].join(' · ');

  const renderCell = (item: IPayrollPaidItem, month: string) => {
    const key = paidCellKey(month, item.code);
    if (!editable) {
      const text = ready ? paid.savedValue(key) ?? '—' : '';
      return <td key={month} className={styles.value}>{text}</td>;
    }
    const invalid = paid.invalidKeys.has(key);
    return (
      <td key={month} className={styles.cell}>
        <input
          id={paidCellId(idPrefix, key)}
          className={styles.input}
          // У «decimal» на iPhone нет минуса — перерасчёту нужна обычная клавиатура.
          inputMode={item.allowNegative ? 'text' : 'decimal'}
          autoComplete="off"
          value={paid.cellValue(key)}
          aria-label={`${item.label}, ${formatAccrualMonthLabel(month, true)}`}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={invalid ? errorId : undefined}
          onChange={event => paid.changeCell(key, event.target.value)}
          onBlur={() => paid.normalizeCell(key, item.allowNegative)}
        />
      </td>
    );
  };

  const renderRow = (item: IPayrollPaidItem, nested: boolean) => (
    <tr key={item.code}>
      <th scope="row" className={nested ? `${styles.rowHead} ${styles.rowHeadNested}` : styles.rowHead}>
        {item.label}
      </th>
      {paid.months.map(month => renderCell(item, month))}
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
          {paid.expanded && PAYROLL_PAID_GROUPS.map(group => (
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
      {hasErrors && (
        <p id={errorId} className={styles.error}>
          Сумма — число, не больше двух знаков после запятой; минус — только у перерасчёта
        </p>
      )}
    </div>
  );
};
