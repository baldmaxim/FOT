import { useState } from 'react';
import { useQueries } from '@tanstack/react-query';

import { payrollService, type PayrollCalc } from '../services/payrollService';

export type PayrollCalcStatus = 'loading' | 'error' | 'ready';

/**
 * «К выплате (ФОТ)» в «Подробно» за выбранные месяцы: расчёт по закрытому табелю приходит в листке месяца
 * (тот же ключ, что у листка «Истории выплат», — кэш общий, сохранение карточки перечитывает по префиксу
 * 'payroll-terms'). Нет поля calc — старый бэкенд: месяц как незагруженный. По умолчанию свёрнуто.
 */
export const usePayrollCalc = (employeeId: number, months: string[], enabled = true) => {
  const queries = useQueries({
    queries: months.map(month => ({
      queryKey: ['payroll-terms', 'payslip', employeeId, month],
      queryFn: ({ signal }: { signal: AbortSignal }) => payrollService.getPayslip(employeeId, month, signal),
      staleTime: 30_000,
      enabled,
    })),
  });
  const [expanded, setExpanded] = useState(false);

  const calcs = new Map<string, PayrollCalc | undefined>(months.map((month, index) => [month, queries[index]?.data?.calc]));
  const status: PayrollCalcStatus = queries.some(query => query.isError)
    ? 'error'
    : queries.every(query => query.data) ? 'ready' : 'loading';

  return {
    months,
    calcs,
    status,
    expanded,
    toggleExpanded: () => setExpanded(prev => !prev),
  };
};

export type PayrollCalcApi = ReturnType<typeof usePayrollCalc>;
