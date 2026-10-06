import type { FC, KeyboardEvent } from 'react';

import type { IPayrollDeductionKind, IPayrollTermsRow } from '../../services/payrollService';
import { formatPayrollMoney } from '../../utils/payrollFormat';
import styles from './PayrollTermsTable.module.css';

interface IPayrollDeductionsTableProps {
  rows: IPayrollTermsRow[];
  /** Виды справочника — столбцы в его порядке. */
  kinds: IPayrollDeductionKind[];
  /** Клик по строке — карточка «Подробно»; не передан — строки не кликабельны (нет права на условия). */
  onOpen?: (row: IPayrollTermsRow) => void;
}

const formatAmount = (value: string | number | null | undefined): string => {
  const money = formatPayrollMoney(value);
  return money === null ? '—' : `${money} ₽/мес`;
};

/**
 * «Расчёты»: сотрудники с удержанием, столбцы — виды справочника и «Итого». Вид таблицы — как у
 * «Условий оплаты» (те же стили), без чекбоксов, сортировок и шестерёнки. Строк немного — без
 * виртуализации. Вид удержания у сотрудника один, поэтому «Итого» равно его сумме.
 */
export const PayrollDeductionsTable: FC<IPayrollDeductionsTableProps> = ({ rows, kinds, onOpen }) => {
  const columnCount = 5 + kinds.length;

  const handleKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, row: IPayrollTermsRow) => {
    if (!onOpen || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    onOpen(row);
  };

  return (
    <div className={styles.wrap}>
      <table className={`${styles.table} ${styles.tableNoCheck}`}>
        <colgroup>
          <col className={styles.colNum} />
          <col className={styles.colName} />
          <col className={styles.colDept} />
          <col className={styles.colPosition} />
          {kinds.map(kind => <col key={kind.id} className={styles.colKind} />)}
          <col className={styles.colKind} />
        </colgroup>
        <thead>
          <tr>
            <th className={`${styles.stickyNum} ${styles.cellNum}`}>№</th>
            <th className={styles.stickyName}>Сотрудник</th>
            <th>Подразделение</th>
            <th>Должность</th>
            {kinds.map(kind => <th key={kind.id}>{kind.name}</th>)}
            <th>Итого</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columnCount} className={styles.empty}>Удержаний нет</td>
            </tr>
          ) : rows.map((row, index) => (
            <tr
              key={row.employee_id}
              className={[onOpen ? styles.rowClickable : '', index % 2 === 1 ? styles.rowEven : ''].filter(Boolean).join(' ') || undefined}
              tabIndex={onOpen ? 0 : undefined}
              aria-label={onOpen ? `Условия оплаты: ${row.full_name ?? 'сотрудник'}` : undefined}
              onClick={onOpen ? () => onOpen(row) : undefined}
              onKeyDown={onOpen ? event => handleKeyDown(event, row) : undefined}
            >
              <td className={`${styles.stickyNum} ${styles.cellNum}`}>{index + 1}</td>
              <td className={`${styles.stickyName} ${styles.cellName}`}>
                <span className={styles.clamp2}>{row.full_name ?? '—'}</span>
              </td>
              <td><span className={styles.clamp3}>{row.department_name ?? '—'}</span></td>
              <td><span className={styles.clamp3}>{row.position_name ?? '—'}</span></td>
              {kinds.map(kind => (
                <td key={kind.id} className={styles.cellNumber}>
                  {row.deduction_kind_id === kind.id ? formatAmount(row.deduction_amount) : '—'}
                </td>
              ))}
              <td className={styles.cellNumber}>{formatAmount(row.deduction_amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
