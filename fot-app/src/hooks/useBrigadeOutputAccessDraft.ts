import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { brigadeOutputAccessService, type IBrigadeOutputAccess } from '../services/brigadeOutputAccessService';

interface IUseBrigadeOutputAccessDraftArgs {
  employeeId: number | null;
  /** Панель открыта и вкладка «Выработка» доступна: иначе запрос не шлём (другим сервер ответит 403). */
  enabled: boolean;
}

export interface IBrigadeOutputAccessDraft {
  granted: boolean;
  toggle: () => void;
  /** «Ставить КТУ своим бригадам» (370). */
  supervisorKtu: boolean;
  toggleSupervisorKtu: () => void;
  /** Вторая галочка видна начальнику участка хотя бы одной бригады или когда уже стоит (чтобы снять). */
  showSupervisorKtu: boolean;
  /** «Видеть зарплату своих сотрудников в табеле» (382). */
  teamSalary: boolean;
  toggleTeamSalary: () => void;
  /** Третья галочка видна руководителю хотя бы одного отдела или когда уже стоит (чтобы снять). */
  showTeamSalary: boolean;
  /** Отделы, где сотрудник руководитель, — подпись под третьей галочкой. */
  managedDepartments: readonly string[];
  /** Сколько галочек стоит — для подписи вкладки. */
  checkedCount: number;
  /** Черновик отличается от сохранённого. Пока значение не загружено, всегда false. */
  hasChanges: boolean;
  isLoading: boolean;
  isError: boolean;
  reset: () => void;
  /** PUT только изменённых галочек; после — ждём рефетч, чтобы hasChanges обнулился. */
  save: () => Promise<void>;
}

const EMPTY: IBrigadeOutputAccess = {
  granted: false, supervisor_ktu: false, supervised_brigades: 0, team_salary: false, managed_departments: [],
};

interface IDraft {
  employeeId: number | null;
  granted: boolean;
  supervisorKtu: boolean;
  teamSalary: boolean;
}

/**
 * Черновик вкладки «Выработка» (миграции 342, 370, 382): выбор хранится вместе с сотрудником, для которого сделан, а пока
 * значение не загрузилось (или загрузка упала), изменений нет — общий «Сохранить» панели не снимет галочку вслепую.
 */
export const useBrigadeOutputAccessDraft = ({
  employeeId,
  enabled,
}: IUseBrigadeOutputAccessDraftArgs): IBrigadeOutputAccessDraft => {
  const queryClient = useQueryClient();
  const query = useQuery<IBrigadeOutputAccess>({
    queryKey: ['admin-brigade-output-access', employeeId ?? 0],
    queryFn: () => brigadeOutputAccessService.get(employeeId as number),
    enabled: enabled && employeeId != null,
    staleTime: 30_000,
  });

  const saved = query.data ?? EMPTY;
  const [edit, setEdit] = useState<IDraft | null>(null);
  const current = edit && edit.employeeId === employeeId
    ? edit
    : { employeeId, granted: saved.granted, supervisorKtu: saved.supervisor_ktu, teamSalary: saved.team_salary };
  const grantedChanged = query.isSuccess && current.granted !== saved.granted;
  const supervisorKtuChanged = query.isSuccess && current.supervisorKtu !== saved.supervisor_ktu;
  const teamSalaryChanged = query.isSuccess && current.teamSalary !== saved.team_salary;

  const update = useCallback((patch: (draft: IDraft) => Partial<IDraft>) => {
    setEdit(prev => {
      const base: IDraft = prev && prev.employeeId === employeeId
        ? prev
        : { employeeId, granted: saved.granted, supervisorKtu: saved.supervisor_ktu, teamSalary: saved.team_salary };
      return { ...base, ...patch(base) };
    });
  }, [employeeId, saved.granted, saved.supervisor_ktu, saved.team_salary]);

  const toggle = useCallback(() => update(draft => ({ granted: !draft.granted })), [update]);
  const toggleSupervisorKtu = useCallback(() => update(draft => ({ supervisorKtu: !draft.supervisorKtu })), [update]);
  const toggleTeamSalary = useCallback(() => update(draft => ({ teamSalary: !draft.teamSalary })), [update]);

  const reset = useCallback(() => setEdit(null), []);

  const save = useCallback(async () => {
    if ((!grantedChanged && !supervisorKtuChanged && !teamSalaryChanged) || employeeId == null) return;
    await brigadeOutputAccessService.set(employeeId, {
      ...(grantedChanged ? { granted: current.granted } : {}),
      ...(supervisorKtuChanged ? { supervisor_ktu: current.supervisorKtu } : {}),
      ...(teamSalaryChanged ? { team_salary: current.teamSalary } : {}),
    });
    await queryClient.invalidateQueries({ queryKey: ['admin-brigade-output-access', employeeId] });
    setEdit(null);
  }, [
    grantedChanged,
    supervisorKtuChanged,
    teamSalaryChanged,
    employeeId,
    current.granted,
    current.supervisorKtu,
    current.teamSalary,
    queryClient,
  ]);

  return {
    granted: current.granted,
    toggle,
    supervisorKtu: current.supervisorKtu,
    toggleSupervisorKtu,
    showSupervisorKtu: saved.supervised_brigades > 0 || saved.supervisor_ktu,
    teamSalary: current.teamSalary,
    toggleTeamSalary,
    showTeamSalary: saved.managed_departments.length > 0 || saved.team_salary,
    managedDepartments: saved.managed_departments,
    checkedCount: (current.granted ? 1 : 0) + (current.supervisorKtu ? 1 : 0) + (current.teamSalary ? 1 : 0),
    hasChanges: grantedChanged || supervisorKtuChanged || teamSalaryChanged,
    isLoading: query.isLoading,
    isError: query.isError,
    reset,
    save,
  };
};
