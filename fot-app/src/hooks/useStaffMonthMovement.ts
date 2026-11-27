import { useQuery } from '@tanstack/react-query';
import { employeeService, type StaffCategory } from '../services/employeeService';

export const STAFF_MONTH_MOVEMENT_QUERY_KEY = ['employees', 'month-movement'] as const;

interface IUseStaffMonthMovementParams {
  section: string;
  departmentId: string;
  search: string;
  scheduleId: string;
  /** Сериализованные фильтры столбцов ('' — нет). */
  cf: string;
  /** Группа плашки (null — все): чип ведёт в таблицу с той же группой. */
  category: StaffCategory | null;
  enabled: boolean;
}

/**
 * «Устроены / Уволены с 1-го числа» по фильтрам экрана. Статус и период в ключ не входят:
 * счётчики не зависят от вкладки. Префикс ['employees'] — обновляются вместе со списком
 * после приёма, увольнения и восстановления.
 */
export const useStaffMonthMovement = ({ section, departmentId, search, scheduleId, cf, category, enabled }: IUseStaffMonthMovementParams) =>
  useQuery({
    queryKey: [...STAFF_MONTH_MOVEMENT_QUERY_KEY, section, departmentId || null, search || '', scheduleId || null, cf || '', category],
    queryFn: ({ signal }) => employeeService.getMonthMovement({
      section,
      departmentId: departmentId || undefined,
      search: search || undefined,
      scheduleId: scheduleId || undefined,
      cf: cf || undefined,
      category: category ?? undefined,
    }, signal),
    staleTime: 60_000,
    enabled,
  });
