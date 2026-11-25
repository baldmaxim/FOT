import { useId, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';

import { PAYOUTS_1C_KEYS, payroll1cPayoutsService } from '../../services/payroll1cPayoutsService';
import type { IPayrollTermsRow, PayrollPaidMonths } from '../../services/payrollService';
import { formatDate } from '../../utils/formatMoney';
import { formatAccrualMonthLabel } from '../../utils/payrollAccruals';
import {
  employeePayoutMonths,
  PAYOUT_ORIGIN_LABELS,
  payoutMonthsRange,
  payoutOrganizationLabel,
} from '../../utils/payroll1cJournal';
import { formatPaidAmount, formatPaidPeriod } from '../../utils/payrollPaid';
import { ModalShell } from '../ui/ModalShell';
import modal from './PayrollModal.module.css';
import styles from './Payroll1cPayoutsModal.module.css';

interface IPayroll1cPayoutsModalProps {
  row: IPayrollTermsRow;
  /** Месяцы сумм строки — те же, что у столбца. */
  months: PayrollPaidMonths;
  onClose: () => void;
}

const formatCents = (cents: number): string => formatPaidAmount(cents / 100);

/** Сумма ячейки «Выплаты на карту (1С)» в копейках; null — выплат нет. */
const cellCents = (row: IPayrollTermsRow): number | null => {
  const payouts = row.card_payouts_by_method ?? [];
  return payouts.length === 0 ? null : payouts.reduce((sum, payout) => sum + Math.round(Number(payout.amount) * 100), 0);
};

/**
 * «Расчёты» → клик по «Выплатам на карту (1С)»: ведомости выплаты сотрудника за месяцы таблицы, по месяцам начисления.
 * Ведомость — одной карточкой: вид и сумма сотрудника, номер, дата, организация, откуда пришла, комментарий ведомости и
 * основание строк. Итог — как в ячейке; данные берутся свежие при каждом открытии — разошлось с таблицей (ведомость
 * пришла или отменена после её загрузки) — подсказка обновить страницу.
 */
export const Payroll1cPayoutsModal: FC<IPayroll1cPayoutsModalProps> = ({ row, months, onClose }) => {
  const titleId = useId();
  const range = payoutMonthsRange(months);
  const query = useQuery({
    queryKey: PAYOUTS_1C_KEYS.employee(row.employee_id, range.from, range.to),
    queryFn: ({ signal }) => payroll1cPayoutsService.getByEmployee(row.employee_id, range.from, range.to, signal),
    // Общий клиент не перезапрашивает при монтировании (App.tsx): окно — всегда свежие ведомости.
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const data = query.data ? employeePayoutMonths(query.data, months) : null;
  const withMonthHeads = (data?.months.length ?? 0) > 1 || (months !== 'all' && months.length > 1);
  const inCell = cellCents(row);
  // Пока идёт перезапрос, data — из кэша: сравнивать с ячейкой рано.
  const mismatch = data !== null && !query.isFetching && (inCell ?? 0) !== data.totalCents;

  return (
    <ModalShell onClose={onClose} overlayClassName={modal.overlay} containerClassName={styles.container} aria-labelledby={titleId}>
      {({ requestClose }) => (
        <>
          <header className={modal.header}>
            <div className={modal.headerText}>
              <h2 id={titleId} className={modal.title}>Ведомости 1С</h2>
              <p className={styles.subtitle}>{row.full_name ?? '—'} · {formatPaidPeriod(months)}</p>
            </div>
            <button type="button" className={modal.closeButton} onClick={requestClose} aria-label="Закрыть">
              <X size={20} aria-hidden="true" />
            </button>
          </header>

          <div className={modal.body}>
            {query.isPending && <p className={styles.state}>Загрузка…</p>}
            {query.isError && !data && (
              <div className={styles.stateError} role="alert">
                <span>Не удалось загрузить ведомости</span>
                <button type="button" className={styles.retryButton} onClick={() => { void query.refetch(); }}>Повторить</button>
              </div>
            )}
            {data && data.months.length === 0 && <p className={styles.state}>Ведомостей за период нет.</p>}
            {data?.months.map(entry => (
              <section key={entry.month} className={styles.month} aria-label={formatAccrualMonthLabel(entry.month, true)}>
                {withMonthHeads && (
                  <h3 className={styles.monthHead}>
                    <span>{formatAccrualMonthLabel(entry.month, true)}</span>
                    <span className={styles.amount}>{formatCents(entry.totalCents)}</span>
                  </h3>
                )}
                <ul className={styles.list}>
                  {entry.documents.map(doc => (
                    <li key={`${doc.month}|${doc.document_id}`} className={styles.doc}>
                      <div className={styles.docTop}>
                        <span className={styles.method}>{doc.payment_method}</span>
                        <span className={styles.amount}>{formatPaidAmount(Number(doc.amount))}</span>
                      </div>
                      <p className={styles.meta}>
                        № {doc.doc_number} от {formatDate(doc.doc_date)} · {payoutOrganizationLabel(doc.organization_inn)}
                        {' · '}{PAYOUT_ORIGIN_LABELS[doc.origin] ?? doc.origin}
                      </p>
                      {doc.comment && <p className={styles.note}>{doc.comment}</p>}
                      {doc.basis && (
                        <p className={styles.note}><span className={styles.noteLabel}>Основание: </span>{doc.basis}</p>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>

          {data && data.months.length > 0 && (
            <footer className={styles.footer}>
              <span>Итого</span>
              <span className={styles.amount}>{formatCents(data.totalCents)}</span>
              {mismatch && (
                <p className={styles.mismatch} role="status">
                  В таблице — {inCell === null ? '—' : formatCents(inCell)}: ведомости изменились после её загрузки, обновите страницу.
                </p>
              )}
            </footer>
          )}
        </>
      )}
    </ModalShell>
  );
};
