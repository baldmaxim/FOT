import type { CSSProperties, FC } from 'react';
import { ChevronRight } from 'lucide-react';

import type { PayrollPaidApi } from '../../hooks/usePayrollPaid';
import { accrualPeriodCrossesYear, formatAccrualMonthLabel } from '../../utils/payrollAccruals';
import {
  formatPaidAmount,
  paidCellKey,
  paidItemTotal,
  paidPayout,
  type IPayrollPaidItem,
} from '../../utils/payrollPaid';
import styles from './PayrollPaidTable.module.css';

interface IPayrollPaidTableProps {
  paid: PayrollPaidApi;
}

const formatTotal = (value: number | null): string => (value === null ? '—' : formatPaidAmount(value));

/**
 * «Оплачено» за выбранные месяцы, только чтение (суммы приходят из 1С). Месяцы — столбцами: добавили месяц —
 * таблица наращивается; при нескольких месяцах справа столбец «Итого» — сумма за все выбранные. Сверху — итог
 * «Выплачено»: расчётное «К выплате» по данным 1С — начислено минус удержано (как в «Истории выплат», на «Расчётах»
 * и в «Своде»), без НДФЛ. Клик по его строке раскрывает ниже статьи по группам ведомости ЗУП (с удержаниями) —
 * в той же таблице, сам итог при этом не сдвигается. Таблица прокручивается вбок, подписи закреплены слева.
 */
export const PayrollPaidTable: FC<IPayrollPaidTableProps> = ({ paid }) => {
  const withYear = accrualPeriodCrossesYear(paid.months);
  const ready = paid.status === 'ready';
  // Один месяц — «Итого» повторял бы его столбец.
  const withTotal = paid.months.length > 1;
  // Ширина таблицы — по числу столбцов сумм (см. .table в CSS).
  const widthVars = { '--paid-cols': paid.months.length + (withTotal ? 1 : 0) } as CSSProperties;

  const renderRow = (item: IPayrollPaidItem, nested: boolean) => (
    <tr key={item.code}>
      <th scope="row" className={nested ? `${styles.rowHead} ${styles.rowHeadNested}` : styles.rowHead}>
        {item.label}
      </th>
      {paid.months.map(month => {
        const value = paid.amounts.get(paidCellKey(month, item.code));
        return <td key={month} className={styles.value}>{value === undefined ? '—' : formatPaidAmount(value)}</td>;
      })}
      {withTotal && (
        <td className={styles.value}>{formatTotal(paidItemTotal(paid.months, paid.amounts, item.code))}</td>
      )}
    </tr>
  );

  return (
    <div className={styles.paid}>
      <div className={styles.scroll} style={widthVars}>
        <table className={styles.table} aria-label="Выплачено по месяцам">
          <thead>
            <tr>
              <td className={styles.corner} />
              {paid.months.map(month => (
                <th key={month} scope="col" className={styles.monthHead}>{formatAccrualMonthLabel(month, withYear)}</th>
              ))}
              {withTotal && <th scope="col" className={styles.monthHead}>Итого</th>}
            </tr>
          </thead>
          {/* Итоги — всегда на месте: статьи раскрываются под ними. Клик и Enter/Space с кнопки всплывают до строки. */}
          <tbody>
            <tr className={styles.totalRow} onClick={paid.toggleExpanded}>
              <th scope="row" className={`${styles.rowHead} ${styles.totalHead}`}>
                <button type="button" className={styles.totalToggle} aria-expanded={paid.expanded}>
                  <ChevronRight size={16} className={styles.chevron} aria-hidden="true" />
                  Выплачено
                </button>
              </th>
              {paid.months.map(month => (
                <td key={month} className={styles.total}>
                  {ready ? formatTotal(paidPayout(paid.totals.byMonth[month])) : ''}
                </td>
              ))}
              {withTotal && (
                <td className={styles.total}>{ready ? formatTotal(paidPayout(paid.totals.overall)) : ''}</td>
              )}
            </tr>
          </tbody>
          {/* Сумм по статьям нет — прочерк в столбцах сумм, как у пустых итогов. */}
          {paid.expanded && ready && paid.groups.length === 0 && (
            <tbody>
              <tr>
                <td className={styles.rowHead} />
                {paid.months.map(month => <td key={month} className={styles.value}>—</td>)}
                {withTotal && <td className={styles.value}>—</td>}
              </tr>
            </tbody>
          )}
          {paid.expanded && ready && paid.groups.map(group => (
            <tbody key={group.label ?? 'main'}>
              {group.label && (
                <tr>
                  <th
                    scope="rowgroup"
                    colSpan={paid.months.length + (withTotal ? 2 : 1)}
                    className={styles.groupHead}
                  >
                    <span className={styles.groupLabel}>{group.label}</span>
                  </th>
                </tr>
              )}
              {group.items.map(item => renderRow(item, group.label !== null))}
            </tbody>
          ))}
        </table>
      </div>
      {paid.status === 'loading' && <p className={styles.note}>Загрузка…</p>}
      {paid.status === 'error' && <p className={styles.note} role="alert">Не удалось загрузить суммы</p>}
    </div>
  );
};
