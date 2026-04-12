import { useQuery } from '@tanstack/react-query';
import { skudService } from '../services/skudService';
import type { IDashboardStats, DashboardPeriod } from '../types';
import { useDocumentVisibility } from './useDocumentVisibility';

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
  const isVisible = useDocumentVisibility();
  const refetchInterval = !isVisible
    ? false
    : period === 'today'
      ? 120_000
      : period === 'week'
        ? 180_000
        : 600_000;

  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard-stats', departmentId, period, month],
    queryFn: ({ signal }) => skudService.getDashboardStats(departmentId!, period, signal, month),
    enabled: !!departmentId,
    placeholderData: previousData => previousData,
    refetchInterval,
    refetchIntervalInBackground: false,
    staleTime: 60_000,
  });

  return {
    stats: data ?? null,
    loading: isLoading,
    error: error ? 'Ошибка загрузки аналитики' : null,
  };
};
