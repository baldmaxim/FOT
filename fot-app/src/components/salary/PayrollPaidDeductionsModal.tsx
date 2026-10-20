import { useId, useMemo, type CSSProperties, type FC } from 'react';
import { X } from 'lucide-react';

import type { IPayrollTermsRow } from '../../services/payrollService';
import { accrualPeriodCrossesYear, formatAccrualMonthLabel } from '../../utils/payrollAccruals';
import {
  formatPaidAmount,
  paidAmountMonths,
  paidCellKey,
  paidItemTotal,
  paidTotals,
  toPaidAmounts,
  visiblePaidGroups,
} from '../../utils/payrollPaid';
import { ModalShell } from '../ui/ModalShell';
import modal from './PayrollModal.module.css';
import paidTable from './PayrollPaidTable.module.css';
import styles from './PayrollPaidDeductionsModal.module.css';

interface IPayrollPaidDeductionsModalProps {
  row: IPayrollTermsRow;
  /** Период сумм строки — тот же, что под заголовком столбца «Удержания». */
  period: string;
  onClose: () => void;
}

const formatTotal = (value: number | null): string => (value === null ? '—' : formatPaidAmount(value));

/**
 * «Расчёты» → клик по сумме удержаний: статьи «Удержано» ЗУП строками, месяцы с суммами — столбцами
 * (при нескольких — «Итого» справа), строка «Итого» снизу. Только чтение; таблица — как «Оплачено» в «Подробно».
 */
export const PayrollPaidDeductionsModal: FC<IPayrollPaidDeductionsModalProps> = ({ row, period, onClose }) => {
  const titleId = useId();
  const { months, amounts, items, totals } = useMemo(() => {
    const rows = row.paid_deductions ?? [];
    const dataMonths = paidAmountMonths(rows);
    const dataAmounts = toPaidAmounts(rows);
    return {
      months: dataMonths,
      amounts: dataAmounts,
      items: visiblePaidGroups(dataMonths, dataAmounts)
        .filter(group => group.kind === 'deducted')
        .flatMap(group => group.items),
      totals: paidTotals(dataMonths, dataAmounts),
    };
  }, [row.paid_deductions]);

  const withYear = accrualPeriodCrossesYear(months);
  // Один месяц — «Итого» справа повторял бы его столбец, одна статья — строка «Итого» повторяла бы её.
  const withTotalColumn = months.length > 1;
  const withTotalRow = items.length > 1;
  const widthVars = { '--paid-cols': months.length + (withTotalColumn ? 1 : 0) } as CSSProperties;

  return (
    <ModalShell
      onClose={onClose}
      overlayClassName={modal.overlay}
      containerClassName={styles.container}
      aria-labelledby={titleId}
    >
      {({ requestClose }) => (
        <>
          <header className={modal.header}>
            <div className={modal.headerText}>
              <h2 id={titleId} className={modal.title}>Удержания</h2>
              <p className={styles.subtitle}>{row.full_name ?? '—'} · {period}</p>
            </div>
            <button type="button" className={modal.closeButton} onClick={requestClose} aria-label="Закрыть">
              <X size={20} aria-hidden="true" />
            </button>
          </header>

          <div className={modal.body}>
            <div className={paidTable.scroll} style={widthVars}>
              <table className={paidTable.table} aria-labelledby={titleId}>
                <thead>
                  <tr>
                    <td className={paidTable.corner} />
                    {months.map(month => (
                      <th key={month} scope="col" className={paidTable.monthHead}>
                        {formatAccrualMonthLabel(month, withYear)}
                      </th>
                    ))}
                    {withTotalColumn && <th scope="col" className={paidTable.monthHead}>Итого</th>}
                  </tr>
                </thead>
                <tbody>
                  {items.map(item => (
                    <tr key={item.code}>
                      <th scope="row" className={paidTable.rowHead}>{item.label}</th>
                      {months.map(month => {
                        const value = amounts.get(paidCellKey(month, item.code));
                        return (
                          <td key={month} className={paidTable.value}>
                            {value === undefined ? '—' : formatPaidAmount(value)}
                          </td>
                        );
                      })}
                      {withTotalColumn && (
                        <td className={paidTable.value}>{formatTotal(paidItemTotal(months, amounts, item.code))}</td>
                      )}
                    </tr>
                  ))}
                  {withTotalRow && (
                    <tr>
                      <th scope="row" className={`${paidTable.rowHead} ${paidTable.totalHead}`}>Итого</th>
                      {months.map(month => (
                        <td key={month} className={paidTable.total}>{formatTotal(totals.byMonth[month].deducted)}</td>
                      ))}
                      {withTotalColumn && <td className={paidTable.total}>{formatTotal(totals.overall.deducted)}</td>}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </ModalShell>
  );
};
