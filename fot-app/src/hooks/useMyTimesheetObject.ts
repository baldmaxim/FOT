import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { timesheetObjectService, type ITimesheetObjectState } from '../services/timesheetObjectService';

export const MY_TIMESHEET_OBJECT_QUERY_KEY = ['my-timesheet-object'] as const;

/**
 * Свой объект табелирования (ЛК). Окно смены открывается и закрывается по календарю,
 * поэтому состояние перечитывается при возврате на вкладку.
 */
export const useMyTimesheetObject = (employeeId: number | null | undefined) => {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: MY_TIMESHEET_OBJECT_QUERY_KEY,
    queryFn: () => timesheetObjectService.getMine(),
    enabled: Boolean(employeeId),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  const mutation = useMutation({
    mutationFn: (value: string) => timesheetObjectService.updateMine(value),
    onSuccess: (state: ITimesheetObjectState) => {
      queryClient.setQueryData(MY_TIMESHEET_OBJECT_QUERY_KEY, state);
      if (employeeId) void queryClient.invalidateQueries({ queryKey: ['employee', employeeId] });
      void queryClient.invalidateQueries({ queryKey: ['timesheet'] });
      void queryClient.invalidateQueries({ queryKey: ['timesheet-page'] });
    },
  });

  return { query, mutation };
};
