import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { timesheetApprovalService } from '../services/timesheetApprovalService';
import { runTimesheetMonthClose, type IMonthCloseRunResult } from '../utils/timesheetMonthClose';

interface IMonthCloseProgress {
  done: number;
  total: number;
}

/**
 * Закрытие табелей отделов за месяц после выгрузки «Единый файл для 1С»:
 * прогресс по отделам и итог запуска (кого закрыть не удалось и почему).
 */
export const useTimesheetMonthClose = () => {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<IMonthCloseProgress | null>(null);
  const [outcome, setOutcome] = useState<IMonthCloseRunResult | null>(null);

  const run = useCallback(async (
    month: string,
    departmentIds: readonly string[],
    nameById: ReadonlyMap<string, string>,
  ): Promise<IMonthCloseRunResult> => {
    setOutcome(null);
    setProgress({ done: 0, total: departmentIds.length });
    try {
      const result = await runTimesheetMonthClose({
        month,
        departmentIds,
        nameById,
        closeChunk: timesheetApprovalService.closeMonth,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setOutcome(result);
      return result;
    } finally {
      setProgress(null);
      // И при сбое посреди набора: часть табелей уже могла закрыться.
      void queryClient.invalidateQueries({ queryKey: ['timesheet-approval'] });
      void queryClient.invalidateQueries({ queryKey: ['timesheet-1c-status'] });
    }
  }, [queryClient]);

  const dismissOutcome = useCallback(() => setOutcome(null), []);

  return { progress, outcome, run, dismissOutcome };
};
