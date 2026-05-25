import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/**
 * Единая точка инвалидации серверных данных по сотруднику после мутации
 * (увольнение, восстановление, отмена увольнения, изменение графика и пр.).
 *
 * Покрывает:
 * - ['employees'] — список (все варианты paginated с любыми фильтрами) + counts.
 * - ['structure'] — дерево отделов сайдбара (staleTime 15 мин не мешает: invalidate
 *   рефетчит активные запросы немедленно).
 * - ['schedules'] — назначения графиков (employee-assignments и пр.).
 * - ['employee', id] — карточка конкретного сотрудника.
 */
export const useInvalidateEmployeeData = () => {
  const qc = useQueryClient();
  return useCallback((employeeId?: number) => {
    void qc.invalidateQueries({ queryKey: ['employees'] });
    void qc.invalidateQueries({ queryKey: ['structure'] });
    void qc.invalidateQueries({ queryKey: ['schedules'] });
    if (employeeId !== undefined) {
      void qc.invalidateQueries({ queryKey: ['employee', employeeId] });
    }
  }, [qc]);
};
