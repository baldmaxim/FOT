import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  mtsBusinessRefreshService,
  type IMtsRefreshAllSchedule,
  type IMtsRollingSettings,
} from '../services/mtsBusinessRefreshService';

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

export const getMtsBusinessRefreshAllScheduleKey = () => ['mts-business', 'refresh-all', 'schedule'] as const;

export const useMtsBusinessRefreshAllSchedule = (enabled: boolean) => useQuery({
  queryKey: getMtsBusinessRefreshAllScheduleKey(),
  queryFn: () => mtsBusinessRefreshService.getSchedule(),
  staleTime: 60_000,
  enabled,
});

export const useSetMtsBusinessRefreshAllSchedule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: IMtsRefreshAllSchedule) => mtsBusinessRefreshService.setSchedule(input),
    onSuccess: next => {
      qc.setQueryData(getMtsBusinessRefreshAllScheduleKey(), next);
      void qc.invalidateQueries({ queryKey: getMtsBusinessSchedulersStatusKey() });
    },
  });
};

export const getMtsBusinessRollingKey = () => ['mts-business', 'rolling'] as const;

/** Статус конвейера свежести: пока включён — обновляем раз в 30с (тик воркера). */
export const useMtsBusinessRolling = (enabled: boolean) => useQuery({
  queryKey: getMtsBusinessRollingKey(),
  queryFn: () => mtsBusinessRefreshService.getRolling(),
  refetchInterval: q => (q.state.data?.enabled ? 30_000 : false),
  staleTime: 10_000,
  enabled,
});

export const useSetMtsBusinessRolling = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<IMtsRollingSettings> & { enabled: boolean }) =>
      mtsBusinessRefreshService.setRolling(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: getMtsBusinessRollingKey() });
    },
  });
};
