import { useQuery } from '@tanstack/react-query';

import { payrollService } from '../services/payrollService';

export const PAYROLL_RATES_KEY = ['payroll-rates'] as const;

/** Справочник ставок — окно «Справочник» на «Расчётах». */
export const usePayrollRates = () => useQuery({
  queryKey: PAYROLL_RATES_KEY,
  queryFn: ({ signal }) => payrollService.listRates(signal),
  staleTime: 5 * 60_000,
});
