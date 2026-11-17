import { useQuery } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import { employeeScheduleKeys } from '../api/queryKeys';
import { timesheetService } from '../services/timesheetService';

/** 404 — бэкенд без маршрута (фронт выкатили раньше): блок не показываем. */
export const isSchedulePlanMissing = (error: unknown): boolean => error instanceof ApiError && error.status === 404;

/**
 * План графика сотрудника на год месяца табеля. Ключ — сотрудник и год: внутри года данные те же,
 * месяц табеля нужен серверу только для проверки доступа, а блоку — для подсветки.
 */
export const useEmployeeSchedulePlan = (employeeId: number | null, month: string, enabled: boolean) => {
  const year = Number(month.slice(0, 4));
  return useQuery({
    queryKey: employeeScheduleKeys.plan(employeeId ?? 0, year),
    queryFn: () => timesheetService.getEmployeeSchedulePlan(employeeId as number, month),
    enabled: enabled && employeeId != null && Number.isInteger(year),
    retry: (failureCount, error) => !isSchedulePlanMissing(error) && failureCount < 1,
    // Глобально refetchOnWindowFocus выключен (App.tsx): события смены графика приходят не всем, кто смотрит.
    refetchOnWindowFocus: 'always',
  });
};
