import { useQuery } from '@tanstack/react-query';

import { timesheetSalaryService } from '../services/timesheetSalaryService';

/**
 * «Бригады → Объекты»: объекты месяца по всем бригадам. Ключ начинается с 'timesheet-salary' — правку выработки в режиме
 * «Бригады» перечитывает invalidateBrigadeOutputs. Без повтора: запрос тяжёлый (расчёт всех бригад месяца).
 */
export const useBrigadeObjectsSummary = ({ month, enabled }: { month: string; enabled: boolean }) => {
  const query = useQuery({
    queryKey: ['timesheet-salary', 'objects-summary', month],
    queryFn: ({ signal }) => timesheetSalaryService.getObjectsSummary(month, signal),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
  return { data: query.data, loading: query.isLoading, error: query.isError };
};
