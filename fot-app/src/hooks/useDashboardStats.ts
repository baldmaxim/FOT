import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { skudService } from '../services/skudService';
import type { IDashboardStats, DashboardPeriod } from '../types';
import { useDocumentVisibility } from './useDocumentVisibility';

interface IUseDashboardStatsReturn {
  stats: IDashboardStats | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export const useDashboardStats = (
  departmentId: string | null,
  period: DashboardPeriod = 'today',
  month?: string,
): IUseDashboardStatsReturn => {
  const isVisible = useDocumentVisibility();
  const refetchInterval = isVisible ? 60_000 : false;

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard-stats', departmentId, period, month],
    queryFn: ({ signal }) => skudService.getDashboardStats(departmentId!, period, signal, month),
    enabled: !!departmentId,
    placeholderData: previousData => previousData,
    refetchInterval,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
  });
  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);

  return {
    stats: data ?? null,
    loading: isLoading,
    error: error ? 'Ошибка загрузки аналитики' : null,
    refresh,
  };
};
