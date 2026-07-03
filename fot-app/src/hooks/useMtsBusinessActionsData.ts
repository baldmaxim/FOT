import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { mtsBusinessActionsService } from '../services/mtsBusinessActionsService';

export const getMtsBusinessActionsKey = () => ['mts-business', 'actions'] as const;
export const getMtsBusinessBudgetRulesKey = (accountId: string, msisdn: string) =>
  ['mts-business', 'budget', 'rules', accountId, msisdn] as const;
export const getMtsBusinessAvailableRulesKey = (accountId: string, accountNo: string) =>
  ['mts-business', 'budget', 'available-rules', accountId, accountNo] as const;

// Список заявок опрашивается каждые 15с, пока есть «в обработке» — тот же
// паттерн, что useMtsBusinessRequests для детализации.
export const useMtsBusinessActions = (enabled: boolean) => useQuery({
  queryKey: getMtsBusinessActionsKey(),
  queryFn: () => mtsBusinessActionsService.getActions(),
  staleTime: 10_000,
  refetchInterval: (query) => (query.state.data ?? []).some(a => a.status === 'in_progress') ? 15_000 : false,
  enabled,
});

export const useMtsBusinessBudgetRules = (accountId: string, msisdn: string, enabled: boolean) => useQuery({
  queryKey: getMtsBusinessBudgetRulesKey(accountId, msisdn),
  queryFn: () => mtsBusinessActionsService.getRulesByMsisdn(accountId, msisdn),
  enabled: enabled && Boolean(accountId) && Boolean(msisdn),
});

export const useMtsBusinessAvailableRules = (accountId: string, accountNo: string, enabled: boolean) => useQuery({
  queryKey: getMtsBusinessAvailableRulesKey(accountId, accountNo),
  queryFn: () => mtsBusinessActionsService.getAvailableRules(accountId, accountNo),
  enabled: enabled && Boolean(accountId) && Boolean(accountNo),
});

export const useModifyMtsBusinessService = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { accountId: string; msisdn: string; externalID: string; kind: 'service' | 'block'; mode: 'add' | 'remove' }) =>
      mtsBusinessActionsService.modifyService(input),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: getMtsBusinessActionsKey() }); },
  });
};

export const useAddMtsBusinessBudgetRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { accountId: string; msisdn: string; productCode: string; productVersionId: string; limitValue?: string }) =>
      mtsBusinessActionsService.addRule(input),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: getMtsBusinessActionsKey() }); },
  });
};

export const useRemoveMtsBusinessBudgetRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { accountId: string; msisdn: string; productCode: string; productVersionId: string }) =>
      mtsBusinessActionsService.removeRule(input),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: getMtsBusinessActionsKey() }); },
  });
};
