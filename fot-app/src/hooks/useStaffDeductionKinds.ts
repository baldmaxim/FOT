import { useQuery } from '@tanstack/react-query';

import { STAFF_DEDUCTION_KINDS_KEY, staffDeductionService } from '../services/staffDeductionService';

/** Виды удержаний с суммой по умолчанию — вкладка «Удержания» кадров: список вида в окне и окно «Виды удержаний». */
export const useStaffDeductionKinds = () => useQuery({
  queryKey: STAFF_DEDUCTION_KINDS_KEY,
  queryFn: ({ signal }) => staffDeductionService.listKinds(signal),
  // Справочник общий с «Зарплатой»: вид могли добавить там — при открытии вкладки перечитываем.
  staleTime: 0,
});
