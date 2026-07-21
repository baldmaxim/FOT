import { type FC, lazy, Suspense, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { type ILeaveRequest } from '../../services/leaveRequestService';
import { useAuth } from '../../contexts/AuthContext';
import { getMyLeaveRequestsQueryKey, useMyLeaveRequests } from '../../hooks/usePortalData';
import { LeaveRequestRow } from '../../components/dashboard/LeaveRequestRow';
import { isLeaveRequestArchived } from '../../utils/leaveRequestDates';
import './LeaveRequestsPage.css';

const UnifiedRequestModal = lazy(() =>
  import('../../components/dashboard/RequestModals').then(m => ({ default: m.UnifiedRequestModal })),
);

const CancelRequestModal = lazy(() =>
  import('../../components/dashboard/CancelRequestModal').then(m => ({ default: m.CancelRequestModal })),
);

const EMPTY_REQUESTS: ILeaveRequest[] = [];

type TabKey = 'active' | 'archive';

const todayIso = (): string => new Date().toLocaleDateString('en-CA');

export const LeaveRequestsPage: FC = () => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { profile, canEditPage } = useAuth();
  const employeeId = profile?.employee_id ?? null;
  // view-only конфигурация роли: список доступен, подача и отмена скрыты.
  const canEditRequests = canEditPage('/employee/requests');
  const [showModal, setShowModal] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<ILeaveRequest | null>(null);
  const [tab, setTab] = useState<TabKey>('active');
  const { data, isLoading } = useMyLeaveRequests();
  const requests = data ?? EMPTY_REQUESTS;

  const today = todayIso();
  const visible = requests.filter(r =>
    tab === 'archive' ? isLeaveRequestArchived(r, today) : !isLeaveRequestArchived(r, today),
  );

  const handleCancelled = async (updated: ILeaveRequest) => {
    setCancelTarget(null);
    // Оптимистично подмешиваем ответ целиком (статус + след отмены: кто/когда/почему),
    // иначе до refetch карточка показывала бы «Отменено» без инициатора и причины.
    queryClient.setQueryData<ILeaveRequest[] | undefined>(
      getMyLeaveRequestsQueryKey(),
      (prev) => prev?.map(r => r.id === updated.id ? { ...r, ...updated } : r),
    );
    await queryClient.invalidateQueries({ queryKey: getMyLeaveRequestsQueryKey() });
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
        {canEditRequests && (
          <button className="btn-primary" onClick={() => setShowModal(true)}>
            <Plus size={16} /> Создать
          </button>
        )}
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
              onCancel={canEditRequests ? setCancelTarget : undefined}
            />
          ))}
        </div>
      )}

      {showModal && canEditRequests && (
        <Suspense fallback={null}>
          <UnifiedRequestModal
            employeeId={employeeId}
            onClose={() => setShowModal(false)}
          />
        </Suspense>
      )}

      {cancelTarget && canEditRequests && (
        <Suspense fallback={null}>
          <CancelRequestModal
            request={cancelTarget}
            onClose={() => setCancelTarget(null)}
            onCancelled={handleCancelled}
          />
        </Suspense>
      )}
    </div>
  );
};
