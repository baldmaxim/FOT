import { useState, useEffect, type FC } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { employeeService } from '../../services/employeeService';
import { EmployeeHistorySection } from '../../components/employees/EmployeeHistorySection';
import type { EmployeeHistoryEvent } from '../../types';

export const MyHistoryPage: FC = () => {
  const { profile } = useAuth();
  const [history, setHistory] = useState<EmployeeHistoryEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!profile?.employee_id) {
      setLoading(false);
      return;
    }
    setLoading(true);
    employeeService.getHistory(profile.employee_id)
      .then(setHistory)
      .catch(() => setHistory([]))
      .finally(() => setLoading(false));
  }, [profile?.employee_id]);

  if (loading) {
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
