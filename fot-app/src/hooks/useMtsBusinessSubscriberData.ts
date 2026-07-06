import { useQuery } from '@tanstack/react-query';
import { mtsBusinessSubscriberService } from '../services/mtsBusinessSubscriberService';

// Данные карточки номера — запрашиваются только при открытой модалке (enabled).

export const getMtsBusinessSubscriberCardKey = (msisdn: string | null) =>
  ['mts-business', 'subscriber', msisdn, 'card'] as const;
export const getMtsBusinessSubscriberExpensesKey = (msisdn: string | null, month: string) =>
  ['mts-business', 'subscriber', msisdn, 'expenses', month] as const;

export const useMtsBusinessSubscriberCard = (msisdn: string | null) => useQuery({
  queryKey: getMtsBusinessSubscriberCardKey(msisdn),
  queryFn: () => mtsBusinessSubscriberService.getCard(msisdn as string),
  enabled: Boolean(msisdn),
  staleTime: 60_000,
});

export const useMtsBusinessSubscriberExpenses = (msisdn: string | null, month: string, enabled: boolean) => useQuery({
  queryKey: getMtsBusinessSubscriberExpensesKey(msisdn, month),
  queryFn: () => mtsBusinessSubscriberService.getExpenses(msisdn as string, month),
  enabled: Boolean(msisdn) && enabled,
  staleTime: 5 * 60_000,
});
