import { useMemo, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';

import {
  PAYOUTS_1C_KEYS,
  payroll1cPayoutsService,
  type IPayoutJournalDoc,
  type IPayoutJournalLine,
} from '../../services/payroll1cPayoutsService';
import { formatDate } from '../../utils/formatMoney';
import { formatAccrualMonthLabel } from '../../utils/payrollAccruals';
import {
  PAYOUT_LINE_COLUMNS,
  PAYOUT_ORIGIN_LABELS,
  PAYOUT_STATE_LABELS,
  payoutLinesTotals,
  payoutOrganizationLabel,
} from '../../utils/payroll1cJournal';
import { formatPaidAmount } from '../../utils/payrollPaid';
import { buildExportTable, type ITableView } from '../../utils/tableView';
import { RegistryPanel } from '../ui/registry/RegistryPanel';
import { PayrollRegistryModal } from './registry/PayrollRegistryModal';
import styles from './Payroll1cJournal.module.css';

interface IPayroll1cDocumentModalProps {
  /** Строка журнала: шапка видна сразу, строки догружаются. */
  doc: IPayoutJournalDoc;
  onClose: () => void;
  /** Клик по сотруднику ФОТ: его карточка «Расчётов» за месяц строки. */
  onOpenEmployee?: (employeeId: number, month: string) => void;
}

const LINES_VIEW: ITableView = { sort: '', dir: 'asc', filters: {} };
const lineKey = (line: IPayoutJournalLine): number => line.line_no;
const lineName = (line: IPayoutJournalLine): string => line.employee_name ?? line.full_name_1c;
const searchText = (line: IPayoutJournalLine): string => [line.full_name_1c, line.employee_name].filter(Boolean).join(' · ');
const sendExport = payroll1cPayoutsService.exportJournal;

/**
 * «Ведомости 1С» → ведомость: строки в порядке 1С — ФИО в 1С, сотрудник ФОТ, месяц начисления, сумма, основание и как
 * строка привязана (ID_FOT, код физлица, ФИО, без сотрудника); сотрудник ФОТ — ссылка на его карточку. Над таблицей — вид, организация, откуда, состояние и
 * комментарий. Отменённая в 1С — без строк.
 */
export const Payroll1cDocumentModal: FC<IPayroll1cDocumentModalProps> = ({ doc, onClose, onOpenEmployee }) => {
  const [filterOpen, setFilterOpen] = useState(false);
  const query = useQuery({
    queryKey: PAYOUTS_1C_KEYS.journalDoc(doc.id),
    queryFn: ({ signal }) => payroll1cPayoutsService.journalDoc(doc.id, signal),
    // Общий клиент не перезапрашивает при монтировании (App.tsx): окно — всегда свежие ведомости.
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const header = query.data?.document ?? doc;
  const title = `Ведомость № ${header.doc_number} от ${formatDate(header.doc_date)}`;
  const subtitle = [
    header.payment_method,
    payoutOrganizationLabel(header.organization_inn),
    `период ${formatAccrualMonthLabel(header.period_month, true)}`,
    `сумма ${formatPaidAmount(Number(header.total_amount))}`,
  ].join(' · ');
  const buildExport = useMemo(
    () => (lines: ReadonlyArray<IPayoutJournalLine>, totals?: Readonly<Record<string, string | number | null>>) => buildExportTable({
      title,
      subtitle,
      fileName: `Ведомость ${header.doc_number} от ${formatDate(header.doc_date)}`,
      columns: PAYOUT_LINE_COLUMNS,
      rows: lines,
      totals,
    }),
    [title, subtitle, header.doc_number, header.doc_date],
  );
  const cellRenderers = useMemo(() => (onOpenEmployee ? {
    employee_name: (line: IPayoutJournalLine) => (line.employee_id === null || line.employee_name === null ? undefined : (
      <button
        type="button"
        className={styles.employeeLink}
        onClick={event => {
          event.stopPropagation();
          onOpenEmployee(line.employee_id as number, line.month);
        }}
      >
        {line.employee_name}
      </button>
    )),
  } : undefined), [onOpenEmployee]);

  return (
    <PayrollRegistryModal title={title} onClose={onClose} closeOnEscape={!filterOpen} backLabel="Назад к ведомостям">
      <div className={styles.docInfo}>
        <p className={styles.docLine}>
          {subtitle} · {PAYOUT_ORIGIN_LABELS[header.origin] ?? header.origin}
          {header.version !== null && ` (версия ${header.version})`}
        </p>
        {header.state === 'cancelled' && (
          <p className={styles.warn} role="status">
            {PAYOUT_STATE_LABELS.cancelled}: ведомость распровели или удалили, её суммы не учитываются.
          </p>
        )}
        {header.comment && <p className={styles.docComment}>{header.comment}</p>}
      </div>
      <RegistryPanel
        label={title}
        columns={PAYOUT_LINE_COLUMNS}
        rows={query.data?.lines}
        isLoading={query.isPending}
        isError={query.isError}
        onRetry={() => { void query.refetch(); }}
        rowKey={lineKey}
        rowLabel={lineName}
        searchText={searchText}
        fioSearch
        initialView={LINES_VIEW}
        buildExport={buildExport}
        sendExport={sendExport}
        totals={payoutLinesTotals}
        cellRenderers={cellRenderers}
        raisedFilters
        onFilterOpenChange={setFilterOpen}
      />
    </PayrollRegistryModal>
  );
};
