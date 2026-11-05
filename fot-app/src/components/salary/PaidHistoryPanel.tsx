import { useMemo, useState, type FC, type ReactNode } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';

import { paidHistoryQueryOptions, payouts1cHistoryQueryOptions, payslipQueryOptions } from '../../hooks/usePayrollPaid';
import { formatAccrualMonthLabel } from '../../utils/payrollAccruals';
import { calcMonthSums } from '../../utils/payrollCalc';
import {
  formatPaidAmount,
  paidHistory,
  paidHistoryShown,
  recentHistoryMonths,
  type IPaidMonthSums,
} from '../../utils/payrollPaid';
import { PaidPayslip } from './PaidPayslip';
import { PayslipRecalcSection } from './PayslipRecalcSection';
import disclosure from './PayrollDisclosure.module.css';
import styles from './PaidHistoryPanel.module.css';

interface IPaidHistoryPanelProps {
  employeeId: number;
  /** Последний месяц истории — месяц карточки на момент открытия (тот же у «Экспорта»). */
  toMonth: string;
}

type SumKind = keyof IPaidMonthSums | 'transferred';

const SUM_COLUMNS: ReadonlyArray<{ kind: SumKind; label: string }> = [
  { kind: 'accrued', label: 'Начислено' },
  { kind: 'deducted', label: 'Удержано' },
  { kind: 'payout', label: 'К выплате' },
  { kind: 'transferred', label: 'Перечислено (1С)' },
];

const SOURCE_1C_HINT = 'Итога ФОТ нет — суммы 1С';

/** Сумма ячейки: расчёт идёт — «…», перечисление 1С от расчёта не зависит. */
const renderSum = (value: number | null, pending: boolean, kind: SumKind): ReactNode => {
  if (pending && kind !== 'transferred') return <span className={styles.pending} aria-label="Считается">…</span>;
  return value === null ? '—' : formatPaidAmount(value);
};

/**
 * Вкладка «Зарплата» карточки сотрудника. Слева все месяцы, за которые из 1С пришли суммы «Оплачено» или ведомости
 * выплаты, и последние шесть месяцев (текущий не считаем), по годам (новые сверху, у года — итоги): «Начислено»,
 * «Удержано», «К выплате» — из расчёта ФОТ, те же числа, что справа (решение пользователя 03.11.2026); итога ФОТ нет
 * (нет условий, выработка бригады не введена) — суммы 1С. «Перечислено (1С)» — справочно, по месяцу начисления
 * (миграция 328). Таблица не ждёт расчёта: месяцы заполняются по мере ответов.
 * Справа — расчётный листок выбранного месяца (PaidPayslip), по умолчанию последнего, и блок «Пересчёт»: рядом, если
 * хватает ширины, иначе под листком.
 * Две колонки — когда хватает ширины карточки (container query), уже — одна: список, тап по месяцу
 * открывает листок, «Все месяцы» — назад. Записывает только «Доплачено» в «Пересчёте».
 */
export const PaidHistoryPanel: FC<IPaidHistoryPanelProps> = ({ employeeId, toMonth }) => {
  const historyQuery = useQuery(paidHistoryQueryOptions(employeeId, toMonth));
  const payoutsQuery = useQuery(payouts1cHistoryQueryOptions(employeeId, toMonth));
  // Перечисления ещё грузятся — история ждёт их, иначе месяц только с перечислением появился бы позже.
  const history = useMemo(() => {
    if (!historyQuery.data || payoutsQuery.isPending) return null;
    return paidHistory(historyQuery.data, payoutsQuery.data ?? [], recentHistoryMonths(toMonth));
  }, [historyQuery.data, payoutsQuery.isPending, payoutsQuery.data, toMonth]);
  // Тот же запрос, что у листка справа: выбранный месяц не считается дважды. Ошибка — как итога нет: суммы 1С.
  const months = history?.months ?? [];
  const payslips = useQueries({ queries: months.map(entry => payslipQueryOptions(employeeId, entry.month)) });
  const shown = history && paidHistoryShown(history, new Map(months.map((entry, index) => {
    const payslip = payslips[index];
    if (payslip?.isPending) return [entry.month, undefined];
    return [entry.month, payslip?.data ? calcMonthSums(payslip.data.calc) : null];
  })));
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
      {!history || !shown || !selected ? (
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
                    {SUM_COLUMNS.map(column => {
                      const total = shown.byYear.get(year.year);
                      const value = column.kind === 'transferred' ? year.transferred : total?.[column.kind] ?? null;
                      return <td key={column.kind} className={styles.num}>{renderSum(value, total?.pending ?? false, column.kind)}</td>;
                    })}
                  </tr>
                  {year.months.map(entry => {
                    const active = entry.month === selected.month;
                    const sums = shown.byMonth.get(entry.month);
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
                        {SUM_COLUMNS.map(column => {
                          const value = column.kind === 'transferred' ? entry.transferred : sums?.[column.kind] ?? null;
                          const from1c = column.kind !== 'transferred' && sums?.source === '1c' && value !== null;
                          return (
                            <td key={column.kind} className={styles.num} title={from1c ? SOURCE_1C_HINT : undefined}>
                              {renderSum(value, sums?.source === 'pending', column.kind)}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              ))}
              {history.years.length > 1 && (
                <tfoot>
                  <tr>
                    <th scope="row">Итого</th>
                    {SUM_COLUMNS.map(column => {
                      const value = column.kind === 'transferred' ? history.overallTransferred : shown.overall[column.kind];
                      return <td key={column.kind} className={styles.num}>{renderSum(value, shown.overall.pending, column.kind)}</td>;
                    })}
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
            <div className={styles.detailBody}>
              <PaidPayslip
                employeeId={employeeId}
                month={selected.month}
                amounts={history.amounts}
                totals={selected.totals}
                transfers={selected.transfers}
                transferred={selected.transferred}
                transfersFailed={payoutsQuery.isError}
              />
              <PayslipRecalcSection employeeId={employeeId} />
            </div>
          </section>
        </div>
      )}
    </div>
  );
};
