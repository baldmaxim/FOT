import { useQuery } from '@tanstack/react-query';

import { timesheetSalaryService } from '../services/timesheetSalaryService';

/**
 * «Бригады → Объекты»: объекты месяца по всем бригадам. Ключ начинается с 'timesheet-salary' — правку выработки в режиме
 * «Бригады» перечитывает invalidateBrigadeOutputs. Запрос тяжёлый (расчёт всех бригад месяца): без повтора, свежим
 * считается 5 минут (переключение «Бригады | Объекты» не пересчитывает), а пока он идёт — «Загрузка…», а не прежние
 * цифры: после правки выработки старый «—» в «Часе» не должен висеть как ответ.
 */
export const useBrigadeObjectsSummary = ({ month, enabled }: { month: string; enabled: boolean }) => {
  const query = useQuery({
    queryKey: ['timesheet-salary', 'objects-summary', month],
    queryFn: ({ signal }) => timesheetSalaryService.getObjectsSummary(month, signal),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
  return { data: query.data, loading: query.isLoading || query.isFetching, error: query.isError };
};
