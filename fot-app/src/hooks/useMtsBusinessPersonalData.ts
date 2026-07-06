import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { mtsBusinessPersonalDataService, type IMtsPdPerson } from '../services/mtsBusinessPersonalDataService';
import { getMtsBusinessImportedNumbersKey } from './useMtsBusinessData';

// Хуки персональных данных пользователя номера (МТС Бизнес).

export const getMtsBusinessPdInfoKey = (msisdn: string) => ['mts-business', 'personal-data', msisdn] as const;
export const getMtsBusinessPdRequestsKey = () => ['mts-business', 'personal-data-requests'] as const;

export const useMtsBusinessPersonalData = (msisdn: string | null, enabled = true) => useQuery({
  queryKey: getMtsBusinessPdInfoKey(msisdn ?? ''),
  queryFn: () => mtsBusinessPersonalDataService.getInfo(msisdn as string),
  staleTime: 60_000,
  enabled: enabled && Boolean(msisdn),
});

/** Журнал заявок: refetch каждые 15с, пока есть незавершённые (SMS/Госуслуги — асинхронно). */
export const useMtsBusinessPdRequests = (enabled: boolean) => useQuery({
  queryKey: getMtsBusinessPdRequestsKey(),
  queryFn: () => mtsBusinessPersonalDataService.listRequests(),
  staleTime: 10_000,
  refetchInterval: q => (
    (q.state.data ?? []).some(r => r.status === 'in_progress' || r.status === 'unknown') ? 15_000 : false
  ),
  enabled,
});

export const useSubmitMtsBusinessPersonalData = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { msisdn: string; person: IMtsPdPerson }) =>
      mtsBusinessPersonalDataService.submit(args.msisdn, args.person),
    onSuccess: (_r, args) => {
      void qc.invalidateQueries({ queryKey: getMtsBusinessPdRequestsKey() });
      void qc.invalidateQueries({ queryKey: getMtsBusinessPdInfoKey(args.msisdn) });
      void qc.invalidateQueries({ queryKey: getMtsBusinessImportedNumbersKey() });
    },
  });
};

export const useDeleteMtsBusinessPersonalData = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (msisdn: string) => mtsBusinessPersonalDataService.remove(msisdn),
    onSuccess: (_r, msisdn) => {
      void qc.invalidateQueries({ queryKey: getMtsBusinessPdRequestsKey() });
      void qc.invalidateQueries({ queryKey: getMtsBusinessPdInfoKey(msisdn) });
      void qc.invalidateQueries({ queryKey: getMtsBusinessImportedNumbersKey() });
    },
  });
};

export const useRefreshMtsBusinessPdRequestStatus = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (messageId: string) => mtsBusinessPersonalDataService.refreshRequestStatus(messageId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: getMtsBusinessPdRequestsKey() });
    },
  });
};
