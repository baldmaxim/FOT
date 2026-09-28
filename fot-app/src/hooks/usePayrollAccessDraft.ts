import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { payrollAccessService, type PayrollAccessLevel } from '../services/payrollAccessService';

interface IUsePayrollAccessDraftArgs {
  employeeId: number | null;
  /** Панель открыта и вкладка «Зарплата» доступна: иначе запрос не шлём (он только для системного админа). */
  enabled: boolean;
}

export interface IPayrollAccessDraft {
  level: PayrollAccessLevel;
  setLevel: (level: PayrollAccessLevel) => void;
  /** Черновик отличается от сохранённого. Пока уровень не загружен, всегда false. */
  hasChanges: boolean;
  isLoading: boolean;
  isError: boolean;
  reset: () => void;
  /** PUT только при изменении; после — ждём рефетч, чтобы hasChanges обнулился. */
  save: () => Promise<void>;
}

/**
 * Черновик вкладки «Зарплата» в панели назначений (персональный доступ, миграция 288).
 *
 * Выбор хранится вместе с сотрудником, для которого сделан: при смене сотрудника черновик
 * другого человека не подхватывается. Пока уровень не загрузился или загрузка упала,
 * изменений нет по определению — общий «Сохранить» панели не отправит «Нет доступа»
 * поверх неизвестного уровня.
 */
export const usePayrollAccessDraft = ({ employeeId, enabled }: IUsePayrollAccessDraftArgs): IPayrollAccessDraft => {
  const queryClient = useQueryClient();
  const query = useQuery<PayrollAccessLevel>({
    queryKey: ['admin-payroll-access', employeeId ?? 0],
    queryFn: () => payrollAccessService.get(employeeId as number),
    enabled: enabled && employeeId != null,
    staleTime: 30_000,
  });

  const isReady = query.isSuccess;
  const initial: PayrollAccessLevel = query.data ?? null;
  const [edit, setEdit] = useState<{ employeeId: number | null; level: PayrollAccessLevel } | null>(null);

  const level = edit && edit.employeeId === employeeId ? edit.level : initial;
  const hasChanges = isReady && level !== initial;

  const setLevel = useCallback(
    (next: PayrollAccessLevel) => setEdit({ employeeId, level: next }),
    [employeeId],
  );

  const reset = useCallback(() => setEdit(null), []);

  const save = useCallback(async () => {
    if (!hasChanges || employeeId == null) return;
    await payrollAccessService.set(employeeId, level);
    await queryClient.invalidateQueries({ queryKey: ['admin-payroll-access', employeeId] });
    setEdit(null);
  }, [hasChanges, employeeId, level, queryClient]);

  return {
    level,
    setLevel,
    hasChanges,
    isLoading: query.isLoading,
    isError: query.isError,
    reset,
    save,
  };
};
