import { type FC } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { EmployeeHistorySection } from '../../components/employees/EmployeeHistorySection';
import { useEmployeeHistory } from '../../hooks/usePortalData';
import type { EmployeeHistoryEvent } from '../../types';

const EMPTY_HISTORY: EmployeeHistoryEvent[] = [];

export const MyHistoryPage: FC = () => {
  const { profile } = useAuth();
  const { data, isLoading } = useEmployeeHistory(profile?.employee_id ?? null, !!profile?.employee_id);
  const history = data ?? EMPTY_HISTORY;

  if (isLoading) {
    return <div style={{ padding: 24, color: 'var(--text-tertiary)' }}>Загрузка...</div>;
  }

  if (!profile?.employee_id) {
    return <div style={{ padding: 24, color: 'var(--text-tertiary)' }}>Профиль не привязан к сотруднику</div>;
  }

  return (
    <div>
      <EmployeeHistorySection history={history} />
    </div>
  );
};
