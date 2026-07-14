import { useQuery } from '@tanstack/react-query';
import { dashboardMtsService } from '../services/dashboardMtsService';

/**
 * Статистика МТС по отделу за месяц (вкладка «МТС» на «Обзоре»).
 * Без refetchInterval: выписку наполняет ночной конвейер, поллинг бессмыслен.
 */
export const useDashboardMtsUsage = (departmentId: string | null, month: string, enabled = true) =>
  useQuery({
    queryKey: ['dashboard-mts-usage', departmentId, month],
    queryFn: () => dashboardMtsService.getDepartmentUsage(departmentId as string, month),
    enabled: enabled && !!departmentId,
    staleTime: 60_000,
  });
