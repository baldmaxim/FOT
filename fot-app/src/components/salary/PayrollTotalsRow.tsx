import { memo, useMemo, type FC, type ReactNode } from 'react';

import type { IPayrollTermsRow } from '../../services/payrollService';
import { cx } from '../../utils/motion';
import {
  payrollColumnTotals,
  payrollTotalState,
  type IPayrollColumnTotal,
  type IPayrollTotalsStatus,
} from '../../utils/payrollCalcTotals';
import { formatPaidAmount } from '../../utils/payrollPaid';
import type { PayrollTableColumnEntry } from '../../utils/payrollSubColumns';
import styles from './PayrollTermsTable.module.css';

interface IPayrollTotalsRowProps {
  rows: readonly IPayrollTermsRow[];
  /** Те же столбцы по порядку, что в colgroup, шапке и строках. */
  columns: readonly PayrollTableColumnEntry[];
  status: IPayrollTotalsStatus;
  /** Оформление групп «+» по ключу столбца — как в ячейках строк. */
  groupCellClass: (key: string) => string | undefined;
}

/**
 * «Итого» «Расчётов»: подвал той же таблицы, закреплён снизу обёртки (sticky), как шапка сверху. Столбцы совпадают сами,
 * при прокрутке вбок едет вместе с таблицей, а последняя строка списка не уходит под него.
 */
export const PayrollTotalsRow: FC<IPayrollTotalsRowProps> = memo(({ rows, columns, status, groupCellClass }) => {
  const totals = useMemo(() => payrollColumnTotals(rows, columns), [rows, columns]);

  const renderAmount = (total: IPayrollColumnTotal): ReactNode => {
    const state = payrollTotalState(status, total.fromCalc);
    if (state === 'pending') return <span className={styles.calcMuted} aria-label="Считается">…</span>;
    if (state === 'failed' || total.amount === null) return '—';
    return (
      <>
        {formatPaidAmount(Number(total.amount))}
        {total.missing > 0 && <span className={styles.calcSub}>без {total.missing} чел.</span>}
      </>
    );
  };

  return (
    <tfoot>
      <tr>
        <td className={`${styles.stickyNum} ${styles.cellNum}`} />
        <td className={styles.stickyName}>Итого</td>
        {columns.map(entry => {
          const total = totals.get(entry.key);
          const className = groupCellClass(entry.key);
          if (!total) return <td key={entry.key} className={className} />;
          // Подсказка — только когда итог готов: иначе она говорила бы о части выборки.
          const ready = payrollTotalState(status, total.fromCalc) === 'ready';
          return (
            <td key={entry.key} className={cx(styles.cellNumber, className)} title={ready ? total.title ?? undefined : undefined}>
              {renderAmount(total)}
            </td>
          );
        })}
      </tr>
    </tfoot>
  );
});

PayrollTotalsRow.displayName = 'PayrollTotalsRow';
