import { type FC, lazy, Suspense, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Clock, CheckCircle, XCircle, Ban, ChevronRight } from 'lucide-react';
import {
  leaveRequestService,
  REQUEST_TYPE_LABELS,
  STATUS_LABELS,
  type ILeaveRequest,
  type LeaveRequestStatus,
} from '../../services/leaveRequestService';
import { useAuth } from '../../contexts/AuthContext';
import { getMyLeaveRequestsQueryKey, useMyLeaveRequests } from '../../hooks/usePortalData';
import './LeaveRequestsPage.css';

const UnifiedRequestModal = lazy(() =>
  import('../../components/dashboard/RequestModals').then(m => ({ default: m.UnifiedRequestModal })),
);

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

const EMPTY_REQUESTS: ILeaveRequest[] = [];

export const LeaveRequestsPage: FC = () => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const employeeId = profile?.employee_id ?? null;
  const [showModal, setShowModal] = useState(false);
  const { data, isLoading } = useMyLeaveRequests();
  const requests = data ?? EMPTY_REQUESTS;

  const handleCancel = async (id: number) => {
    try {
      await leaveRequestService.cancel(id);
      await queryClient.invalidateQueries({ queryKey: getMyLeaveRequestsQueryKey() });
    } catch (err) {
      console.error('Cancel leave request error:', err);
    }
  };

  const formatDate = (date: string) =>
    new Date(date).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });

  return (
    <div className="lr-page">
      <div className="lr-header">
        <button className="btn-primary" onClick={() => setShowModal(true)}>
          <Plus size={16} /> Создать
        </button>
      </div>

      {isLoading ? (
        <div className="lr-loading">Загрузка...</div>
      ) : requests.length === 0 ? (
        <div className="lr-empty">Нет заявлений</div>
      ) : (
        <div className="lr-list">
          {requests.map(r => {
            const Icon = STATUS_ICONS[r.status];
            const handleCardClick = (e: React.MouseEvent) => {
              if ((e.target as HTMLElement).closest('button')) return;
              navigate(`/employee/requests/${r.id}`);
            };
            return (
              <div
                key={r.id}
                className="lr-card lr-card-clickable"
                onClick={handleCardClick}
                role="button"
                tabIndex={0}
              >
                <div className="lr-card-left">
                  <div className="lr-card-type">{REQUEST_TYPE_LABELS[r.request_type]}</div>
                  {r.request_type === 'time_correction' && r.correction_date ? (
                    <div className="lr-card-dates">Дата: {formatDate(r.correction_date)} · Статус: {r.correction_status} · {r.correction_hours != null ? `${r.correction_hours}ч` : ''}</div>
                  ) : (
                    <div className="lr-card-dates">{formatDate(r.start_date)} — {formatDate(r.end_date)}</div>
                  )}
                  {r.reason && <div className="lr-card-reason">{r.reason}</div>}
                  {r.review_comment && <div className="lr-card-comment">Комментарий: {r.review_comment}</div>}
                </div>
                <div className="lr-card-right">
                  <span className="lr-status" style={{ color: STATUS_COLORS[r.status] }}>
                    <Icon size={16} /> {STATUS_LABELS[r.status]}
                  </span>
                  {r.status === 'pending' && (
                    <button className="btn-secondary lr-cancel-btn" onClick={() => handleCancel(r.id)}>Отменить</button>
                  )}
                  <ChevronRight size={18} className="lr-card-chevron" />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showModal && (
        <Suspense fallback={null}>
          <UnifiedRequestModal
            employeeId={employeeId}
            onClose={() => setShowModal(false)}
          />
        </Suspense>
      )}
    </div>
  );
};
