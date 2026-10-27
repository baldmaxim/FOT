import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useToast } from '../contexts/ToastContext';
import { timesheetSalaryService } from '../services/timesheetSalaryService';

interface IUseTimesheetSalaryParams {
  departmentId: string | null;
  month: string;
  enabled: boolean;
}

const errorMessage = (error: unknown, fallback: string): string => (
  error instanceof Error && error.message ? error.message : fallback
);

/** «Табель → Зарплата»: суммы отдела или бригады и правка КТУ / «Выработки». */
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
    mutationFn: (amount: number | null) => timesheetSalaryService.setOutput(departmentId as string, month, amount),
    onSuccess: invalidate,
    onError: error => toast.error(errorMessage(error, 'Не удалось сохранить выработку')),
  });

  const { mutate: mutateKtu } = ktuMutation;
  const { mutateAsync: mutateOutput } = outputMutation;
  const setKtu = useCallback((employeeId: number, ktu: number) => mutateKtu({ employeeId, ktu }), [mutateKtu]);
  const setOutput = useCallback(async (amount: number | null) => { await mutateOutput(amount); }, [mutateOutput]);

  return {
    data: query.data,
    loading: query.isLoading,
    error: query.isError,
    setKtu,
    setOutput,
    pendingKtuEmployeeId: ktuMutation.isPending ? (ktuMutation.variables?.employeeId ?? null) : null,
    savingOutput: outputMutation.isPending,
  };
};

export type TimesheetSalaryController = ReturnType<typeof useTimesheetSalary>;
