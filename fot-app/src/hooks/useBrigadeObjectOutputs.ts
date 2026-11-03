import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useToast } from '../contexts/ToastContext';
import { timesheetSalaryService } from '../services/timesheetSalaryService';
import { invalidateBrigadeOutputs, isOutputModeConflict } from './useTimesheetBrigades';

interface IUseBrigadeObjectOutputsParams {
  departmentId: string;
  month: string;
}

const errorMessage = (error: unknown, fallback: string): string => (
  error instanceof Error && error.message ? error.message : fallback
);

/**
 * Раскрытая бригада во «Бригадах»: объекты месяца, часы и «Выработка» на объектах (без людей и их сумм) и её правка.
 * Ключ начинается с 'timesheet-salary' — после правки его перечитывает invalidateBrigadeOutputs.
 */
export const useBrigadeObjectOutputs = ({ departmentId, month }: IUseBrigadeObjectOutputsParams) => {
  const queryClient = useQueryClient();
  const toast = useToast();

  const query = useQuery({
    queryKey: ['timesheet-salary', 'brigade-objects', departmentId, month],
    queryFn: ({ signal }) => timesheetSalaryService.getBrigadeObjects(departmentId, month, signal),
    staleTime: 30_000,
  });

  const outputMutation = useMutation({
    mutationFn: ({ objectKey, amount }: { objectKey: string; amount: number | null }) => (
      timesheetSalaryService.setObjectOutput(departmentId, month, objectKey, amount)
    ),
    onSuccess: () => invalidateBrigadeOutputs(queryClient),
    onError: error => {
      toast.error(errorMessage(error, 'Не удалось сохранить выработку'));
      if (isOutputModeConflict(error)) void invalidateBrigadeOutputs(queryClient);
    },
  });

  const { mutateAsync } = outputMutation;
  const setObjectOutput = useCallback(async (objectKey: string, amount: number | null) => {
    await mutateAsync({ objectKey, amount });
  }, [mutateAsync]);

  return {
    data: query.data,
    loading: query.isLoading,
    error: query.isError,
    setObjectOutput,
    savingObjectKey: outputMutation.isPending ? (outputMutation.variables?.objectKey ?? null) : null,
  };
};
