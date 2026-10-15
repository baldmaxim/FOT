import { useQuery } from '@tanstack/react-query';

import { payrollService } from '../services/payrollService';

/** Кому доступен раздел «Зарплата» — окно «Справочник» на «Расчётах», только чтение. */
export const usePayrollSectionAccess = () => useQuery({
  queryKey: ['payroll-section-access'],
  queryFn: ({ signal }) => payrollService.listSectionAccess(signal),
  staleTime: 5 * 60_000,
});
