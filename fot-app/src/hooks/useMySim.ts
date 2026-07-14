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

export const useSetForwarding = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { msisdn: string; type: ForwardingType; target: string; timer?: number }) =>
      mySimService.setForwarding(input),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['my-sim', 'forwarding'] }); },
  });
};

export const useDeleteForwarding = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { msisdn: string; type: ForwardingType }) => mySimService.deleteForwarding(input),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['my-sim', 'forwarding'] }); },
  });
};
