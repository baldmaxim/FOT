import { type FC, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, X, Clock, CheckCircle, XCircle, Ban, Paperclip } from 'lucide-react';
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

interface IPreviewState {
  documentId: number;
  fileName: string;
  mimeType: string | null;
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
  const { data, isLoading } = useLeaveRequestsManage(scope, filter);
  const requests = data ?? EMPTY_REQUESTS;

  const filteredRequests = filter === 'pending' && isDepartmentScope
    ? requests.filter(r => r.status === 'pending')
    : requests;

  const grouped = useMemo(() => {
    const map = new Map<string, ILeaveRequest[]>();
    for (const r of filteredRequests) {
      const key = r.department_name?.trim() || NO_DEPARTMENT_KEY;
      const list = map.get(key) ?? [];
      list.push(r);
      map.set(key, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => {
      if (a === NO_DEPARTMENT_KEY) return 1;
      if (b === NO_DEPARTMENT_KEY) return -1;
      return a.localeCompare(b, 'ru');
    });
  }, [filteredRequests]);

  const showGroupHeaders = grouped.length > 1;

  const handleApprove = async (id: number) => {
    try {
      await leaveRequestService.approve(id, comment || undefined);
      setCommentId(null);
      setComment('');
      await queryClient.invalidateQueries({ queryKey: ['leave-requests-manage'] });
    } catch (err) {
      console.error('Approve error:', err);
    }
  };

  const handleReject = async (id: number) => {
    try {
      await leaveRequestService.reject(id, comment || undefined);
      setCommentId(null);
      setComment('');
      await queryClient.invalidateQueries({ queryKey: ['leave-requests-manage'] });
    } catch (err) {
      console.error('Reject error:', err);
    }
  };

  const formatDate = (date: string) =>
    new Date(date).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const openAttachment = (att: ILeaveRequestAttachment) => {
    setPreview({ documentId: att.id, fileName: att.file_name, mimeType: att.mime_type });
  };

  const renderCard = (r: ILeaveRequest) => {
    const Icon = STATUS_ICONS[r.status];
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
            <span className="lrm-status" style={{ color: STATUS_COLORS[r.status] }}>
              <Icon size={14} /> <strong>{STATUS_LABELS[r.status]}</strong>
            </span>
          </div>
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
            <div className="lrm-attachments">
              {r.attachments.map(att => (
                <button
                  key={att.id}
                  type="button"
                  className="lrm-attachment-btn"
                  onClick={() => openAttachment(att)}
                  title="Открыть просмотр"
                >
                  <Paperclip size={12} />
                  <span className="lrm-attachment-name">{att.file_name}</span>
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
          <div className="lrm-card-actions">
            {commentId === r.id ? (
              <div className="lrm-comment-form">
                <input
                  className="lrm-comment-input"
                  placeholder="Комментарий (необязательно)"
                  value={comment}
                  onChange={e => setComment(e.target.value)}
                />
                <div className="lrm-comment-btns">
                  <button className="lrm-action-btn approve" onClick={() => handleApprove(r.id)}>
                    <Check size={14} /> Одобрить
                  </button>
                  <button className="lrm-action-btn reject" onClick={() => handleReject(r.id)}>
                    <X size={14} /> Отклонить
                  </button>
                </div>
              </div>
            ) : (
              <div className="lrm-action-row">
                <button className="lrm-action-btn approve" onClick={() => handleApprove(r.id)}>
                  <Check size={14} /> Одобрить
                </button>
                <button className="lrm-action-btn reject" onClick={() => setCommentId(r.id)}>
                  <X size={14} /> Отклонить
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="lrm-page">
      <div className="lrm-header">
        <h1 className="lrm-title">Заявления</h1>
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
          {grouped.map(([department, items]) => (
            <div key={department} className="lrm-group">
              {showGroupHeaders && <h3 className="lrm-group-title">{department}</h3>}
              {items.map(renderCard)}
            </div>
          ))}
        </div>
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
