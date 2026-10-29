import { useMemo, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';

import { paidHistoryQueryOptions, payouts1cHistoryQueryOptions } from '../../hooks/usePayrollPaid';
import { shiftMonth } from '../../utils/moscowDate';
import { formatAccrualMonthLabel } from '../../utils/payrollAccruals';
import {
  formatPaidAmount,
  paidHistory,
  type PayrollPaidTotalKind,
  type PayrollPaidTotals,
} from '../../utils/payrollPaid';
import { PaidPayslip } from './PaidPayslip';
import disclosure from './PayrollDisclosure.module.css';
import styles from './PaidHistoryPanel.module.css';

interface IPaidHistoryPanelProps {
  employeeId: number;
  /** Должность сотрудника — первая строка расчётного листка. */
  positionName: string | null;
  /** Последний месяц истории — месяц карточки на момент открытия (тот же у «Экспорта»). */
  toMonth: string;
}

type SumKind = PayrollPaidTotalKind | 'payout' | 'transferred';

const SUM_COLUMNS: ReadonlyArray<{ kind: SumKind; label: string }> = [
  { kind: 'accrued', label: 'Начислено' },
  { kind: 'deducted', label: 'Удержано' },
  { kind: 'payout', label: 'К выплате' },
  { kind: 'transferred', label: 'Перечислено (1С)' },
];

const formatTotal = (value: number | null): string => (value === null ? '—' : formatPaidAmount(value));

const sumValue = (
  entry: { totals: PayrollPaidTotals; payout: number | null; transferred: number | null },
  kind: SumKind,
): number | null => {
  if (kind === 'payout') return entry.payout;
  if (kind === 'transferred') return entry.transferred;
  return entry.totals[kind];
};

/** Сколько прошлых месяцев видно в истории и без сумм 1С: у них «К выплате (ФОТ)» по закрытому табелю. */
const CALC_HISTORY_MONTHS = 6;

/**
 * Вкладка «История выплат» карточки сотрудника. Слева все месяцы, за которые из 1С пришли суммы «Оплачено» или
 * ведомости выплаты, и последние CALC_HISTORY_MONTHS закрытых месяцев (текущий не закрыт), по годам (новые сверху,
 * у года — итоги): «Начислено», «Удержано», «К выплате» (начислено минус удержано, как в «Своде») и «Перечислено (1С)» —
 * справочно, по месяцу начисления (миграция 328).
 * Справа — расчётный листок выбранного месяца (PaidPayslip), по умолчанию последнего.
 * Две колонки — когда хватает ширины карточки (container query), уже — одна: список, тап по месяцу
 * открывает листок, «Все месяцы» — назад. Только чтение.
 */
export const PaidHistoryPanel: FC<IPaidHistoryPanelProps> = ({ employeeId, positionName, toMonth }) => {
  const historyQuery = useQuery(paidHistoryQueryOptions(employeeId, toMonth));
  const payoutsQuery = useQuery(payouts1cHistoryQueryOptions(employeeId, toMonth));
  // Перечисления ещё грузятся — история ждёт их, иначе месяц только с перечислением появился бы позже.
  const history = useMemo(() => {
    if (!historyQuery.data || payoutsQuery.isPending) return null;
    const recent = Array.from({ length: CALC_HISTORY_MONTHS }, (_, index) => shiftMonth(toMonth, -1 - index));
    return paidHistory(historyQuery.data, payoutsQuery.data ?? [], recent);
  }, [historyQuery.data, payoutsQuery.isPending, payoutsQuery.data, toMonth]);
  const [pickedMonth, setPickedMonth] = useState<string | null>(null);
  // Узкая карточка: листок вместо списка. В две колонки видны оба, флаг не влияет.
  const [detailOpen, setDetailOpen] = useState(false);
  const selected = history?.months.find(entry => entry.month === pickedMonth) ?? history?.months[0] ?? null;

  const selectMonth = (month: string) => {
    setPickedMonth(month);
    setDetailOpen(true);
  };

  return (
    <div className={styles.panel}>
      {!history || !selected ? (
        <div className={styles.state}>
          {(historyQuery.isPending || (historyQuery.data && payoutsQuery.isPending)) && (
            <p className={disclosure.state}>Загрузка…</p>
          )}
          {historyQuery.isError && (
            <div className={disclosure.stateError}>
              <span>Не удалось загрузить выплаты</span>
              <button type="button" className={disclosure.retryButton} onClick={() => { void historyQuery.refetch(); }}>
                Повторить
              </button>
            </div>
          )}
          {history && <p className={disclosure.state}>Выплат из 1С пока нет.</p>}
        </div>
      ) : (
        <div className={styles.body} data-view={detailOpen ? 'detail' : 'list'}>
          <div className={styles.listPane}>
            {payoutsQuery.isError && (
              <div className={`${disclosure.stateError} ${styles.listNote}`}>
                <span>Не удалось загрузить «Перечислено (1С)»</span>
                <button type="button" className={disclosure.retryButton} onClick={() => { void payoutsQuery.refetch(); }}>
                  Повторить
                </button>
              </div>
            )}
            <table className={styles.list} aria-label="Месяцы">
              <thead>
                <tr>
                  <th scope="col">Месяц</th>
                  {SUM_COLUMNS.map(column => (
                    <th
                      key={column.kind}
                      scope="col"
                      className={column.kind === 'transferred' ? `${styles.num} ${styles.wrapHead}` : styles.num}
                    >
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              {history.years.map(year => (
                <tbody key={year.year}>
                  <tr className={styles.yearRow}>
                    <th scope="rowgroup">{year.year}</th>
                    {SUM_COLUMNS.map(column => (
                      <td key={column.kind} className={styles.num}>{formatTotal(sumValue(year, column.kind))}</td>
                    ))}
                  </tr>
                  {year.months.map(entry => {
                    const active = entry.month === selected.month;
                    return (
                      // Клик и Enter/Space с кнопки всплывают до строки.
                      <tr
                        key={entry.month}
                        className={active ? `${styles.monthRow} ${styles.monthRowActive}` : styles.monthRow}
                        onClick={() => selectMonth(entry.month)}
                      >
                        <th scope="row">
                          <button type="button" className={styles.monthButton} aria-pressed={active}>
                            {formatAccrualMonthLabel(entry.month, false)}
                          </button>
                        </th>
                        {SUM_COLUMNS.map(column => (
                          <td key={column.kind} className={styles.num}>{formatTotal(sumValue(entry, column.kind))}</td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              ))}
              {history.years.length > 1 && (
                <tfoot>
                  <tr>
                    <th scope="row">Итого</th>
                    {SUM_COLUMNS.map(column => (
                      <td key={column.kind} className={styles.num}>
                        {formatTotal(sumValue(
                          { totals: history.overall, payout: history.overallPayout, transferred: history.overallTransferred },
                          column.kind,
                        ))}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          {/* key: другой месяц — листок прокручен к началу. */}
          <section key={selected.month} className={styles.detailPane} aria-label="Расчётный листок">
            <div className={styles.detailHead}>
              <button type="button" className={styles.backButton} onClick={() => setDetailOpen(false)}>
                <ArrowLeft size={16} aria-hidden="true" />
                Все месяцы
              </button>
              <h3 className={styles.detailTitle}>{formatAccrualMonthLabel(selected.month, true)}</h3>
            </div>
            <PaidPayslip
              employeeId={employeeId}
              month={selected.month}
              positionName={positionName}
              amounts={history.amounts}
              totals={selected.totals}
              transfers={selected.transfers}
              transferred={selected.transferred}
              transfersFailed={payoutsQuery.isError}
            />
          </section>
        </div>
      )}
    </div>
  );
};
