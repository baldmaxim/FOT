import { type FC, type MouseEvent } from 'react';
import { Clock, CheckCircle, XCircle, Ban, ChevronRight } from 'lucide-react';
import {
  REQUEST_TYPE_LABELS,
  STATUS_LABELS,
  type ILeaveRequest,
  type LeaveRequestStatus,
} from '../../services/leaveRequestService';
import { formatLeaveRequestDatesCompact, isLeaveRequestArchived } from '../../utils/leaveRequestDates';
import { formatFioShort } from '../../utils/formatFio';
import '../../pages/employee/LeaveRequestsPage.css';

const STATUS_ICONS: Record<LeaveRequestStatus, FC<{ size?: number }>> = {
  pending: Clock,
  approved: CheckCircle,
  rejected: XCircle,
  cancelled: Ban,
};

const STATUS_COLORS: Record<LeaveRequestStatus, string> = {
  pending: '#f59e0b',
  approved: '#22c55e',
  rejected: '#ef4444',
  cancelled: '#6b7280',
};

const formatDate = (date: string) =>
  new Date(date).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });

interface ILeaveRequestRowProps {
  request: ILeaveRequest;
  today: string;
  onClick?: () => void;
  onCancel?: (id: number, status: ILeaveRequest['status']) => void;
}

export const LeaveRequestRow: FC<ILeaveRequestRowProps> = ({ request: r, today, onClick, onCancel }) => {
  const Icon = STATUS_ICONS[r.status];
  const awaitingApproval = (r.request_type === 'time_correction' || r.request_type === 'work')
    && r.correction_approval_status === 'pending';
  const canCancel =
    !!onCancel && (r.status === 'pending' || r.status === 'approved') && !isLeaveRequestArchived(r, today);

  const handleCardClick = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    onClick?.();
  };

  return (
    <div
      className={`lr-card${onClick ? ' lr-card-clickable' : ''}`}
      onClick={onClick ? handleCardClick : undefined}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      <div className="lr-card-left">
        <div className="lr-card-type">{REQUEST_TYPE_LABELS[r.request_type]}</div>
        {r.request_type === 'time_correction' && r.correction_date ? (
          <div className="lr-card-dates">Дата: {formatDate(r.correction_date)} · Статус: {r.correction_status} · {r.correction_hours != null ? `${r.correction_hours}ч` : ''}</div>
        ) : (
          <div className="lr-card-dates">{formatLeaveRequestDatesCompact(r)}</div>
        )}
        {r.reason && <div className="lr-card-reason">{r.reason}</div>}
        {awaitingApproval && (
          <div className="lr-card-pending-admin" style={{ color: '#f59e0b' }}>
            <Clock size={12} /> <strong>Ожидает согласования</strong>
          </div>
        )}
        {r.review_comment && <div className="lr-card-comment">Комментарий: {r.review_comment}</div>}
      </div>
      <div className="lr-card-right">
        <div className="lr-status-wrap">
          <span className="lr-status" style={{ color: STATUS_COLORS[r.status] }}>
            <Icon size={16} /> {STATUS_LABELS[r.status]}
          </span>
          {(r.status === 'approved' || r.status === 'rejected') && (r.reviewer || r.reviewed_at) && (
            <div className="lr-status-meta">
              {formatFioShort(r.reviewer?.full_name)}
              {r.reviewer?.full_name && r.reviewed_at ? ' · ' : ''}
              {r.reviewed_at ? formatDate(r.reviewed_at) : ''}
            </div>
          )}
          {r.hr_acknowledged_at && (
            <div className="lr-hr-ack" title="Отдел кадров ознакомлен">
              <CheckCircle size={13} /> Отдел кадров ознакомлен
            </div>
          )}
        </div>
        {canCancel && (
          <button className="btn-secondary lr-cancel-btn" onClick={() => onCancel?.(r.id, r.status)}>Отменить</button>
        )}
        {onClick && <ChevronRight size={18} className="lr-card-chevron" />}
      </div>
    </div>
  );
};
