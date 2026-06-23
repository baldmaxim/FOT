import { type FC, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, FileText, Eye, AlertTriangle, CheckCircle2, Clock, XCircle } from 'lucide-react';
import {
  patentReceiptService,
  type IPatentReceiptListRow,
  type RecognitionStatus,
} from '../services/patentReceiptService';
import { ModalShell } from './ui/ModalShell';
import styles from './EmployeePatentReceiptsModal.module.css';

interface IProps {
  employeeId: number;
  employeeName: string;
  onClose: () => void;
  /** Открыть конкретный чек в модалке просмотра/редактирования. */
  onOpenReceipt?: (receiptId: number) => void;
}

const SOURCE_LABELS: Record<string, string> = {
  solidarnost_terminal: 'Терминал «Солидарность»',
  sber_pdf: 'Сбербанк-онлайн',
  tinkoff_pdf: 'Т-Банк',
  unknown: 'Не определён',
};

const STATUS_BADGE: Record<RecognitionStatus, { label: string; cls: string; Icon: typeof Clock }> = {
  pending: { label: 'Ожидает', cls: styles.badgePending, Icon: Clock },
  processing: { label: 'Распознаётся', cls: styles.badgeProcessing, Icon: Clock },
  done: { label: 'Готово', cls: styles.badgeDone, Icon: CheckCircle2 },
  needs_review: { label: 'Проверить', cls: styles.badgeReview, Icon: AlertTriangle },
  failed: { label: 'Ошибка', cls: styles.badgeFailed, Icon: XCircle },
};

const formatDate = (value: string | null): string => {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

const formatPeriod = (from: string | null, to: string | null): string => {
  if (!from && !to) return '—';
  return `${formatDate(from)} — ${formatDate(to)}`;
};

const formatAmount = (value: number): string =>
  new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);

const parseAmount = (value: string | null): number => {
  if (!value) return 0;
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

export const EmployeePatentReceiptsModal: FC<IProps> = ({
  employeeId,
  employeeName,
  onClose,
  onOpenReceipt,
}) => {
  const validEmployeeId = Number.isInteger(employeeId) && employeeId > 0;

  const { data, isLoading, isFetching, isError } = useQuery({
    queryKey: ['patent-receipts', 'by-employee', employeeId],
    queryFn: () => patentReceiptService.list({ employee_id: employeeId }),
    enabled: validEmployeeId,
  });

  // Свежие сверху: по дате платежа, при её отсутствии — по дате создания.
  const rows = useMemo(() => {
    const list = data ?? [];
    return [...list].sort((a, b) => {
      const ax = a.payment_date || a.created_at || '';
      const bx = b.payment_date || b.created_at || '';
      return bx.localeCompare(ax);
    });
  }, [data]);

  const totalSum = useMemo(
    () => rows.reduce((acc, r) => acc + parseAmount(r.payment_amount), 0),
    [rows],
  );

  return (
    <ModalShell onClose={onClose} overlayClassName={styles.overlay} containerClassName={styles.modal}>
      {({ requestClose }) => (
        <>
          <div className={styles.header}>
            <h3>
              <FileText size={18} /> Чеки за патент — {employeeName || 'Сотрудник'}
            </h3>
            <button className={styles.closeBtn} onClick={requestClose} title="Закрыть">
              <X size={18} />
            </button>
          </div>

          <div className={styles.body}>
            {!validEmployeeId ? (
              <div className={styles.empty}>Сотрудник не определён</div>
            ) : isLoading || isFetching ? (
              <div className={styles.empty}>Загрузка…</div>
            ) : isError ? (
              <div className={styles.empty}>Не удалось загрузить чеки</div>
            ) : rows.length === 0 ? (
              <div className={styles.empty}>У сотрудника нет чеков</div>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th className={styles.colNum}>№</th>
                      <th>Дата</th>
                      <th>Период оплаты</th>
                      <th>№ патента</th>
                      <th>Источник</th>
                      <th className={styles.alignRight}>Сумма ₽</th>
                      <th>Статус</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r: IPatentReceiptListRow, idx) => {
                      const status = r.documents?.recognition_status as RecognitionStatus | null;
                      const badge = status ? STATUS_BADGE[status] : null;
                      return (
                        <tr
                          key={r.document_id}
                          className={
                            r.is_verified
                              ? styles.rowVerified
                              : r.needs_review
                                ? styles.rowNeedsReview
                                : undefined
                          }
                        >
                          <td className={styles.colNum}>{idx + 1}</td>
                          <td>{formatDate(r.payment_date)}</td>
                          <td>{formatPeriod(r.period_start, r.period_end)}</td>
                          <td>{r.patent_number || '—'}</td>
                          <td>{SOURCE_LABELS[r.source_type || 'unknown'] || r.source_type || '—'}</td>
                          <td className={styles.alignRight}>{formatAmount(parseAmount(r.payment_amount))}</td>
                          <td>
                            {badge ? (
                              <span className={`${styles.badge} ${badge.cls}`}>
                                <badge.Icon size={12} /> {badge.label}
                              </span>
                            ) : (
                              '—'
                            )}
                            {r.manually_edited && <span className={styles.editedTag}>правлено</span>}
                          </td>
                          <td>
                            <div className={styles.rowActions}>
                              {r.download_url && (
                                <a
                                  className={styles.iconBtn}
                                  href={r.download_url}
                                  target="_blank"
                                  rel="noreferrer"
                                  title="Открыть файл чека"
                                >
                                  <FileText size={14} />
                                </a>
                              )}
                              {r.id !== null && onOpenReceipt && (
                                <button
                                  className={styles.iconBtn}
                                  onClick={() => onOpenReceipt(r.id!)}
                                  title="Открыть чек"
                                >
                                  <Eye size={14} />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className={styles.footer}>
            <span className={styles.count}>
              {validEmployeeId && !isLoading && !isError
                ? `Всего чеков: ${rows.length} · Сумма: ${formatAmount(totalSum)} ₽`
                : ''}
            </span>
            <button className={styles.btnSecondary} onClick={requestClose}>
              Закрыть
            </button>
          </div>
        </>
      )}
    </ModalShell>
  );
};
