import { type FC, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Eye, RefreshCw, AlertTriangle, CheckCircle2, Clock, XCircle } from 'lucide-react';
import {
  patentReceiptService,
  type IPatentReceiptListRow,
  type RecognitionStatus,
} from '../../services/patentReceiptService';
import { PatentReceiptEditModal } from '../../components/PatentReceiptEditModal';
import styles from './PatentReceiptsPage.module.css';

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
  return new Date(value).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

const formatAmount = (value: string | null): string => {
  if (!value) return '—';
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(num);
};

export const PatentReceiptsPage: FC = () => {
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');
  const [filterNeedsReview, setFilterNeedsReview] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  const queryKey = useMemo(() => ['patent-receipts', filterFrom, filterTo, filterNeedsReview], [filterFrom, filterTo, filterNeedsReview]);
  const { data, isLoading, refetch } = useQuery({
    queryKey,
    queryFn: () => patentReceiptService.list({
      from: filterFrom || undefined,
      to: filterTo || undefined,
      needs_review: filterNeedsReview ? true : undefined,
    }),
  });

  const rows = data ?? [];

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Чеки за патент</h1>
      </div>

      <div className={styles.filters}>
        <label className={styles.field}>
          <span>С</span>
          <input type="date" value={filterFrom} onChange={e => setFilterFrom(e.target.value)} />
        </label>
        <label className={styles.field}>
          <span>По</span>
          <input type="date" value={filterTo} onChange={e => setFilterTo(e.target.value)} />
        </label>
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={filterNeedsReview}
            onChange={e => setFilterNeedsReview(e.target.checked)}
          />
          <span>Только требующие проверки</span>
        </label>
        <button className={styles.btnSecondary} onClick={() => refetch()}>
          <RefreshCw size={14} /> Обновить
        </button>
      </div>

      {isLoading ? (
        <div className={styles.empty}>Загрузка…</div>
      ) : rows.length === 0 ? (
        <div className={styles.empty}>Чеков нет</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Дата</th>
                <th>Сотрудник</th>
                <th>Плательщик</th>
                <th>Паспорт</th>
                <th>ИНН</th>
                <th>№ патента</th>
                <th className={styles.alignRight}>Сумма ₽</th>
                <th>Источник</th>
                <th>Статус</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r: IPatentReceiptListRow) => {
                const status = r.documents?.recognition_status as RecognitionStatus | null;
                const badge = status ? STATUS_BADGE[status] : null;
                return (
                  <tr key={r.id} className={r.needs_review ? styles.rowNeedsReview : undefined}>
                    <td>{formatDate(r.payment_date)}</td>
                    <td>{r.employees?.full_name || '—'}</td>
                    <td>{r.payer_full_name || '—'}</td>
                    <td>{r.payer_passport || '—'}</td>
                    <td>{r.payer_inn || '—'}</td>
                    <td>{r.patent_number || '—'}</td>
                    <td className={styles.alignRight}>{formatAmount(r.payment_amount)}</td>
                    <td>{SOURCE_LABELS[r.source_type || 'unknown'] || r.source_type || '—'}</td>
                    <td>
                      {badge ? (
                        <span className={`${styles.badge} ${badge.cls}`}>
                          <badge.Icon size={12} /> {badge.label}
                        </span>
                      ) : '—'}
                      {r.manually_edited && <span className={styles.editedTag}>правлено</span>}
                    </td>
                    <td>
                      <button className={styles.iconBtn} onClick={() => setEditingId(r.id)} title="Открыть">
                        <Eye size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editingId !== null && (
        <PatentReceiptEditModal
          receiptId={editingId}
          onClose={() => setEditingId(null)}
          onSaved={() => { setEditingId(null); void refetch(); }}
        />
      )}
    </div>
  );
};
