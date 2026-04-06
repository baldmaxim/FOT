import { useQuery } from '@tanstack/react-query';
import { skudService } from '../services/skudService';
import type { IDashboardStats, DashboardPeriod } from '../types';

interface IUseDashboardStatsReturn {
  stats: IDashboardStats | null;
  loading: boolean;
  error: string | null;
}

export const useDashboardStats = (
  departmentId: string | null,
  period: DashboardPeriod = 'today',
  month?: string,
): IUseDashboardStatsReturn => {
  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard-stats', departmentId, period, month],
    queryFn: ({ signal }) => skudService.getDashboardStats(departmentId!, period, signal, month),
    enabled: !!departmentId,
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  return {
    stats: data ?? null,
    loading: isLoading,
    error: error ? 'Ошибка загрузки аналитики' : null,
  };
};
