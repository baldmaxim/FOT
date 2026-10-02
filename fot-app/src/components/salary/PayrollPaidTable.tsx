import type { FC } from 'react';

import type { PayrollPaidApi } from '../../hooks/usePayrollPaid';
import { accrualPeriodCrossesYear, formatAccrualMonthLabel } from '../../utils/payrollAccruals';
import {
  PAYROLL_PAID_GROUP_ITEMS,
  PAYROLL_PAID_GROUP_LABEL,
  PAYROLL_PAID_MAIN_ITEMS,
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

/**
 * «Оплачено»: статьи строками, месяцы столбцами, ячейки — поля ввода. Без права правки и пока суммы
 * не загружены — текст. Узко — таблица прокручивается вбок, подписи статей закреплены слева.
 */
export const PayrollPaidTable: FC<IPayrollPaidTableProps> = ({ paid, idPrefix, readOnly = false }) => {
  const labelId = `${idPrefix}-paid`;
  const errorId = `${idPrefix}-paid-error`;
  const withYear = accrualPeriodCrossesYear(paid.months);
  const editable = paid.status === 'ready' && !readOnly;
  const hasErrors = paid.invalidKeys.size > 0;

  const renderCell = (item: IPayrollPaidItem, month: string) => {
    const key = paidCellKey(month, item.code);
    if (!editable) {
      const text = paid.status === 'ready' ? paid.savedValue(key) ?? '—' : '';
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

  const renderRow = (item: IPayrollPaidItem, nested = false) => (
    <tr key={item.code}>
      <th scope="row" className={nested ? `${styles.rowHead} ${styles.rowHeadNested}` : styles.rowHead}>
        {item.label}
      </th>
      {paid.months.map(month => renderCell(item, month))}
    </tr>
  );

  return (
    <div className={styles.paid}>
      <span id={labelId} className={styles.label}>Оплачено</span>
      <div className={styles.scroll}>
        <table className={styles.table} aria-labelledby={labelId}>
          <thead>
            <tr>
              <td className={styles.corner} />
              {paid.months.map(month => (
                <th key={month} scope="col" className={styles.monthHead}>{formatAccrualMonthLabel(month, withYear)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PAYROLL_PAID_MAIN_ITEMS.map(item => renderRow(item))}
          </tbody>
          <tbody>
            <tr>
              <th scope="rowgroup" colSpan={paid.months.length + 1} className={styles.groupHead}>
                <span className={styles.groupLabel}>{PAYROLL_PAID_GROUP_LABEL}</span>
              </th>
            </tr>
            {PAYROLL_PAID_GROUP_ITEMS.map(item => renderRow(item, true))}
          </tbody>
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
