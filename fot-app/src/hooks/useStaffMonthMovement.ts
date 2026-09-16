import { useQuery } from '@tanstack/react-query';
import { employeeService } from '../services/employeeService';

export const STAFF_MONTH_MOVEMENT_QUERY_KEY = ['employees', 'month-movement'] as const;

interface IUseStaffMonthMovementParams {
  section: string;
  departmentId: string;
  search: string;
  scheduleId: string;
  /** Сериализованные фильтры столбцов ('' — нет). */
  cf: string;
  enabled: boolean;
}

/**
 * «Устроены / Уволены с 1-го числа» по фильтрам экрана. Статус и период в ключ не входят:
 * счётчики не зависят от вкладки. Префикс ['employees'] — обновляются вместе со списком
 * после приёма, увольнения и восстановления.
 */
export const useStaffMonthMovement = ({ section, departmentId, search, scheduleId, cf, enabled }: IUseStaffMonthMovementParams) =>
  useQuery({
    queryKey: [...STAFF_MONTH_MOVEMENT_QUERY_KEY, section, departmentId || null, search || '', scheduleId || null, cf || ''],
    queryFn: ({ signal }) => employeeService.getMonthMovement({
      section,
      departmentId: departmentId || undefined,
      search: search || undefined,
      scheduleId: scheduleId || undefined,
      cf: cf || undefined,
    }, signal),
    staleTime: 60_000,
    enabled,
  });
