import { type FC, lazy, Suspense, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import {
  leaveRequestService,
  type ILeaveRequest,
} from '../../services/leaveRequestService';
import { useAuth } from '../../contexts/AuthContext';
import { getMyLeaveRequestsQueryKey, useMyLeaveRequests } from '../../hooks/usePortalData';
import { LeaveRequestRow } from '../../components/dashboard/LeaveRequestRow';
import { isLeaveRequestArchived } from '../../utils/leaveRequestDates';
import './LeaveRequestsPage.css';

const UnifiedRequestModal = lazy(() =>
  import('../../components/dashboard/RequestModals').then(m => ({ default: m.UnifiedRequestModal })),
);

const EMPTY_REQUESTS: ILeaveRequest[] = [];

type TabKey = 'active' | 'archive';

const todayIso = (): string => new Date().toLocaleDateString('en-CA');

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
    tab === 'archive' ? isLeaveRequestArchived(r, today) : !isLeaveRequestArchived(r, today),
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
          {visible.map(r => (
            <LeaveRequestRow
              key={r.id}
              request={r}
              today={today}
              onClick={() => navigate(`/employee/requests/${r.id}`)}
              onCancel={handleCancel}
            />
          ))}
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
