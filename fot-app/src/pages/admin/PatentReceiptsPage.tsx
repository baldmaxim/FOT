import { type FC, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Eye, RefreshCw, AlertTriangle, CheckCircle2, Clock, XCircle, UserX, ShieldCheck, Trash2, ChevronDown, ChevronUp, FileText, Check, Search, FileWarning } from 'lucide-react';

export const PatentReceiptsEncryptionBadge: FC = () => (
  <span
    className={styles.encryptionBadge}
    title="ПДн (ФИО, паспорт, ИНН, банковские реквизиты) зашифрованы AES-256-GCM в БД и при передаче"
  >
    <ShieldCheck size={14} /> Данные зашифрованы
  </span>
);
import {
  patentReceiptService,
  type IPatentReceiptListRow,
  type RecognitionStatus,
} from '../../services/patentReceiptService';
import { employeeService } from '../../services/employeeService';
import { PatentReceiptEditModal } from '../../components/PatentReceiptEditModal';
import { MissingPatentReceiptsModal } from '../../components/MissingPatentReceiptsModal';
import { useToast } from '../../contexts/ToastContext';
import { useAuth } from '../../contexts/AuthContext';
import { ApiError } from '../../api/client';
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

const formatPeriod = (from: string | null, to: string | null): string => {
  if (!from && !to) return '—';
  return `${formatDate(from)} — ${formatDate(to)}`;
};

const formatAmount = (value: string | null): string => {
  if (!value) return '—';
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(num);
};

const normalizeFio = (s: string | null | undefined): string[] =>
  (s || '')
    .toUpperCase()
    .replace(/Ё/g, 'Е')
    .split(/\s+/)
    .map(part => part.trim())
    .filter(Boolean);

const fioMismatches = (payerFio: string | null | undefined, employeeFio: string | null | undefined): boolean => {
  const payerWords = normalizeFio(payerFio);
  const employeeWords = normalizeFio(employeeFio);
  if (payerWords.length === 0 || employeeWords.length === 0) return false;
  return !employeeWords.every(word => payerWords.includes(word));
};

