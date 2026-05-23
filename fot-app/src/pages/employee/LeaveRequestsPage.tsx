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

type TabKey = 'active' | 'archive';

const todayIso = (): string => new Date().toLocaleDateString('en-CA');

const isArchived = (r: ILeaveRequest, today: string): boolean => {
  if (r.request_type === 'time_correction') {
    return !!r.correction_date && r.correction_date < today;
  }
  return r.end_date < today;
};

export const LeaveRequestsPage: FC = () => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const employeeId = profile?.employee_id ?? null;
  const [showModal, setShowModal] = useState(false);
  const [tab, setTab] = useState<TabKey>('active');
  const { data, isLoading } = useMyLeaveRequests();
  const requests = data ?? EMPTY_REQUESTS;

  const today = todayIso();
  const visible = requests.filter(r =>
    tab === 'archive' ? isArchived(r, today) : !isArchived(r, today),
  );

  const handleCancel = async (id: number, status: ILeaveRequest['status']) => {
    const confirmText = status === 'approved'
      ? 'Отменить уже одобренное заявление? Связанные корректировки табеля будут удалены.'
      : 'Отменить заявление?';
    if (!window.confirm(confirmText)) return;
    try {
      await leaveRequestService.cancel(id);
      // Оптимистично переключаем статус, чтобы кнопка «Отменить» исчезла мгновенно.
      queryClient.setQueryData<ILeaveRequest[] | undefined>(
        getMyLeaveRequestsQueryKey(),
        (prev) => prev?.map(r => r.id === id ? { ...r, status: 'cancelled' } : r),
      );
      await queryClient.invalidateQueries({ queryKey: getMyLeaveRequestsQueryKey() });
    } catch (err) {
      console.error('Cancel leave request error:', err);
      // 400 «уже обработано» → кэш устарел; принудительно подтянем актуальные
      // данные, чтобы кнопка пропала и юзер увидел реальный статус.
      await queryClient.invalidateQueries({ queryKey: getMyLeaveRequestsQueryKey() });
    }
  };

  const formatDate = (date: string) =>
    new Date(date).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const emptyText = tab === 'archive' ? 'Архив пуст' : 'Нет активных заявлений';

  return (
    <div className="lr-page">
      <div className="lr-header">
        <div className="lr-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'active'}
            className={`lr-tab${tab === 'active' ? ' lr-tab-active' : ''}`}
            onClick={() => setTab('active')}
          >
            Активные
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'archive'}
            className={`lr-tab${tab === 'archive' ? ' lr-tab-active' : ''}`}
            onClick={() => setTab('archive')}
          >
            Архив
          </button>
        </div>
        <button className="btn-primary" onClick={() => setShowModal(true)}>
          <Plus size={16} /> Создать
        </button>
      </div>

      {isLoading ? (
        <div className="lr-loading">Загрузка...</div>
      ) : visible.length === 0 ? (
        <div className="lr-empty">{emptyText}</div>
      ) : (
        <div className="lr-list">
          {visible.map(r => {
            const Icon = STATUS_ICONS[r.status];
            const awaitingAdmin = r.request_type === 'time_correction'
              && r.status === 'approved'
              && r.correction_approval_status === 'pending';
            const canCancel =
              (r.status === 'pending' || r.status === 'approved') && !isArchived(r, today);
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
                  {awaitingAdmin && (
                    <div className="lr-card-pending-admin" style={{ color: '#f59e0b' }}>
                      <Clock size={12} /> <strong>Ожидает доп. согласования администратором</strong>
                    </div>
                  )}
                  {r.review_comment && <div className="lr-card-comment">Комментарий: {r.review_comment}</div>}
                </div>
                <div className="lr-card-right">
                  <span className="lr-status" style={{ color: STATUS_COLORS[r.status] }}>
                    <Icon size={16} /> {STATUS_LABELS[r.status]}
                  </span>
                  {canCancel && (
                    <button className="btn-secondary lr-cancel-btn" onClick={() => handleCancel(r.id, r.status)}>Отменить</button>
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
