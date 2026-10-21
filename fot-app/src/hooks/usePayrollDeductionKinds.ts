import { useQuery } from '@tanstack/react-query';

import { payrollService } from '../services/payrollService';

/** Ключ справочника «Зарплаты»: правка вида или подвида (и у кадров) сбрасывает его — invalidateDeductionQueries. */
export const PAYROLL_DEDUCTION_KINDS_KEY = ['payroll-deduction-kinds'] as const;

/** Справочник видов удержаний с подвидами — «Справочник» → «Удержания» и окно удержания в его таблице. */
export const usePayrollDeductionKinds = () => useQuery({
  queryKey: PAYROLL_DEDUCTION_KINDS_KEY,
  queryFn: ({ signal }) => payrollService.listDeductionKinds(signal),
  staleTime: 5 * 60_000,
});
