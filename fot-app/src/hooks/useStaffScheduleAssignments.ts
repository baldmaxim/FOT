import { useCallback } from 'react';
import { useQueries, type UseQueryResult } from '@tanstack/react-query';
import { scheduleService } from '../services/scheduleService';
import type { IEmployeeScheduleAssignment } from '../types/schedule';
import { collectChunkReadiness, type IChunkReadiness } from '../utils/staffInfiniteList';

/** Ключ порции: [..., id порции] — id последним (адресная инвалидация по сотруднику). */
export const STAFF_SCHEDULE_ASSIGNMENTS_QUERY_KEY = ['schedules', 'employee-assignments'] as const;

export interface IStaffScheduleAssignmentsResult extends IChunkReadiness {
  assignments: IEmployeeScheduleAssignment[];
  hasError: boolean;
  retryFailed: () => void;
}

/**
 * Персональные графики — по одному запросу на порцию списка. Готовность по порциям отдельно
 * от наличия графика: сотрудник готовой порции без графика — «—», а не вечная загрузка.
 */
export const useStaffScheduleAssignments = (pageIdChunks: readonly number[][]): IStaffScheduleAssignmentsResult => {
  // combine мемоизируется React Query: пока порции не изменились, склейка не пересчитывается.
  const combine = useCallback((results: Array<UseQueryResult<IEmployeeScheduleAssignment[]>>): IStaffScheduleAssignmentsResult => {
    const assignments: IEmployeeScheduleAssignment[] = [];
    results.forEach(result => {
      if (result.isSuccess && !result.isPlaceholderData && result.data) assignments.push(...result.data);
    });
    const readiness = collectChunkReadiness(results.map((result, index) => ({
      ids: pageIdChunks[index] ?? [],
      data: result.data,
      isSuccess: result.isSuccess,
      isError: result.isError,
      isPlaceholderData: result.isPlaceholderData,
    })));
    return {
      assignments,
      ...readiness,
      hasError: readiness.errorIds.size > 0,
      retryFailed: () => { results.forEach(result => { if (result.isError) void result.refetch(); }); },
    };
  }, [pageIdChunks]);

  return useQueries({
    queries: pageIdChunks.map(ids => ({
      queryKey: [...STAFF_SCHEDULE_ASSIGNMENTS_QUERY_KEY, ids] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) => scheduleService.listEmployeeAssignments(ids, signal),
      staleTime: 60_000,
    })),
    combine,
  });
};
