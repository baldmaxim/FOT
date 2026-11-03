import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { brigadeOutputAccessService } from '../services/brigadeOutputAccessService';

interface IUseBrigadeOutputAccessDraftArgs {
  employeeId: number | null;
  /** Панель открыта и вкладка «Выработка» доступна: иначе запрос не шлём (другим сервер ответит 403). */
  enabled: boolean;
}

export interface IBrigadeOutputAccessDraft {
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
 * Черновик вкладки «Выработка» (миграция 342): выбор хранится вместе с сотрудником, для которого сделан, а пока значение
 * не загрузилось (или загрузка упала), изменений нет — общий «Сохранить» панели не снимет галочку вслепую.
 */
export const useBrigadeOutputAccessDraft = ({
  employeeId,
  enabled,
}: IUseBrigadeOutputAccessDraftArgs): IBrigadeOutputAccessDraft => {
  const queryClient = useQueryClient();
  const query = useQuery<boolean>({
    queryKey: ['admin-brigade-output-access', employeeId ?? 0],
    queryFn: () => brigadeOutputAccessService.get(employeeId as number),
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
    await brigadeOutputAccessService.set(employeeId, granted);
    await queryClient.invalidateQueries({ queryKey: ['admin-brigade-output-access', employeeId] });
    setEdit(null);
  }, [hasChanges, employeeId, granted, queryClient]);

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
