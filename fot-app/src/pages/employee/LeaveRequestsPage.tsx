import { type FC, lazy, Suspense, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import {
  REQUEST_TYPE_LABELS,
  type ILeaveRequest,
  type LeaveRequestType,
} from '../../services/leaveRequestService';
import { useAuth } from '../../contexts/AuthContext';
import { getMyLeaveRequestsQueryKey, useMyLeaveRequests } from '../../hooks/usePortalData';
import { LeaveRequestRow } from '../../components/dashboard/LeaveRequestRow';
import { SearchInput } from '../../components/ui/SearchInput';
import { isLeaveRequestArchived } from '../../utils/leaveRequestDates';
import { matchesLeaveRequestSearch } from '../../utils/leaveRequestSearch';
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
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<LeaveRequestType | 'all'>('all');
  const { data, isLoading } = useMyLeaveRequests();
  const requests = data ?? EMPTY_REQUESTS;

  // Только типы, которые есть у сотрудника, — по всем его заявлениям, чтобы список не менялся между вкладками.
  const typeOptions = useMemo(() => {
    const present = new Set<string>(requests.map(r => r.request_type));
    return (Object.keys(REQUEST_TYPE_LABELS) as LeaveRequestType[]).filter(t => present.has(t));
  }, [requests]);

  const today = todayIso();
  const isFiltering = search.trim() !== '' || typeFilter !== 'all';
  const visible = requests.filter(r =>
    (tab === 'archive' ? isLeaveRequestArchived(r, today) : !isLeaveRequestArchived(r, today))
    && (typeFilter === 'all' || r.request_type === typeFilter)
    && matchesLeaveRequestSearch(r, search),
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

  const emptyText = isFiltering
    ? 'Ничего не найдено'
    : (tab === 'archive' ? 'Архив пуст' : 'Нет активных заявлений');

  return (
    <div className="lr-page">
      <div className="lr-header">
        <div className="lr-toolbar">
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
          <div className="lr-filters">
            <div className="lr-search">
              <SearchInput
                value={search}
                onValueChange={setSearch}
                clearable
                aria-label="Поиск по заявлениям"
              />
            </div>
            <select
              className="lr-type-select"
              value={typeFilter}
              onChange={e => setTypeFilter(e.target.value as LeaveRequestType | 'all')}
              aria-label="Тип заявления"
            >
              <option value="all">Все типы</option>
              {typeOptions.map(t => (
                <option key={t} value={t}>{REQUEST_TYPE_LABELS[t]}</option>
              ))}
            </select>
          </div>
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
