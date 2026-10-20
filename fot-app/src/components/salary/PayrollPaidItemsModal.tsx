import { useId, useMemo, type CSSProperties, type FC } from 'react';
import { X } from 'lucide-react';

import type { IPayrollPaidAmount, IPayrollTermsRow } from '../../services/payrollService';
import { accrualPeriodCrossesYear, formatAccrualMonthLabel } from '../../utils/payrollAccruals';
import {
  formatPaidAmount,
  paidAmountMonths,
  paidCellKey,
  paidItemTotal,
  paidTotals,
  pickPaidKind,
  toPaidAmounts,
  visiblePaidGroups,
  type PayrollPaidTotalKind,
} from '../../utils/payrollPaid';
import { ModalShell } from '../ui/ModalShell';
import modal from './PayrollModal.module.css';
import paidTable from './PayrollPaidTable.module.css';
import styles from './PayrollPaidItemsModal.module.css';

interface IPayrollPaidItemsModalProps {
  /** Раздел ведомости ЗУП: «Начислено» или «Удержания» — заголовок, статьи и «Итого». */
  kind: PayrollPaidTotalKind;
  row: IPayrollTermsRow;
  /** Период сумм строки — тот же, что под заголовком столбца. */
  period: string;
  /** Суммы статей (статьи другого раздела отсекаются); null — ещё грузятся. */
  amounts: readonly IPayrollPaidAmount[] | null;
  /** Загрузка не удалась: сообщение и «Повторить». */
  error?: boolean;
  onRetry?: () => void;
  onClose: () => void;
}

const TITLES: Record<PayrollPaidTotalKind, string> = { accrued: 'Начислено', deducted: 'Удержания' };

const formatTotal = (value: number | null): string => (value === null ? '—' : formatPaidAmount(value));

/**
 * «Расчёты» → клик по сумме «Начислено» или «Удержания»: статьи раздела ЗУП строками, месяцы с суммами —
 * столбцами (при нескольких — «Итого» справа), строка «Итого» снизу. У начислений две группы — у второй
 * подзаголовок «Доп. начисления»; у удержаний группа одна, без подзаголовка. Только чтение; таблица — как
 * «Оплачено» в «Подробно».
 */
export const PayrollPaidItemsModal: FC<IPayrollPaidItemsModalProps> = ({
  kind,
  row,
  period,
  amounts: source,
  error = false,
  onRetry,
  onClose,
}) => {
  const titleId = useId();
  const data = useMemo(() => {
    if (!source) return null;
    const rows = pickPaidKind(source, kind);
    const months = paidAmountMonths(rows);
    const amounts = toPaidAmounts(rows);
    return {
      months,
      amounts,
      groups: visiblePaidGroups(months, amounts).filter(group => group.kind === kind),
      totals: paidTotals(months, amounts),
    };
  }, [source, kind]);

  const months = data?.months ?? [];
  const groups = data?.groups ?? [];
  const withYear = accrualPeriodCrossesYear(months);
  // Один месяц — «Итого» справа повторял бы его столбец, одна статья — строка «Итого» повторяла бы её.
  const withTotalColumn = months.length > 1;
  const withTotalRow = groups.reduce((count, group) => count + group.items.length, 0) > 1;
  // Подзаголовки — только когда групп несколько: одна группа и так названа заголовком окна.
  const withGroupHeads = groups.length > 1;
  const columnCount = months.length + (withTotalColumn ? 2 : 1);
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
              <h2 id={titleId} className={modal.title}>{TITLES[kind]}</h2>
              <p className={styles.subtitle}>{row.full_name ?? '—'} · {period}</p>
            </div>
            <button type="button" className={modal.closeButton} onClick={requestClose} aria-label="Закрыть">
              <X size={20} aria-hidden="true" />
            </button>
          </header>

          <div className={modal.body}>
            {!data && !error && <p className={styles.state}>Загрузка…</p>}
            {!data && error && (
              <div className={styles.stateError} role="alert">
                <span>Не удалось загрузить суммы</span>
                {onRetry && (
                  <button type="button" className={styles.retryButton} onClick={onRetry}>Повторить</button>
                )}
              </div>
            )}
            {data && groups.length === 0 && <p className={styles.state}>Сумм нет.</p>}

            {data && groups.length > 0 && (
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
                  {groups.map(group => {
                    const nested = withGroupHeads && group.label !== null;
                    return (
                      <tbody key={group.label ?? 'main'}>
                        {nested && (
                          <tr>
                            <th scope="rowgroup" colSpan={columnCount} className={paidTable.groupHead}>
                              <span className={paidTable.groupLabel}>{group.label}</span>
                            </th>
                          </tr>
                        )}
                        {group.items.map(item => (
                          <tr key={item.code}>
                            <th scope="row" className={nested ? `${paidTable.rowHead} ${paidTable.rowHeadNested}` : paidTable.rowHead}>
                              {item.label}
                            </th>
                            {months.map(month => {
                              const value = data.amounts.get(paidCellKey(month, item.code));
                              return (
                                <td key={month} className={paidTable.value}>
                                  {value === undefined ? '—' : formatPaidAmount(value)}
                                </td>
                              );
                            })}
                            {withTotalColumn && (
                              <td className={paidTable.value}>{formatTotal(paidItemTotal(months, data.amounts, item.code))}</td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    );
                  })}
                  {withTotalRow && (
                    <tbody>
                      <tr>
                        <th scope="row" className={`${paidTable.rowHead} ${paidTable.totalHead}`}>Итого</th>
                        {months.map(month => (
                          <td key={month} className={paidTable.total}>{formatTotal(data.totals.byMonth[month][kind])}</td>
                        ))}
                        {withTotalColumn && <td className={paidTable.total}>{formatTotal(data.totals.overall[kind])}</td>}
                      </tr>
                    </tbody>
                  )}
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </ModalShell>
  );
};
