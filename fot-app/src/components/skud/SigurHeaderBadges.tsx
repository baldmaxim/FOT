import { useQuery } from '@tanstack/react-query';
import { sigurAdminService } from '../../services/sigurAdminService';
import { sigurService } from '../../services/sigurService';
import './SigurHeaderBadges.css';

const numberFormatter = new Intl.NumberFormat('ru-RU');

export const SigurHeaderBadges = () => {
  const connectionStatusQuery = useQuery({
    queryKey: ['sigur-header', 'connection-status'],
    queryFn: () => sigurService.getConnectionStatus(),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  const totalEmployeesQuery = useQuery({
    queryKey: ['sigur-header', 'employees-total'],
    queryFn: async () => {
      const result = await sigurAdminService.getEmployees({ page: 1, pageSize: 1 });
      return result.meta.total;
    },
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  const connected = connectionStatusQuery.data?.connected;
  const statusTone = connected === true
    ? 'active'
    : connected === false
      ? 'inactive'
      : 'unknown';
  const statusText = connected === true
    ? 'Подключение активно'
    : connected === false
      ? 'Нет подключения'
      : 'Статус уточняется';

  const totalLabel = totalEmployeesQuery.data != null && !totalEmployeesQuery.isError
    ? numberFormatter.format(totalEmployeesQuery.data)
    : totalEmployeesQuery.isPending
      ? '...'
      : '-';

  return (
    <div className="sigur-header-badges" aria-label="Статус SIGUR">
      <span className={`sigur-header-badge sigur-header-badge--${statusTone}`}>
        <span className="sigur-header-badge__dot" />
        {statusText}
      </span>
      <span className="sigur-header-badge sigur-header-badge--count">
        Всего в SIGUR: {totalLabel}
      </span>
    </div>
  );
};
