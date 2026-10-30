import { useQuery } from '@tanstack/react-query';

import { PAYROLL_REGISTRY_KEYS, payrollRegistryService } from '../services/payrollRegistryService';

/** Основания разовой доплаты (миграция 340) — выпадающий список «Основание» и окно «Основания доплаты». */
export const useSupplementReasons = () => useQuery({
  queryKey: PAYROLL_REGISTRY_KEYS.supplementReasons,
  queryFn: ({ signal }) => payrollRegistryService.listSupplementReasons(signal),
  staleTime: 5 * 60_000,
});
