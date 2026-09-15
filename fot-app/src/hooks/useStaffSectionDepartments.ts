import { useQuery } from '@tanstack/react-query';
import { employeeService, type IStaffSectionDepartments } from '../services/employeeService';

/** Структура меняется редко — раз в 5 минут достаточно. */
const STALE_MS = 5 * 60_000;

/** id отделов каждого раздела для каскада «Раздел → Отделы» в шапке «Текущих сотрудников». */
export const useStaffSectionDepartments = () => useQuery<IStaffSectionDepartments>({
  queryKey: ['staff-section-departments'],
  queryFn: () => employeeService.getSectionDepartments(),
  staleTime: STALE_MS,
});
