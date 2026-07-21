import { type FC, type MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Clock,
  CheckCircle,
  XCircle,
  Ban,
  Paperclip,
  ChevronDown,
  ChevronUp,
  UserCheck,
} from 'lucide-react';
import {
  leaveRequestService,
  REQUEST_TYPE_LABELS,
  getRequestDecision,
  type ILeaveRequest,
  type ILeaveRequestAttachment,
  type LeaveRequestStatus,
} from '../services/leaveRequestService';
import { useVacationLeaveRequests, getVacationLeaveRequestsQueryKey } from '../hooks/usePortalData';
import { FilePreviewModal } from '../components/documents/FilePreviewModal';
import { SearchInput } from '../components/ui/SearchInput';
import { formatLeaveRequestDatesCompact } from '../utils/leaveRequestDates';
import { displayFileName } from '../utils/fileNameDisplay';
import { formatFioShort } from '../utils/formatFio';
import './LeaveRequestsManagePage.css';

const STATUS_COLORS: Record<LeaveRequestStatus, string> = {
  pending: '#f59e0b',
  approved: '#22c55e',
  rejected: '#ef4444',
  cancelled: '#6b7280',
};

const STATUS_ICONS: Record<LeaveRequestStatus, FC<{ size?: number }>> = {
  pending: Clock,
  approved: CheckCircle,
  rejected: XCircle,
  cancelled: Ban,
};

const EMPTY_REQUESTS: ILeaveRequest[] = [];
const NO_DEPARTMENT_KEY = 'Без отдела';

// Единый ключ группы отдела — и для группировки списка, и для фильтра по отделам.
const deptKeyOf = (r: ILeaveRequest) => r.department_name?.trim() || NO_DEPARTMENT_KEY;

const compareDeptKeys = (a: string, b: string) => {
  if (a === NO_DEPARTMENT_KEY) return 1;
  if (b === NO_DEPARTMENT_KEY) return -1;
  return a.localeCompare(b, 'ru');
};

interface IPreviewState {
  documentId: number;
  fileName: string;
  mimeType: string | null;
}

