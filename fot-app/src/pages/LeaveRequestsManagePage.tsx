import { type FC, type MouseEvent as ReactMouseEvent, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Check,
  X,
  Clock,
  CheckCircle,
  XCircle,
  Ban,
  Paperclip,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import {
  leaveRequestService,
  REQUEST_TYPE_LABELS,
  STATUS_LABELS,
  CORRECTION_STATUS_LABELS,
  type ILeaveRequest,
  type ILeaveRequestAttachment,
  type LeaveRequestStatus,
} from '../services/leaveRequestService';
import { useLeaveRequestsManage } from '../hooks/usePortalData';
import { FilePreviewModal } from '../components/documents/FilePreviewModal';
import { LeaveRequestEventsPanel } from '../components/leave-requests/LeaveRequestEventsPanel';
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
const DIRECT_REPORTS_KEY = '__direct_reports__';
const DIRECT_REPORTS_TITLE = 'Непосредственные подчинённые';

// Старые вложения (до Unicode-фикса sanitizeFileName) хранятся в БД как
// «________.pdf» — буквы/цифры были схлопнуты в подчёркивания. Показываем для
// них fallback «Документ.ext», исходное имя остаётся в title.
const formatAttachmentName = (fileName: string): string => {
  const base = fileName.replace(/^.*[\\/]/, '');
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  if (!/[\p{L}\p{N}]/u.test(stem)) {
    return `Документ${ext}`;
  }
  return base;
};

interface IPreviewState {
  documentId: number;
  fileName: string;
  mimeType: string | null;
}

interface IEventsPanelState {
  employeeId: number;
  employeeName: string;
  date: string;
}

export const LeaveRequestsManagePage: FC = () => {
  const { hasPermission } = useAuth();
  const isDepartmentScope = hasPermission('data.scope.department') && !hasPermission('data.scope.all');
  const scope = isDepartmentScope ? 'department' : 'all';
  const queryClient = useQueryClient();

  const [filter, setFilter] = useState<'pending' | 'all'>('pending');
  const [commentId, setCommentId] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [preview, setPreview] = useState<IPreviewState | null>(null);
  const [eventsPanel, setEventsPanel] = useState<IEventsPanelState | null>(null);
  const [collapsedDepts, setCollapsedDepts] = useState<Set<string>>(new Set());
  const { data, isLoading } = useLeaveRequestsManage(scope, filter);
  const requests = data ?? EMPTY_REQUESTS;

  const filteredRequests = filter === 'pending' && isDepartmentScope
    ? requests.filter(r => r.status === 'pending')
    : requests;

  const grouped = useMemo(() => {
    const map = new Map<string, ILeaveRequest[]>();
    for (const r of filteredRequests) {
      // Непосредственные подчинённые (вне subtree отдела руководителя) — в
      // отдельную псевдо-группу в конце списка.
      const key = r.is_direct_subordinate
        ? DIRECT_REPORTS_KEY
        : (r.department_name?.trim() || NO_DEPARTMENT_KEY);
      const list = map.get(key) ?? [];
      list.push(r);
      map.set(key, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => {
      if (a === DIRECT_REPORTS_KEY) return 1;
      if (b === DIRECT_REPORTS_KEY) return -1;
      if (a === NO_DEPARTMENT_KEY) return 1;
      if (b === NO_DEPARTMENT_KEY) return -1;
      return a.localeCompare(b, 'ru');
    });
  }, [filteredRequests]);

  // Для админа (scope='all') заголовки отделов показываем всегда — даже если
  // получилась 1 группа (включая «Без отдела»): админу нужен явный контекст.
  // Для руководителя (scope='department') поведение прежнее — 1 группа →
  // плоско, ≥2 (отдел + direct reports или несколько отделов) → группы.
  const showGroupHeaders = scope === 'all' ? grouped.length >= 1 : grouped.length > 1;

  useEffect(() => {
    // При первой загрузке (или смене фильтра) — если групп > 2, свернуть все,
    // иначе развернуть. Не трогаем явно изменённые пользователем состояния
    // при добавлении/удалении карточек — пересчитываем только при смене ключей.
    if (grouped.length > 2) {
      setCollapsedDepts(new Set(grouped.map(([key]) => key)));
    } else {
      setCollapsedDepts(new Set());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, grouped.length]);

  const toggleDept = (key: string) => {
    setCollapsedDepts(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Оптимистичное удаление: мгновенно убираем карточку из всех кэшей
  // ['leave-requests-manage', ...] до refetch'а, иначе из-за placeholderData
  // в useLeaveRequestsManage юзер видит «старые» данные пока запрос идёт.
  const removeRequestFromCache = (id: number) => {
    queryClient.setQueriesData<ILeaveRequest[] | undefined>(
      { queryKey: ['leave-requests-manage'] },
      (prev) => (prev ? prev.filter(r => r.id !== id) : prev),
    );
  };

  const handleApprove = async (id: number) => {
    try {
      await leaveRequestService.approve(id, comment || undefined);
      setCommentId(null);
      setComment('');
      removeRequestFromCache(id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['leave-requests-manage'] }),
        queryClient.invalidateQueries({ queryKey: ['my-leave-requests'] }),
        // Выходные корректировки попадают в очередь админа на /approvals
        queryClient.invalidateQueries({ queryKey: ['correction-approvals'] }),
      ]);
    } catch (err) {
      console.error('Approve error:', err);
      // Откат оптимистичного удаления через рефетч
      await queryClient.invalidateQueries({ queryKey: ['leave-requests-manage'] });
    }
  };

  const handleReject = async (id: number) => {
    try {
      await leaveRequestService.reject(id, comment || undefined);
      setCommentId(null);
      setComment('');
      removeRequestFromCache(id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['leave-requests-manage'] }),
        queryClient.invalidateQueries({ queryKey: ['my-leave-requests'] }),
      ]);
    } catch (err) {
      console.error('Reject error:', err);
      await queryClient.invalidateQueries({ queryKey: ['leave-requests-manage'] });
    }
  };

  const formatDate = (date: string) =>
    new Date(date).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const openAttachment = (att: ILeaveRequestAttachment) => {
    setPreview({ documentId: att.id, fileName: att.file_name, mimeType: att.mime_type });
  };

  const openEventsPanel = (r: ILeaveRequest) => {
    if (!r.correction_date) return;
    setEventsPanel({
      employeeId: r.employee_id,
      employeeName: r.employee_name || `#${r.employee_id}`,
      date: r.correction_date,
    });
  };

  const stop = (e: ReactMouseEvent) => e.stopPropagation();

  const renderCard = (r: ILeaveRequest) => {
    const Icon = STATUS_ICONS[r.status];
    const isCorrection = r.request_type === 'time_correction' && !!r.correction_date;
    const isActive =
      !!eventsPanel &&
      isCorrection &&
      eventsPanel.employeeId === r.employee_id &&
      eventsPanel.date === r.correction_date;
    const awaitingAdmin = isCorrection
      && r.status === 'approved'
      && r.correction_approval_status === 'pending';
    return (
      <div
        key={r.id}
        className={`lrm-card${isCorrection ? ' lrm-card--clickable' : ''}${isActive ? ' lrm-card--active' : ''}`}
        onClick={isCorrection ? () => openEventsPanel(r) : undefined}
        role={isCorrection ? 'button' : undefined}
        tabIndex={isCorrection ? 0 : undefined}
        onKeyDown={isCorrection ? (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openEventsPanel(r);
          }
        } : undefined}
      >
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
            <span className="lrm-status" style={{ color: STATUS_COLORS[r.status] }}>
              <Icon size={14} /> <strong>{STATUS_LABELS[r.status]}</strong>
            </span>
          </div>
          {awaitingAdmin && (
            <div className="lrm-card-pending-admin" style={{ color: '#f59e0b' }}>
              <Clock size={12} /> <strong>Ожидает доп. согласования администратором</strong>
            </div>
          )}
          <div className="lrm-card-type">{REQUEST_TYPE_LABELS[r.request_type]}</div>
          {r.request_type === 'time_correction' && r.correction_date ? (
            <div className="lrm-card-dates">
              <strong>Дата: {formatDate(r.correction_date)}</strong>
              {' · '}
              <strong>
                Статус: {r.correction_status
                  ? (CORRECTION_STATUS_LABELS[r.correction_status] ?? r.correction_status)
                  : '—'}
              </strong>
              {r.correction_hours != null ? ` · ${r.correction_hours}ч` : ''}
            </div>
          ) : (
            <div className="lrm-card-dates">
              <strong>{formatDate(r.start_date)} — {formatDate(r.end_date)}</strong>
            </div>
          )}
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
                  <span className="lrm-attachment-name">{formatAttachmentName(att.file_name)}</span>
                </button>
              ))}
            </div>
          )}
          {r.review_comment && (
            <div className="lrm-card-comment">
              <span className="lrm-card-comment-label">Комментарий:</span> {r.review_comment}
            </div>
          )}
        </div>

        {r.status === 'pending' && (
          <div className="lrm-card-actions" onClick={stop}>
            {commentId === r.id ? (
              <div className="lrm-comment-form">
                <input
                  className="lrm-comment-input"
                  placeholder="Комментарий (необязательно)"
                  value={comment}
                  onChange={e => setComment(e.target.value)}
                  onClick={stop}
                />
                <div className="lrm-comment-btns">
                  <button
                    className="lrm-action-btn approve"
                    onClick={(e) => { e.stopPropagation(); handleApprove(r.id); }}
                  >
                    <Check size={14} /> Одобрить
                  </button>
                  <button
                    className="lrm-action-btn reject"
                    onClick={(e) => { e.stopPropagation(); handleReject(r.id); }}
                  >
                    <X size={14} /> Отклонить
                  </button>
                </div>
              </div>
            ) : (
              <div className="lrm-action-row">
                <button
                  className="lrm-action-btn approve"
                  onClick={(e) => { e.stopPropagation(); handleApprove(r.id); }}
                >
                  <Check size={14} /> Одобрить
                </button>
                <button
                  className="lrm-action-btn reject"
                  onClick={(e) => { e.stopPropagation(); setCommentId(r.id); }}
                >
                  <X size={14} /> Отклонить
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const totalEmployees = (items: ILeaveRequest[]) =>
    new Set(items.map(i => i.employee_id)).size;

  return (
    <div className={`lrm-shell${eventsPanel ? ' lrm-shell--with-panel' : ''}`}>
      <div className="lrm-page">
        <div className="lrm-header">
          <div className="lrm-filter">
            <button className={`lrm-filter-btn ${filter === 'pending' ? 'active' : ''}`} onClick={() => setFilter('pending')}>
              Ожидающие
            </button>
            <button className={`lrm-filter-btn ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
              Все
            </button>
          </div>
        </div>

        {isLoading ? (
          <div className="lrm-loading">Загрузка...</div>
        ) : filteredRequests.length === 0 ? (
          <div className="lrm-empty">Нет заявлений</div>
        ) : (
          <div className="lrm-list">
            {grouped.map(([department, items]) => {
              const isCollapsed = collapsedDepts.has(department);
              const isDirectReports = department === DIRECT_REPORTS_KEY;
              const label = isDirectReports ? DIRECT_REPORTS_TITLE : department;
              return (
                <div
                  key={department}
                  className={`lrm-group${isCollapsed ? ' lrm-group--collapsed' : ''}${isDirectReports ? ' lrm-group--direct-reports' : ''}`}
                >
                  {showGroupHeaders && (
                    <button
                      type="button"
                      className="lrm-group-toggle"
                      onClick={() => toggleDept(department)}
                      aria-expanded={!isCollapsed}
                    >
                      {isCollapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
                      <span className="lrm-group-name">{label}</span>
                      <span className="lrm-group-stats">
                        {items.length} · {totalEmployees(items)} чел
                      </span>
                    </button>
                  )}
                  {!isCollapsed && items.map(renderCard)}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {eventsPanel && (
        <LeaveRequestEventsPanel
          employeeId={eventsPanel.employeeId}
          employeeName={eventsPanel.employeeName}
          date={eventsPanel.date}
          onClose={() => setEventsPanel(null)}
        />
      )}

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
