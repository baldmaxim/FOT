import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useToast } from '../contexts/ToastContext';
import { timesheetSalaryService } from '../services/timesheetSalaryService';
import { invalidateBrigadeOutputs, isOutputModeConflict } from './useTimesheetBrigades';

interface IUseTimesheetSalaryParams {
  departmentId: string | null;
  month: string;
  enabled: boolean;
}

const errorMessage = (error: unknown, fallback: string): string => (
  error instanceof Error && error.message ? error.message : fallback
);

/** «Табель → Зарплата»: суммы отдела или бригады и правка КТУ / «Выработки» на объектах / «Доли» (355). */
export const useTimesheetSalary = ({ departmentId, month, enabled }: IUseTimesheetSalaryParams) => {
  const queryClient = useQueryClient();
  const toast = useToast();
  const queryKey = ['timesheet-salary', departmentId ?? 'none', month];

  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => timesheetSalaryService.get(departmentId as string, month, signal),
    enabled: enabled && Boolean(departmentId),
    staleTime: 30_000,
    placeholderData: previous => (previous?.department_id === departmentId && previous?.month === month ? previous : undefined),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['timesheet-salary', departmentId ?? 'none', month] });

  const ktuMutation = useMutation({
    mutationFn: ({ employeeId, ktu }: { employeeId: number; ktu: number }) => (
      timesheetSalaryService.setKtu(departmentId as string, month, employeeId, ktu)
    ),
    onSuccess: invalidate,
    onError: error => toast.error(errorMessage(error, 'Не удалось сохранить КТУ')),
  });

  const outputMutation = useMutation({
    mutationFn: ({ objectKey, amount }: { objectKey: string; amount: number | null }) => (
      timesheetSalaryService.setObjectOutput(departmentId as string, month, objectKey, amount)
    ),
    // Выработка видна и в списке «Бригады» — перечитать и его.
    onSuccess: () => invalidateBrigadeOutputs(queryClient),
    onError: error => {
      toast.error(errorMessage(error, 'Не удалось сохранить выработку'));
      if (isOutputModeConflict(error)) void invalidateBrigadeOutputs(queryClient);
    },
  });

  const shareMutation = useMutation({
    mutationFn: ({ objectKey, employeeId, amount }: { objectKey: string; employeeId: number; amount: number | null }) => (
      timesheetSalaryService.setShare(departmentId as string, month, objectKey, employeeId, amount)
    ),
    onSuccess: invalidate,
    // Текст сервера: «Амонов А. М.: максимум — 196 428,57 (КТУ 2,2)».
    onError: error => toast.error(errorMessage(error, 'Не удалось сохранить долю')),
  });

  const { mutate: mutateKtu } = ktuMutation;
  const { mutateAsync: mutateOutput } = outputMutation;
  const { mutateAsync: mutateShare } = shareMutation;
  const setKtu = useCallback((employeeId: number, ktu: number) => mutateKtu({ employeeId, ktu }), [mutateKtu]);
  const setObjectOutput = useCallback(async (objectKey: string, amount: number | null) => {
    await mutateOutput({ objectKey, amount });
  }, [mutateOutput]);
  const setShare = useCallback(async (objectKey: string, employeeId: number, amount: number | null) => {
    await mutateShare({ objectKey, employeeId, amount });
  }, [mutateShare]);

  return {
    data: query.data,
    loading: query.isLoading,
    error: query.isError,
    setKtu,
    setObjectOutput,
    setShare,
    pendingKtuEmployeeId: ktuMutation.isPending ? (ktuMutation.variables?.employeeId ?? null) : null,
    savingObjectKey: outputMutation.isPending ? (outputMutation.variables?.objectKey ?? null) : null,
    savingShareKey: shareMutation.isPending && shareMutation.variables
      ? `${shareMutation.variables.objectKey}:${shareMutation.variables.employeeId}`
      : null,
  };
};

export type TimesheetSalaryController = ReturnType<typeof useTimesheetSalary>;
