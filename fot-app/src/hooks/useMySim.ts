import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { mySimService, type ForwardingType, type IMyForwardingChangeResult } from '../services/mySimService';

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

// Операция переадресации (включение, смена режима, отключение): пока не завершена —
// опрашиваем сервер (МТС подключает услугу и применяет правила за несколько минут).
export const useForwardingOperation = (msisdn: string, enabled = true) => useQuery({
  queryKey: getForwardingOperationKey(msisdn),
  queryFn: () => mySimService.getForwardingOperation(msisdn),
  enabled: enabled && Boolean(msisdn),
  staleTime: 0,
  refetchInterval: query => (query.state.data && !query.state.data.final ? OPERATION_POLL_MS : false),
});

/**
 * Общая обработка ответа изменения: успех — сразу кладём операцию в кэш; при ЛЮБОМ
 * исходе (в т.ч. 422/429/409 прямо в первом запросе, когда прежнее правило уже могло
 * быть снято) перечитываем правила и операцию номера.
 */
const useForwardingChange = <TInput extends { msisdn: string }>(
  mutationFn: (input: TInput) => Promise<IMyForwardingChangeResult>,
) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (result, input) => {
      qc.setQueryData(getForwardingOperationKey(input.msisdn), result.operation);
    },
    onSettled: (_result, _error, input) => {
      void qc.invalidateQueries({ queryKey: ['my-sim', 'forwarding'], exact: true });
      void qc.invalidateQueries({ queryKey: getForwardingOperationKey(input.msisdn) });
    },
  });
};

// applied — режим уже подтверждён; operation_pending — сервер доводит операцию.
export const useSetForwarding = () =>
  useForwardingChange((input: { msisdn: string; type: ForwardingType; target: string; timer?: number }) =>
    mySimService.setForwarding(input));

export const useDeleteForwarding = () =>
  useForwardingChange((input: { msisdn: string; type: ForwardingType }) => mySimService.deleteForwarding(input));