export const VacationsManagePage: FC = () => {
  const queryClient = useQueryClient();
  const { data, isLoading } = useVacationLeaveRequests();
  const requests = data ?? EMPTY_REQUESTS;

  const [preview, setPreview] = useState<IPreviewState | null>(null);
  const [collapsedDepts, setCollapsedDepts] = useState<Set<string>>(new Set());
  const [acking, setAcking] = useState<Set<number>>(new Set());
  // Под-вкладки: «Не ознакомлен» (hr_acknowledged_at пусто) / «Ознакомлен».
  const [ackFilter, setAckFilter] = useState<'unacked' | 'acked'>('unacked');
  const [search, setSearch] = useState('');
  const [deptFilter, setDeptFilter] = useState<string>('all');

  const ackFiltered = useMemo(
    () => requests.filter(r => (ackFilter === 'acked' ? !!r.hr_acknowledged_at : !r.hr_acknowledged_at)),
    [requests, ackFilter],
  );

  // Опции фильтра по отделам — из списка ДО поиска/фильтра, чтобы селект не сужался при фильтрации.
  const deptOptions = useMemo(
    () => Array.from(new Set(ackFiltered.map(deptKeyOf))).sort(compareDeptKeys),
    [ackFiltered],
  );

  const query = search.trim().toLowerCase();
  const isFiltering = query !== '' || deptFilter !== 'all';

  const filtered = useMemo(() => {
    if (!isFiltering) return ackFiltered;
    return ackFiltered.filter(r =>
      (deptFilter === 'all' || deptKeyOf(r) === deptFilter)
      && (query === '' || (r.employee_name ?? '').toLowerCase().includes(query)));
  }, [ackFiltered, isFiltering, deptFilter, query]);

  const grouped = useMemo(() => {
    const map = new Map<string, ILeaveRequest[]>();
    for (const r of filtered) {
      const key = deptKeyOf(r);
      const list = map.get(key) ?? [];
      list.push(r);
      map.set(key, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => compareDeptKeys(a, b));
  }, [filtered]);

  const ackFilteredRef = useRef(ackFiltered);
  ackFilteredRef.current = ackFiltered;
  const hasData = data !== undefined;

  useEffect(() => {
    // Дефолтное сворачивание (>2 групп — свернуть все) — только при первичной
    // загрузке и смене под-вкладки «Не ознакомлен/Ознакомлен». Изменения данных
    // (отметка «Ознакомлен», refetch) раскрытые отделы не трогают.
    if (!hasData) return;
    const keys = new Set(ackFilteredRef.current.map(deptKeyOf));
    setCollapsedDepts(keys.size > 2 ? keys : new Set());
  }, [hasData, ackFilter]);

  const queryActive = query !== '';
  useEffect(() => {
    // Начало поиска раскрывает группы, чтобы совпадения были видны;
    // свернуть обратно можно вручную — доввод символов не раскрывает повторно.
    if (queryActive) setCollapsedDepts(new Set());
  }, [queryActive]);

  const toggleDept = (key: string) => {
    setCollapsedDepts(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const formatDate = (date: string) =>
    new Date(date).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const handleAcknowledge = async (id: number) => {
    setAcking(prev => new Set(prev).add(id));
    // Оптимистично проставляем отметку во всех кэшах отпусков до refetch'а.
    const nowIso = new Date().toISOString();
    queryClient.setQueriesData<ILeaveRequest[] | undefined>(
      { queryKey: getVacationLeaveRequestsQueryKey() },
      (prev) => prev?.map(r => (r.id === id ? { ...r, hr_acknowledged_at: nowIso } : r)),
    );
    try {
      await leaveRequestService.acknowledgeHr(id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['leave-requests-vacations'] }),
        queryClient.invalidateQueries({ queryKey: ['leave-requests-manage'] }),
        queryClient.invalidateQueries({ queryKey: ['my-leave-requests'] }),
      ]);
    } catch (err) {
      console.error('hr-acknowledge error:', err);
      await queryClient.invalidateQueries({ queryKey: ['leave-requests-vacations'] });
    } finally {
      setAcking(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const openAttachment = (att: ILeaveRequestAttachment) => {
    setPreview({ documentId: att.id, fileName: att.file_name, mimeType: att.mime_type });
  };

  const stop = (e: ReactMouseEvent) => e.stopPropagation();

  const renderCard = (r: ILeaveRequest) => {
    const Icon = STATUS_ICONS[r.status];
    const decision = getRequestDecision(r);
    const isAcked = !!r.hr_acknowledged_at;
    const isAcking = acking.has(r.id);
    return (
      <div key={r.id} className="lrm-card">
        <div className="lrm-card-main">
          <div className="lrm-card-top">
            <div className="lrm-card-employee-block">
              <span className="lrm-card-employee">{r.employee_name || `#${r.employee_id}`}</span>
              {(r.department_name || r.position_name) && (
                <div className="lrm-card-meta">
                  {r.department_name}
                  {r.department_name && r.position_name ? ' · ' : ''}
                  {r.position_name}
                </div>
              )}
            </div>
            <div className="lrm-status-wrap">
              <span className="lrm-status" style={{ color: STATUS_COLORS[r.status] }}>
                <Icon size={14} /> <strong>{decision.label}</strong>
              </span>
              {(decision.actor || decision.at) && (
                <div className="lrm-status-meta">
                  {formatFioShort(decision.actor)}
                  {decision.actor && decision.at ? ' · ' : ''}
                  {decision.at ? formatDate(decision.at) : ''}
                </div>
              )}
            </div>
          </div>
          <div className="lrm-card-type">{REQUEST_TYPE_LABELS[r.request_type]}</div>
          <div className="lrm-card-dates">
            <strong>{formatLeaveRequestDatesCompact(r)}</strong>
          </div>
          {r.reason && <div className="lrm-card-reason">{r.reason}</div>}
          {r.attachments && r.attachments.length > 0 && (
            <div className="lrm-attachments" onClick={stop}>
              {r.attachments.map(att => (
                <button
                  key={att.id}
                  type="button"
                  className="lrm-attachment-btn"
                  onClick={(e) => { e.stopPropagation(); openAttachment(att); }}
                  title={att.file_name}
                >
                  <Paperclip size={12} />
                  <span className="lrm-attachment-name">{displayFileName(att.file_name)}</span>
                </button>
              ))}
            </div>
          )}
          {decision.comment && (
            <div className="lrm-card-comment">
              <span className="lrm-card-comment-label">
                {r.status === 'cancelled' ? 'Причина:' : 'Комментарий:'}
              </span> {decision.comment}
            </div>
          )}
        </div>

        <div className="lrm-card-actions" onClick={stop}>
          {isAcked ? (
            <div className="lrm-hr-ack">
              <CheckCircle size={15} /> Ознакомлен
            </div>
          ) : (
            <button
              className="lrm-ack-btn lrm-ack-btn--pending"
              disabled={isAcking}
              onClick={() => handleAcknowledge(r.id)}
            >
              <UserCheck size={14} /> {isAcking ? 'Отмечаем…' : 'Ознакомлен'}
            </button>
          )}
        </div>
      </div>
    );
  };

  const totalEmployees = (items: ILeaveRequest[]) =>
    new Set(items.map(i => i.employee_id)).size;

  return (
    <div className="lrm-shell">
      <div className="lrm-page">
        {isLoading ? (
          <div className="lrm-loading">Загрузка...</div>
        ) : requests.length === 0 ? (
          <div className="lrm-empty">Нет отпусков</div>
        ) : (
          <>
            <div className="lrm-header">
              <SearchInput value={search} onValueChange={setSearch} placeholder="Поиск по ФИО..." />
              <select
                className="lrm-filter-select"
                value={deptFilter}
                onChange={e => setDeptFilter(e.target.value)}
                aria-label="Фильтр по отделу"
              >
                <option value="all">Все отделы</option>
                {deptOptions.map(key => (
                  <option key={key} value={key}>{key}</option>
                ))}
              </select>
              <div className="lrm-filter">
                <button
                  className={`lrm-filter-btn ${ackFilter === 'unacked' ? 'active' : ''}`}
                  onClick={() => setAckFilter('unacked')}
                >
                  Не ознакомлен
                </button>
                <button
                  className={`lrm-filter-btn ${ackFilter === 'acked' ? 'active' : ''}`}
                  onClick={() => setAckFilter('acked')}
                >
                  Ознакомлен
                </button>
              </div>
            </div>
            {grouped.length === 0 ? (
              <div className="lrm-empty">
                {isFiltering
                  ? 'Ничего не найдено'
                  : ackFilter === 'acked' ? 'Нет ознакомленных отпусков' : 'Все отпуска обработаны'}
              </div>
            ) : (
              <div className="lrm-list">
                {grouped.map(([department, items]) => {
              const isCollapsed = collapsedDepts.has(department);
              return (
                <div
                  key={department}
                  className={`lrm-group${isCollapsed ? ' lrm-group--collapsed' : ''}`}
                >
                  <button
                    type="button"
                    className="lrm-group-toggle"
                    onClick={() => toggleDept(department)}
                    aria-expanded={!isCollapsed}
                  >
                    {isCollapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
                    <span className="lrm-group-name">{department}</span>
                    <span className="lrm-group-stats">
                      {items.length} · {totalEmployees(items)} чел
                    </span>
                  </button>
                  {!isCollapsed && items.map(renderCard)}
                </div>
              );
            })}
              </div>
            )}
          </>
        )}
      </div>

      {preview && (
        <FilePreviewModal
          documentId={preview.documentId}
          fileName={preview.fileName}
          mimeType={preview.mimeType}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
};
