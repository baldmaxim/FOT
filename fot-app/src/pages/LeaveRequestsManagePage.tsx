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
  Pencil,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import {
  leaveRequestService,
  REQUEST_TYPE_LABELS,
  STATUS_LABELS,
  CORRECTION_STATUS_LABELS,
  type ILeaveRequest,
  type ILeaveRequestAttachment,
  type LeaveRequestStatus,
  type LeaveRequestType,
} from '../services/leaveRequestService';
import { useLeaveRequestsManage } from '../hooks/usePortalData';
import { FilePreviewModal } from '../components/documents/FilePreviewModal';
import { SearchInput } from '../components/ui/SearchInput';
import { LeaveRequestEventsPanel } from '../components/leave-requests/LeaveRequestEventsPanel';
import { formatLeaveRequestDatesCompact, leaveRequestMinDate } from '../utils/leaveRequestDates';
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
// Типы «отпусков», для которых доступна управленческая отмена согласованного.
const VACATION_TYPES = new Set(['vacation', 'unpaid', 'educational_leave']);
const NO_DEPARTMENT_KEY = 'Без отдела';
const DIRECT_REPORTS_KEY = '__direct_reports__';
const DIRECT_REPORTS_TITLE = 'Непосредственные подчинённые';

// Единый ключ группы отдела — и для группировки списка, и для фильтра по отделам.
const groupKeyOf = (r: ILeaveRequest) =>
  (r.is_direct_subordinate ? DIRECT_REPORTS_KEY : (r.department_name?.trim() || NO_DEPARTMENT_KEY));

// «Без отдела» и «Непосредственные подчинённые» — в конце, остальные по алфавиту.
const compareGroupKeys = (a: string, b: string) => {
  if (a === DIRECT_REPORTS_KEY) return 1;
  if (b === DIRECT_REPORTS_KEY) return -1;
  if (a === NO_DEPARTMENT_KEY) return 1;
  if (b === NO_DEPARTMENT_KEY) return -1;
  return a.localeCompare(b, 'ru');
};