export const PatentReceiptsPage: FC = () => {
  const toast = useToast();
  const { canEditPage } = useAuth();
  const canEdit = canEditPage('/admin/patent-receipts');
  const queryClient = useQueryClient();
  const [filterEmployeeId, setFilterEmployeeId] = useState<number | null>(null);
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');
  const [filterNeedsReview, setFilterNeedsReview] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [searchFio, setSearchFio] = useState('');
  const [filterDeptId, setFilterDeptId] = useState('');
  const [showMissing, setShowMissing] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [recognizingDocId, setRecognizingDocId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [verifyingId, setVerifyingId] = useState<number | null>(null);

  const employeesQuery = useQuery({
    queryKey: ['employees-list-for-filter'],
    queryFn: () => employeeService.getAll(),
    staleTime: 5 * 60 * 1000,
  });

  const queryKey = useMemo(
    () => ['patent-receipts', filterEmployeeId, filterFrom, filterTo, filterNeedsReview],
    [filterEmployeeId, filterFrom, filterTo, filterNeedsReview],
  );
  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey,
    queryFn: () => patentReceiptService.list({
      employee_id: filterEmployeeId ?? undefined,
      from: filterFrom || undefined,
      to: filterTo || undefined,
      needs_review: filterNeedsReview ? true : undefined,
    }),
  });

  const deleteMutation = useMutation({
    mutationFn: (documentId: number) => patentReceiptService.remove(documentId),
    onSuccess: () => {
      toast.success('Чек удалён');
      void queryClient.invalidateQueries({ queryKey: ['patent-receipts'] });
    },
    onError: err => {
      const detail = err instanceof ApiError ? err.message : null;
      toast.error(detail ? `Ошибка удаления: ${detail}` : 'Ошибка удаления');
    },
    onSettled: () => setDeletingId(null),
  });

  const verifyMutation = useMutation({
    mutationFn: ({ id, verified }: { id: number; verified: boolean }) =>
      patentReceiptService.setVerified(id, verified),
    onSuccess: (_data, vars) => {
      toast.success(vars.verified ? 'Чек помечен проверенным' : 'Отметка проверки снята');
      void queryClient.invalidateQueries({ queryKey: ['patent-receipts'] });
    },
    onError: err => {
      const detail = err instanceof ApiError ? err.message : null;
      toast.error(detail ? `Ошибка: ${detail}` : 'Не удалось изменить отметку');
    },
    onSettled: () => setVerifyingId(null),
  });

  const handleToggleVerified = (id: number, current: boolean) => {
    setVerifyingId(id);
    verifyMutation.mutate({ id, verified: !current });
  };

  const handleDelete = (documentId: number) => {
    if (!window.confirm('Удалить чек безвозвратно? Файл будет удалён из хранилища.')) return;
    setDeletingId(documentId);
    deleteMutation.mutate(documentId);
  };

  const rows = data ?? [];
  const employees = employeesQuery.data ?? [];

  const empById = useMemo(() => new Map(employees.map(e => [e.id, e])), [employees]);

  const su10DeptsQuery = useQuery({
    queryKey: ['su10-departments'],
    queryFn: () => patentReceiptService.su10Departments(),
    staleTime: 30 * 60 * 1000,
  });
  const deptOptions = su10DeptsQuery.data ?? [];

  const visibleRows = useMemo(() => {
    const q = searchFio.trim().toUpperCase().replace(/Ё/g, 'Е');
    return rows.filter(r => {
      if (q) {
        const name = (r.employees?.full_name || '').toUpperCase().replace(/Ё/g, 'Е');
        if (!name.includes(q)) return false;
      }
      if (filterDeptId) {
        const emp = r.employee_id != null ? empById.get(r.employee_id) : undefined;
        if (!emp || emp.org_department_id !== filterDeptId) return false;
      }
      return true;
    });
  }, [rows, searchFio, filterDeptId, empById]);

  const handleRecognize = async (documentId: number) => {
    setRecognizingDocId(documentId);
    try {
      const res = await patentReceiptService.recognize(documentId);
      if (res.ok && res.status === 'done') {
        toast.success('Чек распознан');
      } else if (res.ok && res.status === 'needs_review') {
        toast.warning('Чек распознан частично, требует проверки');
      } else {
        toast.error(res.error || 'Не удалось распознать чек');
      }
      void refetch();
    } catch (err) {
      const detail = err instanceof ApiError ? err.message : null;
      toast.error(detail ? `Ошибка распознавания: ${detail}` : 'Ошибка распознавания');
    } finally {
      setRecognizingDocId(null);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.filters}>
        <label className={styles.field}>
          <span>Сотрудник</span>
          <select
            value={filterEmployeeId ?? ''}
            onChange={e => setFilterEmployeeId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">Все сотрудники</option>
            {[...employees]
              .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || '', 'ru'))
              .map(emp => (
                <option key={emp.id} value={emp.id}>{emp.full_name}</option>
              ))}
          </select>
        </label>
        <label className={styles.field}>
          <span>Поиск по ФИО</span>
          <div className={styles.searchBox}>
            <Search size={14} />
            <input
              type="text"
              value={searchFio}
              onChange={e => setSearchFio(e.target.value)}
              placeholder="Фамилия или имя"
            />
          </div>
        </label>
        <label className={styles.field}>
          <span>Бригада/отдел</span>
          <select value={filterDeptId} onChange={e => setFilterDeptId(e.target.value)}>
            <option value="">Все</option>
            {deptOptions.map(d => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </label>
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={filterNeedsReview}
            onChange={e => setFilterNeedsReview(e.target.checked)}
          />
          <span>Только требующие проверки</span>
        </label>
        {canEdit && (
          <button className={styles.btnSecondary} onClick={() => setShowMissing(true)}>
            <FileWarning size={14} /> Чеки не прикреплены
          </button>
        )}
        <button className={styles.btnSecondary} onClick={() => setShowAdvanced(v => !v)}>
          {showAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />} Доп. фильтры
        </button>
        <button
          className={styles.btnSecondary}
          onClick={() => refetch()}
          disabled={isFetching}
        >
          <RefreshCw size={14} className={isFetching ? styles.spin : undefined} /> Обновить
        </button>
        {showAdvanced && (
          <div className={styles.advancedRow}>
            <label className={styles.field}>
              <span>С</span>
              <input type="date" value={filterFrom} onChange={e => setFilterFrom(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span>По</span>
              <input type="date" value={filterTo} onChange={e => setFilterTo(e.target.value)} />
            </label>
          </div>
        )}
      </div>

      {isLoading ? (
        <div className={styles.empty}>Загрузка…</div>
      ) : visibleRows.length === 0 ? (
        <div className={styles.empty}>Чеков нет</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Дата</th>
                <th>Период оплаты</th>
                <th className={styles.colWide}>Сотрудник</th>
                <th className={styles.colWide}>Плательщик</th>
                <th>Паспорт</th>
                <th>ИНН</th>
                <th>№ патента</th>
                <th className={styles.alignRight}>Сумма ₽</th>
                <th className={styles.colWide}>Источник</th>
                <th>Статус</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((r: IPatentReceiptListRow) => {
                const status = r.documents?.recognition_status as RecognitionStatus | null;
                const badge = status ? STATUS_BADGE[status] : null;
                const fioMismatch = fioMismatches(r.payer_full_name, r.employees?.full_name);
                const canRecognize = status === 'failed' || status === null;
                const isRecognizing = recognizingDocId === r.document_id;
                return (
                  <tr
                    key={r.document_id}
                    className={r.is_verified ? styles.rowVerified : r.needs_review ? styles.rowNeedsReview : undefined}
                  >
                    <td>{formatDate(r.payment_date)}</td>
                    <td>{formatPeriod(r.period_start, r.period_end)}</td>
                    <td className={styles.colWide}>{r.employees?.full_name || '—'}</td>
                    <td className={styles.colWide}>
                      {r.payer_full_name || '—'}
                      {fioMismatch && (
                        <span
                          className={styles.fioMismatch}
                          title="ФИО плательщика не совпадает с ФИО сотрудника"
                        >
                          <UserX size={12} /> ≠ ФИО сотрудника
                        </span>
                      )}
                    </td>
                    <td>{r.payer_passport || '—'}</td>
                    <td>{r.payer_inn || '—'}</td>
                    <td>{r.patent_number || '—'}</td>
                    <td className={styles.alignRight}>{formatAmount(r.payment_amount)}</td>
                    <td className={styles.colWide}>{SOURCE_LABELS[r.source_type || 'unknown'] || r.source_type || '—'}</td>
                    <td>
                      {badge ? (
                        <span
                          className={`${styles.badge} ${badge.cls}`}
                          title={status === 'failed' ? (r.documents?.recognition_error || 'Причина ошибки не сохранена') : undefined}
                        >
                          <badge.Icon size={12} /> {badge.label}
                        </span>
                      ) : '—'}
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
                        {r.id !== null && (
                          <button className={styles.iconBtn} onClick={() => setEditingId(r.id!)} title="Открыть">
                            <Eye size={14} />
                          </button>
                        )}
                        {canEdit && r.id !== null && (
                          <button
                            className={r.is_verified ? styles.iconBtnVerified : styles.iconBtn}
                            onClick={() => handleToggleVerified(r.id!, r.is_verified)}
                            disabled={verifyingId === r.id}
                            title={r.is_verified ? 'Снять отметку проверки' : 'Отметить проверенным'}
                          >
                            <Check size={14} className={verifyingId === r.id ? styles.spin : undefined} />
                          </button>
                        )}
                        {canEdit && canRecognize && (
                          <button
                            className={styles.iconBtn}
                            onClick={() => handleRecognize(r.document_id)}
                            disabled={isRecognizing}
                            title="Перепрогнать распознавание"
                          >
                            <RefreshCw size={14} className={isRecognizing ? styles.spin : undefined} />
                          </button>
                        )}
                        {canEdit && (
                          <button
                            className={styles.iconBtnDanger}
                            onClick={() => handleDelete(r.document_id)}
                            disabled={deletingId === r.document_id}
                            title="Удалить чек"
                          >
                            <Trash2 size={14} className={deletingId === r.document_id ? styles.spin : undefined} />
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

      {editingId !== null && (
        <PatentReceiptEditModal
          receiptId={editingId}
          onClose={() => setEditingId(null)}
          onSaved={() => { setEditingId(null); void refetch(); }}
        />
      )}

      {showMissing && <MissingPatentReceiptsModal onClose={() => setShowMissing(false)} />}
    </div>
  );
};
