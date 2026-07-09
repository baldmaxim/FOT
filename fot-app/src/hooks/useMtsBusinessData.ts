import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { mtsBusinessService } from '../services/mtsBusinessService';
import { getMtsBusinessSubscribersKey } from './useMtsBusinessSubscribers';

export const getMtsBusinessAccountsKey = () => ['mts-business', 'accounts'] as const;
export const getMtsBusinessRequestsKey = () => ['mts-business', 'requests'] as const;
export const getMtsBusinessNumberMapKey = () => ['mts-business', 'number-map'] as const;
export const getMtsBusinessImportedNumbersKey = () => ['mts-business', 'imported-numbers'] as const;
export const getMtsBusinessReportKey = (from: string, to: string, accountId?: string) =>
  ['mts-business', 'report', from, to, accountId ?? 'all'] as const;
export const getMtsBusinessAccountsSummaryKey = (from: string, to: string, accountId?: string) =>
  ['mts-business', 'accounts-summary', from, to, accountId ?? 'all'] as const;

export const useMtsBusinessAccounts = () => useQuery({
  queryKey: getMtsBusinessAccountsKey(),
  queryFn: () => mtsBusinessService.listAccounts(),
  staleTime: 60_000,
});

export const useMtsBusinessRequests = (enabled: boolean) => useQuery({
  queryKey: getMtsBusinessRequestsKey(),
  queryFn: () => mtsBusinessService.listRequests(),
  staleTime: 15_000,
  enabled,
});

export const useMtsBusinessNumberMap = (enabled: boolean) => useQuery({
  queryKey: getMtsBusinessNumberMapKey(),
  queryFn: () => mtsBusinessService.getNumberMap(),
  staleTime: 60_000,
  enabled,
});

export const useMtsBusinessImportedNumbers = (enabled: boolean) => useQuery({
  queryKey: getMtsBusinessImportedNumbersKey(),
  queryFn: () => mtsBusinessService.getImportedNumbers(),
  staleTime: 30_000,
  enabled,
});

export const useMtsBusinessReport = (from: string, to: string, enabled: boolean, accountId?: string) => useQuery({
  queryKey: getMtsBusinessReportKey(from, to, accountId),
  queryFn: () => mtsBusinessService.getTalkTimeReport(from, to, accountId),
  staleTime: 30_000,
  enabled,
});

export const useMtsBusinessAccountsSummary = (from: string, to: string, enabled: boolean, accountId?: string) => useQuery({
  queryKey: getMtsBusinessAccountsSummaryKey(from, to, accountId),
  queryFn: () => mtsBusinessService.getAccountsSummary(from, to, accountId),
  staleTime: 30_000,
  enabled,
});

export const useCreateMtsBusinessAccount = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { label: string; accountNumber?: string; login: string; password: string; baseUrl?: string; rateLimitPerMin?: number }) =>
      mtsBusinessService.createAccount(data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: getMtsBusinessAccountsKey() }); },
  });
};

export const useUpdateMtsBusinessAccount = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; data: { label?: string; accountNumber?: string | null; login?: string; password?: string; baseUrl?: string | null; isActive?: boolean; rateLimitPerMin?: number } }) =>
      mtsBusinessService.updateAccount(args.id, args.data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: getMtsBusinessAccountsKey() }); },
  });
};

export const useDeleteMtsBusinessAccount = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => mtsBusinessService.deleteAccount(id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: getMtsBusinessAccountsKey() }); },
  });
};

export const useOrderMtsBusinessDetalization = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      accountId: string;
      scope: 'msisdn' | 'account';
      targets: string[];
      dateFrom: string;
      dateTo: string;
      deliveryAddress: string;
    }) => mtsBusinessService.orderDetalization(input),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: getMtsBusinessRequestsKey() }); },
  });
};

export const useFetchSyncMtsBusinessDetalization = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { accountId: string; msisdns: string[]; dateFrom: string; dateTo: string }) =>
      mtsBusinessService.fetchSyncDetalization(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['mts-business', 'report'] });
      void qc.invalidateQueries({ queryKey: ['mts-business', 'accounts-summary'] });
      void qc.invalidateQueries({ queryKey: getMtsBusinessImportedNumbersKey() });
    },
  });
};

export const useRefreshMtsBusinessStatus = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (messageId: string) => mtsBusinessService.refreshStatus(messageId),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: getMtsBusinessRequestsKey() }); },
  });
};

export const useUploadMtsBusinessDetalization = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { file: File; accountId?: string; sourceMessageId?: string; msisdn?: string }) =>
      mtsBusinessService.uploadDetalization(args.file, { accountId: args.accountId, sourceMessageId: args.sourceMessageId, msisdn: args.msisdn }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['mts-business', 'report'] });
      void qc.invalidateQueries({ queryKey: ['mts-business', 'accounts-summary'] });
      void qc.invalidateQueries({ queryKey: getMtsBusinessImportedNumbersKey() });
      void qc.invalidateQueries({ queryKey: getMtsBusinessUploadsCountKey() });
    },
  });
};

export const getMtsBusinessUploadsCountKey = () => ['mts-business', 'uploads-count'] as const;

export const useMtsBusinessUploadsCount = (enabled: boolean) => useQuery({
  queryKey: getMtsBusinessUploadsCountKey(),
  queryFn: () => mtsBusinessService.getUploadsCount(),
  staleTime: 30_000,
  enabled,
});

export const useClearMtsBusinessUploads = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => mtsBusinessService.clearUploads(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: getMtsBusinessUploadsCountKey() });
      void qc.invalidateQueries({ queryKey: ['mts-business', 'report'] });
      void qc.invalidateQueries({ queryKey: ['mts-business', 'accounts-summary'] });
      void qc.invalidateQueries({ queryKey: getMtsBusinessImportedNumbersKey() });
    },
  });
};

export const useSetMtsBusinessNumberMap = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { msisdn: string; employeeId: number | null }) =>
      mtsBusinessService.setNumberMap(data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: getMtsBusinessNumberMapKey() });
      void qc.invalidateQueries({ queryKey: getMtsBusinessImportedNumbersKey() });
      void qc.invalidateQueries({ queryKey: getMtsBusinessSubscribersKey() });
      void qc.invalidateQueries({ queryKey: ['mts-business', 'report'] });
    },
  });
};

export const useAutoLinkMtsBusinessNumberMap = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => mtsBusinessService.autoLinkNumberMap(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: getMtsBusinessNumberMapKey() });
      void qc.invalidateQueries({ queryKey: getMtsBusinessImportedNumbersKey() });
      void qc.invalidateQueries({ queryKey: getMtsBusinessSubscribersKey() });
      void qc.invalidateQueries({ queryKey: ['mts-business', 'report'] });
      void qc.invalidateQueries({ queryKey: ['mts-business', 'billing'] });
    },
  });
};
