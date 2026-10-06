import { useQuery } from '@tanstack/react-query';

import { payrollService } from '../services/payrollService';

/** Ключ справочника: добавление вида сбрасывает его — новый вид сразу и в «Расчётах», и в карточке. */
export const PAYROLL_DEDUCTION_KINDS_KEY = ['payroll-deduction-kinds'] as const;

/** Справочник видов удержаний — столбцы «Расчётов» и список «Вид» в «Удержании» карточки. */
export const usePayrollDeductionKinds = () => useQuery({
  queryKey: PAYROLL_DEDUCTION_KINDS_KEY,
  queryFn: ({ signal }) => payrollService.listDeductionKinds(signal),
  staleTime: 5 * 60_000,
});
