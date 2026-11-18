import { queryOptions } from '@tanstack/react-query';

import { payrollService } from '../services/payrollService';

/**
 * Действующие плановые доплаты сотрудника (миграция 369): список в окне сотрудника, в «Подробно» и в экспорте карточки.
 * Префикс 'payroll-terms' (PAYROLL_TERMS_PREFIX): правка доплат в «Справочнике» его сбрасывает — открытый список
 * перечитывается. staleTime 0 — при открытии карточки всегда свежий.
 */
export const employeePlannedSupplementsQueryOptions = (employeeId: number) => queryOptions({
  queryKey: ['payroll-terms', 'planned-supplements', employeeId],
  queryFn: ({ signal }) => payrollService.getEmployeePlannedSupplements(employeeId, signal),
  staleTime: 0,
});
