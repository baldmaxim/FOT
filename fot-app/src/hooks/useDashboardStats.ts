import { useCallback, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { skudService } from '../services/skudService';
import type { IDashboardStats, DashboardPeriod } from '../types';
import { useDocumentVisibility } from './useDocumentVisibility';

interface IUseDashboardStatsReturn {
  stats: IDashboardStats | null;
  loading: boolean;
  error: string | null;
  refresh: (force?: boolean) => void;
}

export const useDashboardStats = (
  departmentId: string | null,
  period: DashboardPeriod = 'today',
  month?: string,
): IUseDashboardStatsReturn => {
  const isVisible = useDocumentVisibility();
  const refetchInterval = isVisible ? 60_000 : false;
  // Флаг живёт между рендерами и читается внутри queryFn — позволяет точечно
  // обходить серверный кэш именно для ручного refresh, без пересборки queryKey.
  const forceNextRef = useRef(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard-stats', departmentId, period, month],
    queryFn: ({ signal }) => {
      const force = forceNextRef.current;
      forceNextRef.current = false;
      return skudService.getDashboardStats(departmentId!, period, signal, month, force);
    },
    enabled: !!departmentId,
    placeholderData: previousData => previousData,
    refetchInterval,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
  });
  const refresh = useCallback((force?: boolean) => {
    if (force) forceNextRef.current = true;
    void refetch();
  }, [refetch]);

  return {
    stats: data ?? null,
    loading: isLoading,
    error: error ? 'Ошибка загрузки аналитики' : null,
    refresh,
  };
};
