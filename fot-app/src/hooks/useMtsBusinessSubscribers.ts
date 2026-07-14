import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { mtsBusinessSubscribersService } from '../services/mtsBusinessSubscribersService';
import type { MtsForwardingType } from '../services/mtsBusinessSubscriberService';

// Хуки вкладки «Абоненты МТС».

export const getMtsBusinessSubscribersKey = () => ['mts-business', 'subscribers'] as const;
export const getMtsBusinessSubscriberDetailsKey = (msisdn: string) =>
  ['mts-business', 'subscriber-details', msisdn] as const;
export const getMtsBusinessSubscriberAvailableKey = (msisdn: string) =>
  ['mts-business', 'subscriber-available', msisdn] as const;

export const useMtsBusinessSubscribers = (enabled = true) => useQuery({
  queryKey: getMtsBusinessSubscribersKey(),
  queryFn: () => mtsBusinessSubscribersService.list(),
  staleTime: 30_000,
  enabled,
});

export const useMtsBusinessSubscriberDetails = (msisdn: string | null) => useQuery({
  queryKey: getMtsBusinessSubscriberDetailsKey(msisdn ?? ''),
  queryFn: () => mtsBusinessSubscribersService.details(msisdn as string),
  staleTime: 30_000,
  enabled: Boolean(msisdn),
});

/** Живой каталог подключаемого (3 вызова МТС) — грузится по явному запросу из панели. */
export const useMtsBusinessSubscriberAvailable = (msisdn: string | null, enabled: boolean) => useQuery({
  queryKey: getMtsBusinessSubscriberAvailableKey(msisdn ?? ''),
  queryFn: () => mtsBusinessSubscribersService.available(msisdn as string),
  staleTime: 5 * 60_000,
  enabled: enabled && Boolean(msisdn),
});

/** Детальная выписка за месяц или день (живой вызов МТС) — грузится при открытии вкладки «Использование». */
export const useMtsBusinessSubscriberUsage = (msisdn: string | null, month: string, date: string, enabled: boolean) => useQuery({
  queryKey: ['mts-business', 'subscriber-usage', msisdn ?? '', month, date] as const,
  queryFn: () => mtsBusinessSubscribersService.usage(msisdn as string, month, date || undefined),
  staleTime: 5 * 60_000,
  enabled: enabled && Boolean(msisdn),
});

export const useRefreshMtsBusinessSubscriber = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (msisdn: string) => mtsBusinessSubscribersService.refreshOne(msisdn),
    onSuccess: (_r, msisdn) => {
      void qc.invalidateQueries({ queryKey: getMtsBusinessSubscribersKey() });
      void qc.invalidateQueries({ queryKey: getMtsBusinessSubscriberDetailsKey(msisdn) });
      void qc.invalidateQueries({ queryKey: ['mts-business', 'personal-data', msisdn] });
    },
  });
};

export const useChangeMtsBusinessTariff = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { accountId?: string; msisdn: string; externalID: string }) =>
      mtsBusinessSubscribersService.changeTariff(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['mts-business', 'actions'] });
    },
  });
};

/**
 * Переадресация за абонента. Заявка асинхронная: правила в details обновятся не
 * сразу, а когда статус-поллер бэкенда увидит completed и перечитает снапшот —
 * поэтому инвалидируем журнал заявок, а details дровер перезапросит по completed.
 */
export const useSetMtsBusinessForwarding = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { accountId?: string; msisdn: string; type: MtsForwardingType; target: string; timer?: number }) =>
      mtsBusinessSubscribersService.setForwarding(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['mts-business', 'actions'] });
    },
  });
};

export const useDeleteMtsBusinessForwarding = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { accountId?: string; msisdn: string; type: MtsForwardingType }) =>
      mtsBusinessSubscribersService.deleteForwarding(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['mts-business', 'actions'] });
    },
  });
};