// Старые вложения (до Unicode-фикса sanitizeFileName) хранятся в БД как
// «________.pdf» или с двойной UTF-8→latin1 кодировкой. Показываем им
// fallback «Документ.ext» через общий хелпер; исходное имя остаётся в title.
const formatAttachmentName = displayFileName;

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
  const { hasPermission, profile } = useAuth();
  const { showToast } = useToast();
  const isDepartmentScope = hasPermission('data.scope.department') && !hasPermission('data.scope.all');
  const scope = isDepartmentScope ? 'department' : 'all';
  const queryClient = useQueryClient();

  // «Сегодня» в Europe/Moscow (как на бэке) — для показа кнопки отмены только на будущих отпусках.
  const todayIso = useMemo(() => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' }), []);

  const [filter, setFilter] = useState<'pending' | 'all'>('pending');
  const [search, setSearch] = useState('');
  const [deptFilter, setDeptFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<LeaveRequestType | 'all'>('all');
  const [commentId, setCommentId] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [revokeId, setRevokeId] = useState<number | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  const [revoking, setRevoking] = useState(false);
  const [editingReasonId, setEditingReasonId] = useState<number | null>(null);
  const [reasonDraft, setReasonDraft] = useState('');
  const [savingReason, setSavingReason] = useState(false);
  const [preview, setPreview] = useState<IPreviewState | null>(null);
  const [eventsPanel, setEventsPanel] = useState<IEventsPanelState | null>(null);
  const [collapsedDepts, setCollapsedDepts] = useState<Set<string>>(new Set());
  const { data, isLoading } = useLeaveRequestsManage(scope, filter);
  const requests = data ?? EMPTY_REQUESTS;

  const baseRequests = useMemo(
    () => (filter === 'pending' && isDepartmentScope ? requests.filter(r => r.status === 'pending') : requests),
    [filter, isDepartmentScope, requests],
  );

  // Опции фильтра по отделам — из списка ДО поиска/фильтров, чтобы селект не сужался при фильтрации.
  const deptOptions = useMemo(
    () => Array.from(new Set(baseRequests.map(groupKeyOf))).sort(compareGroupKeys),
    [baseRequests],
  );

  const query = search.trim().toLowerCase();
  const isFiltering = query !== '' || deptFilter !== 'all' || typeFilter !== 'all';

  const filteredRequests = useMemo(() => {
    if (!isFiltering) return baseRequests;
    return baseRequests.filter(r =>
      (typeFilter === 'all' || r.request_type === typeFilter)
      && (deptFilter === 'all' || groupKeyOf(r) === deptFilter)
      && (query === '' || (r.employee_name ?? '').toLowerCase().includes(query)));
  }, [baseRequests, isFiltering, typeFilter, deptFilter, query]);

  const grouped = useMemo(() => {
    const map = new Map<string, ILeaveRequest[]>();
    for (const r of filteredRequests) {
      // Непосредственные подчинённые (вне subtree отдела руководителя) — в
      // отдельную псевдо-группу в конце списка.
      const key = groupKeyOf(r);
      const list = map.get(key) ?? [];
      list.push(r);
      map.set(key, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => compareGroupKeys(a, b));
  }, [filteredRequests]);

  // Для админа (scope='all') заголовки отделов показываем всегда — даже если
  // получилась 1 группа (включая «Без отдела»): админу нужен явный контекст.
  // Для руководителя (scope='department') поведение прежнее — 1 группа →
  // плоско, ≥2 (отдел + direct reports или несколько отделов) → группы.
  const showGroupHeaders = scope === 'all' ? grouped.length >= 1 : grouped.length > 1;

  useEffect(() => {
    // Дефолтное сворачивание (>2 групп — свернуть все) — только при смене
    // данных: загрузка списка, переключатель «Ожидающие/Все» (входит в
    // baseRequests). Клиентские фильтры (тип/отдел/поиск) состояние
    // сворачивания не трогают — пользователь управляет им сам.
    const keys = new Set(baseRequests.map(groupKeyOf));
    setCollapsedDepts(keys.size > 2 ? keys : new Set());
  }, [baseRequests]);

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
      showToast('error', err instanceof Error ? err.message : 'Не удалось согласовать заявление');
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
      showToast('error', err instanceof Error ? err.message : 'Не удалось отклонить заявление');
      await queryClient.invalidateQueries({ queryKey: ['leave-requests-manage'] });
    }
  };

  // Правка текста заявления (например, дописать пропущенный объект) — доступна
  // независимо от статуса заявления, синхронизируется с копией в табеле на бэке.
  const handleUpdateReason = async (id: number) => {
    const trimmed = reasonDraft.trim();
    if (!trimmed) return;
    setSavingReason(true);
    try {
      await leaveRequestService.updateReason(id, trimmed);
      queryClient.setQueriesData<ILeaveRequest[] | undefined>(
        { queryKey: ['leave-requests-manage'] },
        (prev) => (prev ? prev.map(r => (r.id === id ? { ...r, reason: trimmed } : r)) : prev),
      );
      setEditingReasonId(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['leave-requests-manage'] }),
        queryClient.invalidateQueries({ queryKey: ['timesheet-page'] }),
      ]);
    } catch (err) {
      console.error('Update reason error:', err);
    } finally {
      setSavingReason(false);
    }
  };

  const handleRevoke = async (id: number) => {
    setRevoking(true);
    try {
      await leaveRequestService.revokeApproval(id, revokeReason.trim() || undefined);
      setRevokeId(null);
      setRevokeReason('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['leave-requests-manage'] }),
        queryClient.invalidateQueries({ queryKey: ['my-leave-requests'] }),
        queryClient.invalidateQueries({ queryKey: ['leave-requests-vacations'] }),
      ]);
    } catch (err) {
      console.error('Revoke error:', err);
      await queryClient.invalidateQueries({ queryKey: ['leave-requests-manage'] });
    } finally {
      setRevoking(false);
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
    const awaitingApproval = (isCorrection || r.request_type === 'work')
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
            <div className="lrm-status-wrap">
              <span className="lrm-status" style={{ color: STATUS_COLORS[r.status] }}>
                <Icon size={14} /> <strong>{STATUS_LABELS[r.status]}</strong>
              </span>
              {(r.status === 'approved' || r.status === 'rejected') && (r.reviewer || r.reviewed_at) && (
                <div className="lrm-status-meta">
                  {formatFioShort(r.reviewer?.full_name)}
                  {r.reviewer?.full_name && r.reviewed_at ? ' · ' : ''}
                  {r.reviewed_at ? formatDate(r.reviewed_at) : ''}
                </div>
              )}
              {r.hr_acknowledged_at && (
                <div className="lrm-hr-ack" title="Отдел кадров ознакомлен">
                  <CheckCircle size={13} /> Отдел кадров ознакомлен
                </div>
              )}
            </div>
          </div>
          {awaitingApproval && (
            <div className="lrm-card-pending-admin" style={{ color: '#f59e0b' }}>
              <Clock size={12} /> <strong>Ожидает согласования</strong>
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
              <strong>{formatLeaveRequestDatesCompact(r)}</strong>
            </div>
          )}
          {editingReasonId === r.id ? (
            <div className="lrm-card-reason lrm-card-reason--editing" onClick={stop}>
              <textarea
                className="lrm-reason-textarea"
                value={reasonDraft}
                onChange={(e) => setReasonDraft(e.target.value)}
                maxLength={500}
                rows={3}
                disabled={savingReason}
                autoFocus
              />
              <div className="lrm-reason-actions">
                <button
                  type="button"
                  className="lrm-action-btn approve"
                  disabled={savingReason || !reasonDraft.trim()}
                  onClick={() => void handleUpdateReason(r.id)}
                >
                  Сохранить
                </button>
                <button
                  type="button"
                  className="lrm-action-btn ghost"
                  disabled={savingReason}
                  onClick={() => setEditingReasonId(null)}
                >
                  Отмена
                </button>
              </div>
            </div>
          ) : (
            r.reason && (
              <div className="lrm-card-reason lrm-card-reason--viewable">
                <span>{r.reason}</span>
                <button
                  type="button"
                  className="lrm-reason-edit-btn"
                  onClick={(e) => { e.stopPropagation(); setEditingReasonId(r.id); setReasonDraft(r.reason ?? ''); }}
                  aria-label="Изменить текст заявления"
                  title="Изменить текст"
                >
                  <Pencil size={13} />
                </button>
              </div>
            )
          )}
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
                  onKeyDown={e => e.stopPropagation()}
                />
                <div className="lrm-comment-btns">
                  <button
                    className="lrm-action-btn approve"
                    onClick={(e) => { e.stopPropagation(); handleApprove(r.id); }}
                  >
                    <Check size={14} /> Согласовать
                  </button>
                  <button
                    className="lrm-action-btn reject"
                    onClick={(e) => { e.stopPropagation(); handleReject(r.id); }}
                  >
                    <X size={14} /> Не согласовать
                  </button>
                </div>
              </div>
            ) : (
              <div className="lrm-action-row">
                <button
                  className="lrm-action-btn approve"
                  onClick={(e) => { e.stopPropagation(); handleApprove(r.id); }}
                >
                  <Check size={14} /> Согласовать
                </button>
                <button
                  className="lrm-action-btn reject"
                  onClick={(e) => { e.stopPropagation(); setCommentId(r.id); }}
                >
                  <X size={14} /> Не согласовать
                </button>
              </div>
            )}
          </div>
        )}

        {r.status === 'approved'
          && VACATION_TYPES.has(r.request_type)
          && (profile?.is_admin || profile?.id === r.reviewer_id)
          && (profile?.is_admin || leaveRequestMinDate(r) > todayIso) && (
          <div className="lrm-card-actions" onClick={stop}>
            {revokeId === r.id ? (
              <div className="lrm-comment-form">
                <div className="lrm-revoke-confirm">Отменить согласованный отпуск?</div>
                <input
                  className="lrm-comment-input"
                  placeholder="Причина (необязательно)"
                  value={revokeReason}
                  onChange={e => setRevokeReason(e.target.value)}
                  onClick={stop}
                  onKeyDown={e => e.stopPropagation()}
                />
                <div className="lrm-comment-btns">
                  <button
                    className="lrm-action-btn reject"
                    disabled={revoking}
                    onClick={(e) => { e.stopPropagation(); handleRevoke(r.id); }}
                  >
                    <Ban size={14} /> {revoking ? 'Отменяем…' : 'Отменить отпуск'}
                  </button>
                  <button
                    className="lrm-action-btn ghost"
                    disabled={revoking}
                    onClick={(e) => { e.stopPropagation(); setRevokeId(null); setRevokeReason(''); }}
                  >
                    Назад
                  </button>
                </div>
              </div>
            ) : (
              <div className="lrm-action-row">
                <button
                  className="lrm-action-btn revoke"
                  onClick={(e) => { e.stopPropagation(); setRevokeId(r.id); setRevokeReason(''); }}
                >
                  <Ban size={14} /> Отменить согласованное
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
          {scope === 'all' && (
            <>
              <SearchInput value={search} onValueChange={setSearch} placeholder="Поиск по ФИО..." />
              <select
                className="lrm-filter-select"
                value={deptFilter}
                onChange={e => setDeptFilter(e.target.value)}
                aria-label="Фильтр по отделу"
              >
                <option value="all">Все отделы</option>
                {deptOptions.map(key => (
                  <option key={key} value={key}>
                    {key === DIRECT_REPORTS_KEY ? DIRECT_REPORTS_TITLE : key}
                  </option>
                ))}
              </select>
              <select
                className="lrm-filter-select"
                value={typeFilter}
                onChange={e => setTypeFilter(e.target.value as LeaveRequestType | 'all')}
                aria-label="Фильтр по типу заявления"
              >
                <option value="all">Все типы</option>
                {Object.entries(REQUEST_TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </>
          )}
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
          <div className="lrm-empty">{isFiltering ? 'Ничего не найдено' : 'Нет заявлений'}</div>
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
