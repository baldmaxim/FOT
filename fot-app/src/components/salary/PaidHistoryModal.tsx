import { useId, useMemo, useState, type FC } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, X } from 'lucide-react';

import { payrollService } from '../../services/payrollService';
import { moscowCurrentMonth } from '../../utils/moscowDate';
import { formatAccrualMonthLabel } from '../../utils/payrollAccruals';
import {
  formatPaidAmount,
  paidHistory,
  PAYROLL_PAID_ALL_FROM,
  type PayrollPaidTotalKind,
  type PayrollPaidTotals,
} from '../../utils/payrollPaid';
import { ModalShell } from '../ui/ModalShell';
import { PaidPayslip } from './PaidPayslip';
import disclosure from './PayrollDisclosure.module.css';
import employeeModal from './PayrollEmployeeModal.module.css';
import modal from './PayrollModal.module.css';
import styles from './PaidHistoryModal.module.css';

interface IPaidHistoryModalProps {
  employeeId: number;
  fullName: string | null;
  /** Должность сотрудника — первая строка расчётного листка. */
  positionName: string | null;
  onClose: () => void;
}

const SUM_COLUMNS: ReadonlyArray<{ kind: PayrollPaidTotalKind | 'payout'; label: string }> = [
  { kind: 'accrued', label: 'Начислено' },
  { kind: 'deducted', label: 'Удержано' },
  { kind: 'payout', label: 'К выплате' },
];

const formatTotal = (value: number | null): string => (value === null ? '—' : formatPaidAmount(value));

const sumValue = (
  entry: { totals: PayrollPaidTotals; payout: number | null },
  kind: PayrollPaidTotalKind | 'payout',
): number | null => (kind === 'payout' ? entry.payout : entry.totals[kind]);

/**
 * «История выплат» — окно поверх карточки сотрудника, того же размера. Слева все месяцы, за которые из 1С
 * пришли суммы «Оплачено», по годам (новые сверху, у года — итоги): «Начислено», «Удержано», «К выплате»
 * (начислено минус удержано, как в «Своде»). Справа — расчётный листок выбранного месяца (PaidPayslip),
 * по умолчанию последнего. Уже 1024px — одна колонка: список, тап по месяцу открывает листок.
 * Стрелка «Назад» и ✕ закрывают только это окно — карточка остаётся.
 * Через портал: внутри окна карточки с transform fixed-слой встал бы по окну, а не по экрану. Только чтение.
 */
export const PaidHistoryModal: FC<IPaidHistoryModalProps> = ({ employeeId, fullName, positionName, onClose }) => {
  const titleId = useId();
  // «Сейчас» — на момент открытия окна.
  const [toMonth] = useState(moscowCurrentMonth);
  const historyQuery = useQuery({
    // Под префиксом 'payroll-terms': сохранение карточки перечитывает и суммы.
    queryKey: ['payroll-terms', 'paid-history', employeeId, toMonth],
    queryFn: ({ signal }) => payrollService.getPaid(employeeId, PAYROLL_PAID_ALL_FROM, toMonth, signal),
    staleTime: 30_000,
  });
  const history = useMemo(() => (historyQuery.data ? paidHistory(historyQuery.data) : null), [historyQuery.data]);
  const [pickedMonth, setPickedMonth] = useState<string | null>(null);
  // Узкий экран: листок вместо списка. С 1024px видны оба, флаг не влияет.
  const [detailOpen, setDetailOpen] = useState(false);
  const selected = history?.months.find(entry => entry.month === pickedMonth) ?? history?.months[0] ?? null;
  const subtitle = [fullName, positionName].filter(Boolean).join(' · ');

  const selectMonth = (month: string) => {
    setPickedMonth(month);
    setDetailOpen(true);
  };

  return createPortal(
    <ModalShell
      onClose={onClose}
      overlayClassName={`${modal.overlay} ${styles.overlay}`}
      containerClassName={employeeModal.container}
      aria-labelledby={titleId}
    >
      {({ requestClose }) => (
        <>
          <header className={`${modal.header} ${styles.header}`}>
            <button type="button" className={modal.closeButton} onClick={requestClose} aria-label="Назад к карточке">
              <ArrowLeft size={20} aria-hidden="true" />
            </button>
            <div className={modal.headerText}>
              <h2 id={titleId} className={modal.title}>История выплат</h2>
              {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
            </div>
            <button type="button" className={modal.closeButton} onClick={requestClose} aria-label="Закрыть">
              <X size={20} aria-hidden="true" />
            </button>
          </header>

          {!history || !selected ? (
            <div className={modal.body}>
              {historyQuery.isPending && <p className={disclosure.state}>Загрузка…</p>}
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
                <table className={styles.list} aria-label="Месяцы">
                  <thead>
                    <tr>
                      <th scope="col">Месяц</th>
                      {SUM_COLUMNS.map(column => (
                        <th key={column.kind} scope="col" className={styles.num}>{column.label}</th>
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
                            {formatTotal(column.kind === 'payout' ? history.overallPayout : history.overall[column.kind])}
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
                />
              </section>
            </div>
          )}
        </>
      )}
    </ModalShell>,
    document.body,
  );
};
