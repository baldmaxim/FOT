import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError } from '../api/client';
import { useToast } from '../contexts/ToastContext';
import { timesheetSalaryService } from '../services/timesheetSalaryService';
import { BRIGADE_OUTPUTS_QUERY_KEY, invalidateBrigadeOutputs } from '../utils/brigadeSalaryCache';

/**
 * Выработку, КТУ и «Долю» правят и «Бригады», и «Зарплата по объектам»: после правки — и после 409 (кто-то уже внёс
 * выработку другим способом) — перечитать всё, где видны доли бригады (invalidateBrigadeOutputs).
 */
export { BRIGADE_OUTPUTS_QUERY_KEY, invalidateBrigadeOutputs };

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
