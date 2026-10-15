import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { timesheetViewAccessService, type ITimesheetViewAssignment } from '../services/timesheetViewAccessService';

interface IUseTimesheetViewEmployeesDraftArgs {
  employeeId: number | null;
  /** Панель открыта и вкладка «Просмотр табеля» доступна: иначе запрос не шлём. */
  enabled: boolean;
}

export interface ITimesheetViewEmployeesDraft {
  /** Отмеченные сейчас (черновик или сохранённые). */
  ids: number[];
  /** Сохранённые назначения с ФИО — в том числе уволенные, которых нет в общем списке панели. */
  assigned: ITimesheetViewAssignment[];
  toggle: (employeeId: number) => void;
  /** Черновик отличается от сохранённого. Пока список не загружен, всегда false. */
  hasChanges: boolean;
  isLoading: boolean;
  isError: boolean;
  reset: () => void;
  /** PUT только при изменении; после — ждём рефетч, чтобы hasChanges обнулился. */
  save: () => Promise<void>;
}

const sameIds = (left: readonly number[], right: readonly number[]): boolean => {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  return right.every(id => set.has(id));
};

/**
 * Черновик вкладки «Просмотр табеля» в панели назначений (миграция 309): выбор хранится
 * вместе с сотрудником, для которого сделан, и пока
 * список не загрузился (или загрузка упала), изменений нет — общий «Сохранить» панели не
 * затрёт неизвестный список пустым.
 */
export const useTimesheetViewEmployeesDraft = ({
  employeeId,
  enabled,
}: IUseTimesheetViewEmployeesDraftArgs): ITimesheetViewEmployeesDraft => {
  const queryClient = useQueryClient();
  const query = useQuery<ITimesheetViewAssignment[]>({
    queryKey: ['admin-timesheet-view-employees', employeeId ?? 0],
    queryFn: () => timesheetViewAccessService.list(employeeId as number),
    enabled: enabled && employeeId != null,
    staleTime: 30_000,
  });

  const isReady = query.isSuccess;
  const assigned = useMemo(() => query.data ?? [], [query.data]);
  const initialIds = useMemo(() => assigned.map(row => row.employee_id), [assigned]);
  const [edit, setEdit] = useState<{ employeeId: number | null; ids: number[] } | null>(null);

  const ids = edit && edit.employeeId === employeeId ? edit.ids : initialIds;
  const hasChanges = isReady && !sameIds(ids, initialIds);

  const toggle = useCallback((targetId: number) => {
    setEdit(prev => {
      const base = prev && prev.employeeId === employeeId ? prev.ids : initialIds;
      const next = base.includes(targetId) ? base.filter(id => id !== targetId) : [...base, targetId];
      return { employeeId, ids: next };
    });
  }, [employeeId, initialIds]);

  const reset = useCallback(() => setEdit(null), []);

  const save = useCallback(async () => {
    if (!hasChanges || employeeId == null) return;
    await timesheetViewAccessService.replace(employeeId, ids);
    await queryClient.invalidateQueries({ queryKey: ['admin-timesheet-view-employees', employeeId] });
    setEdit(null);
  }, [hasChanges, employeeId, ids, queryClient]);

  return {
    ids,
    assigned,
    toggle,
    hasChanges,
    isLoading: query.isLoading,
    isError: query.isError,
    reset,
    save,
  };
};
