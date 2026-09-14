import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { mySimService, type ForwardingType } from '../services/mySimService';

// Хуки ЛК сотрудника: «Моя SIM» и «Телефонная книга». Данные из БД (обновляются
// ночным прогоном МТС) — длинные staleTime уместны.

export const useMySimNumbers = (enabled = true) => useQuery({
  queryKey: ['my-sim', 'numbers'] as const,
  queryFn: () => mySimService.getNumbers(),
  staleTime: 10 * 60_000,
  enabled,
});

export const useMySim = () => useQuery({
  queryKey: ['my-sim', 'summary'] as const,
  queryFn: () => mySimService.getMySim(),
  staleTime: 5 * 60_000,
});

export const useMySimUsage = (month: string, date: string, enabled = true) => useQuery({
  queryKey: ['my-sim', 'usage', month, date] as const,
  queryFn: () => mySimService.getUsage(month, date || undefined),
  staleTime: 5 * 60_000,
  enabled: enabled && Boolean(month),
});

export const usePhonebook = () => useQuery({
  queryKey: ['phonebook'] as const,
  queryFn: () => mySimService.getPhonebook(),
  staleTime: 10 * 60_000,
});

// Переадресация: правило показываем из снапшота, после применения заявки
// (статус completed) поллер обновит снапшот — инвалидируем кэш.
export const useMyForwarding = (enabled = true) => useQuery({
  queryKey: ['my-sim', 'forwarding'] as const,
  queryFn: () => mySimService.getForwarding(),
  staleTime: 60_000,
  enabled,
});

export const getForwardingOperationKey = (msisdn: string) => ['my-sim', 'forwarding-operation', msisdn] as const;

const OPERATION_POLL_MS = 15_000;

// Операция включения переадресации: пока не завершена — опрашиваем сервер
// (МТС подключает услугу и применяет правило за несколько минут).
export const useForwardingOperation = (msisdn: string, enabled = true) => useQuery({
  queryKey: getForwardingOperationKey(msisdn),
  queryFn: () => mySimService.getForwardingOperation(msisdn),
  enabled: enabled && Boolean(msisdn),
  staleTime: 0,
  refetchInterval: query => (query.state.data && !query.state.data.final ? OPERATION_POLL_MS : false),
});

// Включение возвращает IMyForwardingSetResult: applied — включено сразу,
// operation_pending — сервер доводит операцию (модалка следит за её статусом).
export const useSetForwarding = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { msisdn: string; type: ForwardingType; target: string; timer?: number }) =>
      mySimService.setForwarding(input),
    onSuccess: (result, input) => {
      qc.setQueryData(getForwardingOperationKey(input.msisdn), result.operation);
      void qc.invalidateQueries({ queryKey: ['my-sim', 'forwarding'], exact: true });
    },
    onError: (_error, input) => {
      void qc.invalidateQueries({ queryKey: getForwardingOperationKey(input.msisdn) });
    },
  });
};

export const useDeleteForwarding = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { msisdn: string; type: ForwardingType }) => mySimService.deleteForwarding(input),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['my-sim', 'forwarding'] }); },
  });
};
