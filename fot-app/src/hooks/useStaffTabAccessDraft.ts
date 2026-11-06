import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { staffTabAccessService } from '../services/staffTabAccessService';
import type { StaffTab } from '../types/auth';

interface IUseStaffTabAccessDraftArgs {
  tab: StaffTab;
  employeeId: number | null;
  /** Панель открыта и вкладка доступна: иначе запрос не шлём (другим сервер ответит 403). */
  enabled: boolean;
}

export interface IStaffTabAccessDraft {
  granted: boolean;
  toggle: () => void;
  /** Черновик отличается от сохранённого. Пока значение не загружено, всегда false. */
  hasChanges: boolean;
  isLoading: boolean;
  isError: boolean;
  reset: () => void;
  /** PUT только при изменении; после — ждём рефетч, чтобы hasChanges обнулился. */
  save: () => Promise<void>;
}

/**
 * Черновик вкладки «Проживание» или «Удержания» (миграция 351) — как у «Выработки»: выбор хранится вместе с сотрудником,
 * для которого сделан, а пока значение не загрузилось (или загрузка упала), изменений нет — общий «Сохранить» панели не
 * снимет галочку вслепую.
 */
export const useStaffTabAccessDraft = ({
  tab,
  employeeId,
  enabled,
}: IUseStaffTabAccessDraftArgs): IStaffTabAccessDraft => {
  const queryClient = useQueryClient();
  const queryKey = ['admin-staff-tab-access', tab, employeeId ?? 0];
  const query = useQuery<boolean>({
    queryKey,
    queryFn: () => staffTabAccessService.get(tab, employeeId as number),
    enabled: enabled && employeeId != null,
    staleTime: 30_000,
  });

  const saved = query.data === true;
  const [edit, setEdit] = useState<{ employeeId: number | null; granted: boolean } | null>(null);
  const granted = edit && edit.employeeId === employeeId ? edit.granted : saved;
  const hasChanges = query.isSuccess && granted !== saved;

  const toggle = useCallback(() => {
    setEdit(prev => {
      const base = prev && prev.employeeId === employeeId ? prev.granted : saved;
      return { employeeId, granted: !base };
    });
  }, [employeeId, saved]);

  const reset = useCallback(() => setEdit(null), []);

  const save = useCallback(async () => {
    if (!hasChanges || employeeId == null) return;
    await staffTabAccessService.set(tab, employeeId, granted);
    await queryClient.invalidateQueries({ queryKey: ['admin-staff-tab-access', tab, employeeId] });
    setEdit(null);
  }, [hasChanges, employeeId, granted, tab, queryClient]);

  return {
    granted,
    toggle,
    hasChanges,
    isLoading: query.isLoading,
    isError: query.isError,
    reset,
    save,
  };
};
