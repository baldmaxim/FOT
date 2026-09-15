import { useCallback, useEffect, useState } from 'react';
import { useQueries, type UseQueryResult } from '@tanstack/react-query';
import { employeeService, type IEmployeeMainObjects } from '../services/employeeService';
import { collectChunkReadiness, type IChunkReadiness } from '../utils/staffInfiniteList';

const DATE_CHECK_MS = 60_000;
/** Снимок пересчитывается ночью — чаще перезапрашивать незачем. */
const STALE_MS = 10 * 60_000;

const moscowDate = (): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());

/** Московская дата, перепроверяемая раз в минуту: после полуночи меняется ключ запроса. */
const useMoscowDate = (): string => {
  const [date, setDate] = useState(moscowDate);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = moscowDate();
      setDate(prev => (prev === next ? prev : next));
    }, DATE_CHECK_MS);
    return () => window.clearInterval(timer);
  }, []);
  return date;
};

/** Ключ порции: [префикс, дата МСК, id порции] — id последним (адресная инвалидация по сотруднику). */
export const STAFF_MAIN_OBJECTS_QUERY_KEY = 'employee-main-objects';

export interface IStaffMainObjectsResult extends IChunkReadiness {
  objects: Record<string, string>;
  costItems: Record<string, string>;
  period: { start: string; end: string } | undefined;
  hasError: boolean;
  retryFailed: () => void;
}

/**
 * «Объект» и «Статья затрат» — по одному запросу на порцию списка (≤ 500 id), из ночного
 * снимка сервера. Загруженные порции берутся из кэша, новая порция — один запрос.
 * Без placeholderData: данные прежнего ключа относились бы к другим сотрудникам.
 */
export const useStaffMainObjects = (pageIdChunks: readonly number[][]): IStaffMainObjectsResult => {
  const mskDate = useMoscowDate();

  // combine мемоизируется React Query: пока порции не изменились, склейка не пересчитывается.
  const combine = useCallback((results: Array<UseQueryResult<IEmployeeMainObjects>>): IStaffMainObjectsResult => {
    const objects: Record<string, string> = {};
    const costItems: Record<string, string> = {};
    let period: { start: string; end: string } | undefined;
    results.forEach(result => {
      if (!result.isSuccess || result.isPlaceholderData || !result.data) return;
      Object.assign(objects, result.data.objects);
      Object.assign(costItems, result.data.cost_items);
      period ??= result.data.period;
    });
    const readiness = collectChunkReadiness(results.map((result, index) => ({
      ids: pageIdChunks[index] ?? [],
      data: result.data,
      isSuccess: result.isSuccess,
      isError: result.isError,
      isPlaceholderData: result.isPlaceholderData,
    })));
    return {
      objects,
      costItems,
      period,
      ...readiness,
      hasError: readiness.errorIds.size > 0,
      retryFailed: () => { results.forEach(result => { if (result.isError) void result.refetch(); }); },
    };
  }, [pageIdChunks]);

  return useQueries({
    queries: pageIdChunks.map(ids => ({
      queryKey: [STAFF_MAIN_OBJECTS_QUERY_KEY, mskDate, ids] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) => employeeService.getMainObjects(ids, signal),
      staleTime: STALE_MS,
      refetchOnWindowFocus: true,
    })),
    combine,
  });
};
