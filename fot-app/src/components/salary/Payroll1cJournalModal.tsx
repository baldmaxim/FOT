import { useId, useMemo, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';

import {
  PAYOUTS_1C_KEYS,
  payroll1cPayoutsService,
  type IPayoutJournalListDoc,
} from '../../services/payroll1cPayoutsService';
import { formatPaidPeriod } from '../../utils/payrollPaid';
import {
  isCancelledPayout,
  PAYOUT_JOURNAL_COLUMNS,
  PAYOUT_STATE_LABELS,
  payoutJournalSearchText,
  payoutJournalTotals,
} from '../../utils/payroll1cJournal';
import { buildExportTable, type ITableView } from '../../utils/tableView';
import { ModalShell } from '../ui/ModalShell';
import { RegistryPanel } from '../ui/registry/RegistryPanel';
import type { IRegistryRowTone } from '../ui/registry/RegistryTable';
import { Payroll1cDocumentModal } from './Payroll1cDocumentModal';
import modal from './PayrollModal.module.css';
import styles from './Payroll1cJournal.module.css';

interface IPayroll1cJournalModalProps {
  /** Месяцы при открытии — те же, что у таблицы «Расчётов». */
  initialMonths: string[];
  /** Месяцы, которые можно выбрать (по возрастанию). */
  monthOptions: string[];
  onClose: () => void;
  /** Клик по сотруднику ФОТ в ведомости: его карточка «Расчётов» за месяц строки. */
  onOpenEmployee?: (employeeId: number, month: string) => void;
}

/** Как PAYOUT_JOURNAL_MAX_MONTHS сервера: за сентябрь 2026 — 419 ведомостей с ФИО строк (~360 КБ). */
const MAX_MONTHS = 6;
const NO_DOCS: IPayoutJournalListDoc[] = [];
const JOURNAL_VIEW: ITableView = { sort: 'doc_date', dir: 'desc', filters: {} };
const docKey = (doc: IPayoutJournalListDoc): number => doc.id;
const docLabel = (doc: IPayoutJournalListDoc): string => `Ведомость № ${doc.doc_number}`;
const sendExport = payroll1cPayoutsService.exportJournal;
const CANCELLED_TONE: IRegistryRowTone = { tone: 'dismissed', hint: `${PAYOUT_STATE_LABELS.cancelled}: суммы не учитываются` };
const rowTone = (doc: IPayoutJournalListDoc): IRegistryRowTone | null => (isCancelledPayout(doc) ? CANCELLED_TONE : null);

/**
 * «Расчёты» → «Ведомости 1С»: все ведомости выплаты за выбранные месяцы, как журнал 1С (весь штат — кнопку видит только
 * он). Поиск — по номеру и ФИО строк, фильтры у столбцов (вид, период, организация, откуда, состояние), «Экспорт» —
 * видимые строки. Отменённые в 1С — бледнее, в «Итого» не входят. Клик по ведомости — её строки.
 */
export const Payroll1cJournalModal: FC<IPayroll1cJournalModalProps> = ({ initialMonths, monthOptions, onClose, onOpenEmployee }) => {
  const titleId = useId();
  const [months, setMonths] = useState<string[]>(initialMonths);
  const [filterOpen, setFilterOpen] = useState(false);
  const [opened, setOpened] = useState<IPayoutJournalListDoc | null>(null);
  const query = useQuery({
    queryKey: PAYOUTS_1C_KEYS.journal(months),
    queryFn: ({ signal }) => payroll1cPayoutsService.journal(months, signal),
    enabled: months.length <= MAX_MONTHS,
    // Общий клиент не перезапрашивает при монтировании (App.tsx): окно — всегда свежие ведомости.
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const tooMany = months.length > MAX_MONTHS;
  const period = formatPaidPeriod(months);
  const buildExport = useMemo(
    () => (docs: ReadonlyArray<IPayoutJournalListDoc>, totals?: Readonly<Record<string, string | number | null>>) => buildExportTable({
      title: 'Ведомости 1С',
      subtitle: period,
      fileName: `Ведомости 1С ${period}`,
      columns: PAYOUT_JOURNAL_COLUMNS,
      rows: docs,
      isMuted: isCancelledPayout,
      totals,
    }),
    [period],
  );

  return (
    <ModalShell
      onClose={onClose}
      overlayClassName={modal.overlay}
      containerClassName={styles.container}
      closeOnEscape={!filterOpen && opened === null}
      aria-labelledby={titleId}
    >
      {({ requestClose }) => (
        <>
          <header className={modal.header}>
            <div className={modal.headerText}>
              <h2 id={titleId} className={modal.title}>Ведомости 1С · {period}</h2>
            </div>
            <button type="button" className={modal.closeButton} onClick={requestClose} aria-label="Закрыть">
              <X size={20} aria-hidden="true" />
            </button>
          </header>

          {/* data-registry-fill: таблица прокручивается внутри окна, шапка закреплена (RegistryTable.module.css). */}
          <div className={`${modal.body} ${styles.body}`} data-registry-fill>
            {tooMany && (
              <div className={styles.docInfo}>
                <p className={styles.warn} role="status">Выберите не больше {MAX_MONTHS} месяцев.</p>
              </div>
            )}
            <RegistryPanel
              label="Ведомости 1С"
              columns={PAYOUT_JOURNAL_COLUMNS}
              rows={tooMany ? NO_DOCS : query.data}
              isLoading={!tooMany && query.isPending}
              isError={query.isError}
              onRetry={() => { void query.refetch(); }}
              rowKey={docKey}
              rowLabel={docLabel}
              searchText={payoutJournalSearchText}
              fioSearch
              searchPlaceholder="Поиск по № или ФИО..."
              initialView={JOURNAL_VIEW}
              months={{ value: months, options: monthOptions, onChange: setMonths }}
              buildExport={buildExport}
              sendExport={sendExport}
              totals={payoutJournalTotals}
              rowTone={rowTone}
              onRowClick={setOpened}
              raisedFilters
              onFilterOpenChange={setFilterOpen}
            />
          </div>

          {opened && <Payroll1cDocumentModal doc={opened} onClose={() => setOpened(null)} onOpenEmployee={onOpenEmployee} />}
        </>
      )}
    </ModalShell>
  );
};
