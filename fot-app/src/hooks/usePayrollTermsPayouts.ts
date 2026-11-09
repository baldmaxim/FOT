import { useMemo } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';

import { payrollService, type IPayrollTermsRow } from '../services/payrollService';
import {
  mergeTermsPayouts,
  termsPayoutsQueryEnabled,
  termsPayoutsQueryKey,
  termsPayoutsRequests,
  toTermsPayoutsState,
  type TermsPayoutsState,
} from '../utils/payrollTermsPayouts';

interface IPayoutsPage {
  rows: readonly IPayrollTermsRow[];
  date: string;
}

const NO_PAGES: readonly IPayoutsPage[] = [];

/**
 * «Условия оплаты»: «Выплачено» — по каждой порции её же id и датой, по одной (payrollTermsPayouts.ts). Следующая порция
 * ждёт, пока предыдущая завершится; скрытый экран (active: false) не считает. enabled: false — «Расчёты» или столбец
 * скрыт шестерёнкой: строки как есть, с суммами 1С списка. Сбой порции на экране не показывается (решение пользователя
 * 09.11.2026): остаются суммы 1С, пересчёт — при следующем открытии вкладки или обновлении страницы.
 */
export const usePayrollTermsPayouts = (input: {
  pages: readonly IPayoutsPage[] | undefined;
  rows: readonly IPayrollTermsRow[];
  enabled: boolean;
  active: boolean;
}) => {
  const { pages, rows, enabled, active } = input;
  const queryClient = useQueryClient();
  const requests = useMemo(() => termsPayoutsRequests(enabled ? pages ?? NO_PAGES : NO_PAGES), [enabled, pages]);
  const cachedStates = requests.map(request => toTermsPayoutsState(queryClient.getQueryState(termsPayoutsQueryKey(request))));
  const states = useQueries({
    queries: requests.map((request, index) => ({
      queryKey: termsPayoutsQueryKey(request),
      queryFn: ({ signal }: { signal: AbortSignal }) => payrollService.termsPayouts(request.ids, request.date, signal),
      enabled: termsPayoutsQueryEnabled(index, cachedStates, active),
      staleTime: 30_000,
      // Расчёт тяжёлый: повтор — по кнопке, не сам.
      retry: false,
    })),
    combine: results => results.map((result): TermsPayoutsState => {
      if (result.isSuccess) return { status: 'success', result: result.data };
      return result.isError ? { status: 'error' } : { status: 'pending' };
    }),
  });
  const payoutsMerge = useMemo(() => mergeTermsPayouts(rows, requests, states), [rows, requests, states]);
  return { payoutsMerge };
};
