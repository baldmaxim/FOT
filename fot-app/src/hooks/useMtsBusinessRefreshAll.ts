import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { mtsBusinessRefreshService } from '../services/mtsBusinessRefreshService';

// Хуки «Обновить всё»: запуск фонового прогона, polling статуса (3с пока
// running; возврат на страницу подхватывает идущий прогон), детект завершения
// с одной инвалидацией всех mts-business запросов + статусы планировщиков.

export const getMtsBusinessRefreshAllStatusKey = () => ['mts-business', 'refresh-all', 'status'] as const;
export const getMtsBusinessSchedulersStatusKey = () => ['mts-business', 'schedulers-status'] as const;

export const useMtsBusinessRefreshAllStatus = () => useQuery({
  queryKey: getMtsBusinessRefreshAllStatusKey(),
  queryFn: () => mtsBusinessRefreshService.getStatus(),
  refetchInterval: q => (q.state.data?.running ? 3_000 : false),
  refetchOnMount: 'always',
  staleTime: 0,
});

export const useStartMtsBusinessRefreshAll = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { accountId?: string; dateFrom?: string; dateTo?: string } = {}) =>
      mtsBusinessRefreshService.startRefreshAll(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: getMtsBusinessRefreshAllStatusKey() });
    },
  });
};

/**
 * Детект завершения прогона (running: true → false) — одна инвалидация всех
 * запросов модуля разом (отчёты, балансы, номера, каталог, карточки), кроме
 * самого статуса refresh-all. Refetch произойдёт только для активных запросов.
 */
export const useMtsBusinessRefreshAllCompletion = (running: boolean | undefined): void => {
  const qc = useQueryClient();
  const prev = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    if (prev.current === true && running === false) {
      void qc.invalidateQueries({
        predicate: q => q.queryKey[0] === 'mts-business' && q.queryKey[1] !== 'refresh-all',
      });
    }
    prev.current = running;
  }, [running, qc]);
};

export const useMtsBusinessSchedulersStatus = (enabled: boolean) => useQuery({
  queryKey: getMtsBusinessSchedulersStatusKey(),
  queryFn: () => mtsBusinessRefreshService.getSchedulersStatus(),
  staleTime: 60_000,
  enabled,
});
