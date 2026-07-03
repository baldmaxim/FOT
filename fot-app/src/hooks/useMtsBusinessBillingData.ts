import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { mtsBusinessBillingService, type MtsBusinessDailyMetric } from '../services/mtsBusinessBillingService';

export const getMtsBusinessBillingSummaryKey = () => ['mts-business', 'billing', 'summary'] as const;
export const getMtsBusinessBillingTrendKey = (metric: MtsBusinessDailyMetric, from: string, to: string, accountId?: string) =>
  ['mts-business', 'billing', 'trend', metric, from, to, accountId ?? 'all'] as const;

export const useMtsBusinessBillingSummary = () => useQuery({
  queryKey: getMtsBusinessBillingSummaryKey(),
  queryFn: () => mtsBusinessBillingService.getSummary(),
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
      void qc.invalidateQueries({ queryKey: getMtsBusinessBillingSummaryKey() });
      void qc.invalidateQueries({ queryKey: ['mts-business', 'billing', 'trend'] });
    },
  });
};
