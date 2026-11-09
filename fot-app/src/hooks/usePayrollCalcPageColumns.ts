import { useMemo } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';

import { payrollService, type IPayrollTermsRow, type PayrollPaidMonths } from '../services/payrollService';
import {
  calcColumnsQueryKey,
  calcPageRequests,
  calcQueryEnabled,
  mergeCalcColumns,
  toCalcQueryState,
  type CalcQueryState,
} from '../utils/payrollCalcPages';

interface ICalcPage {
  rows: readonly IPayrollTermsRow[];
  paidMonths: PayrollPaidMonths | null;
}

/**
 * «Расчёты»: столбцы ФОТ — по каждой порции её же id и месяцами, по одной (payrollCalcPages.ts). Следующая порция
 * ждёт, пока предыдущая завершится; скрытый экран (active: false) не считает. enabled: false — «Условия оплаты».
 */
export const usePayrollCalcPageColumns = (input: {
  pages: readonly ICalcPage[] | undefined;
  rows: readonly IPayrollTermsRow[];
  enabled: boolean;
  active: boolean;
}) => {
  const { pages, rows, enabled, active } = input;
  const queryClient = useQueryClient();
  const calcRequests = useMemo(() => (enabled && pages ? calcPageRequests(pages) : []), [enabled, pages]);
  const cachedCalcStates = calcRequests.map(request => toCalcQueryState(queryClient.getQueryState(calcColumnsQueryKey(request))));
  const calcStates = useQueries({
    queries: calcRequests.map((request, index) => ({
      queryKey: calcColumnsQueryKey(request),
      queryFn: ({ signal }: { signal: AbortSignal }) => payrollService.calcColumns(request.ids, request.months, signal),
      enabled: calcQueryEnabled(index, cachedCalcStates, active),
      staleTime: 30_000,
      // Расчёт тяжёлый: повтор — по кнопке, не сам.
      retry: false,
    })),
    combine: results => results.map((result): CalcQueryState => {
      if (result.isSuccess) return { status: 'success', result: result.data };
      return result.isError ? { status: 'error' } : { status: 'pending' };
    }),
  });
  const calcMerge = useMemo(() => mergeCalcColumns(rows, calcRequests, calcStates), [rows, calcRequests, calcStates]);
  /** «Повторить» — только порции, которые не посчитались. */
  const retryCalc = () => {
    calcRequests.forEach((request, index) => {
      if (calcStates[index]?.status === 'error') {
        void queryClient.refetchQueries({ queryKey: calcColumnsQueryKey(request), exact: true });
      }
    });
  };
  return { calcMerge, retryCalc };
};
