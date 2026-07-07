import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { mtsBusinessBillingService, type MtsBusinessDailyMetric } from '../services/mtsBusinessBillingService';

export const getMtsBusinessBillingSummaryKey = (from?: string, to?: string) =>
  ['mts-business', 'billing', 'summary', from ?? 'default', to ?? 'default'] as const;
export const getMtsBusinessBillingTrendKey = (metric: MtsBusinessDailyMetric, from: string, to: string, accountId?: string) =>
  ['mts-business', 'billing', 'trend', metric, from, to, accountId ?? 'all'] as const;

export const useMtsBusinessBillingSummary = (from?: string, to?: string) => useQuery({
  queryKey: getMtsBusinessBillingSummaryKey(from, to),
  queryFn: () => mtsBusinessBillingService.getSummary(from, to),
  staleTime: 60_000,
});

export const useMtsBusinessBillingTrend = (metric: MtsBusinessDailyMetric, from: string, to: string, accountId?: string) => useQuery({
  queryKey: getMtsBusinessBillingTrendKey(metric, from, to, accountId),
  queryFn: () => mtsBusinessBillingService.getTrend(metric, from, to, accountId),
  staleTime: 60_000,
});

export const useRefreshMtsBusinessBilling = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (accountId?: string) => mtsBusinessBillingService.refresh(accountId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['mts-business', 'billing', 'summary'] });
      void qc.invalidateQueries({ queryKey: ['mts-business', 'billing', 'trend'] });
    },
  });
};
