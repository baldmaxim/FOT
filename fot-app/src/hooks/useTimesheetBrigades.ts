import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { ApiError } from '../api/client';
import { useToast } from '../contexts/ToastContext';
import { timesheetSalaryService } from '../services/timesheetSalaryService';

/** Ключ списка вкладки «Бригады». */
export const BRIGADE_OUTPUTS_QUERY_KEY = 'timesheet-salary-brigades';

/**
 * Выработку правят и «Бригады», и «Зарплата по объектам»: после правки — и после 409 (кто-то уже внёс выработку
 * другим способом) — перечитать обе.
 */
export const invalidateBrigadeOutputs = (queryClient: QueryClient): Promise<unknown> => Promise.all([
  queryClient.invalidateQueries({ queryKey: ['timesheet-salary'] }),
  queryClient.invalidateQueries({ queryKey: [BRIGADE_OUTPUTS_QUERY_KEY] }),
]);

/** 409 «или — или»: выработка уже внесена другим способом. */
export const isOutputModeConflict = (error: unknown): boolean => error instanceof ApiError && error.status === 409;

const errorMessage = (error: unknown, fallback: string): string => (
  error instanceof Error && error.message ? error.message : fallback
);

/** «Табель → Бригады»: бригады месяца и выработка одной суммой на бригаду. */
export const useTimesheetBrigades = ({ month, enabled }: { month: string; enabled: boolean }) => {
  const queryClient = useQueryClient();
  const toast = useToast();

  const query = useQuery({
    queryKey: [BRIGADE_OUTPUTS_QUERY_KEY, month],
    queryFn: ({ signal }) => timesheetSalaryService.listBrigades(month, signal),
    enabled,
    staleTime: 30_000,
  });

  const outputMutation = useMutation({
    mutationFn: ({ departmentId, amount }: { departmentId: string; amount: number | null }) => (
      timesheetSalaryService.setBrigadeOutput(departmentId, month, amount)
    ),
    onSuccess: () => invalidateBrigadeOutputs(queryClient),
    onError: error => {
      toast.error(errorMessage(error, 'Не удалось сохранить выработку'));
      if (isOutputModeConflict(error)) void invalidateBrigadeOutputs(queryClient);
    },
  });

  const { mutateAsync } = outputMutation;
  const setBrigadeOutput = useCallback(async (departmentId: string, amount: number | null) => {
    await mutateAsync({ departmentId, amount });
  }, [mutateAsync]);

  return {
    brigades: query.data,
    loading: query.isLoading,
    error: query.isError,
    setBrigadeOutput,
    savingDepartmentId: outputMutation.isPending ? (outputMutation.variables?.departmentId ?? null) : null,
  };
};
