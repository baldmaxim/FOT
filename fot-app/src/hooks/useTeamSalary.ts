import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError } from '../api/client';
import { teamSalaryKeys } from '../api/queryKeys';
import { useAuth } from '../contexts/AuthContext';
import { teamSalaryService, type ITeamSalaryResponse, type TeamSalaryRow } from '../services/teamSalaryService';
import {
  isTeamSalaryExpired,
  msUntilNextMonth,
  resolveTeamSalaryView,
  TEAM_SALARY_TIMER_MAX_MS,
  teamSalaryClockOffset,
} from '../utils/teamSalary';

/** Перепроверка открытой вкладки: снятие доступа через SQL или у второй учётки события не шлёт. */
const TEAM_SALARY_RECHECK_MS = 10 * 60 * 1000;

interface IUseTeamSalaryParams {
  departmentId: string | null;
  /** Экран, где столбец уместен: «По отделу» / «По участкам», вкладка «По сотрудникам», выбран отдел. */
  enabled: boolean;
}

export interface ITeamSalaryState {
  /** Показывать столбец: доступ есть и сервер не отказал (403/422). */
  visible: boolean;
  loading: boolean;
  /** Ответ, который можно показывать: не истёкший, не после ошибки; иначе undefined. */
  data: ITeamSalaryResponse | undefined;
  /** Строки по сотруднику. */
  rows: ReadonlyMap<number, TeamSalaryRow>;
  /** Сбой загрузки (не отказ в доступе): ячейки «—» с подсказкой. */
  failed: boolean;
}

const isAccessRefusal = (error: unknown): boolean => (
  error instanceof ApiError && (error.status === 403 || error.status === 422)
);

const EMPTY_ROWS: ReadonlyMap<number, TeamSalaryRow> = new Map();

/**
 * Столбец «Зарплата» в табеле руководителя (миграция 382).
 *
 * - Ключ — учётка + эпоха доступа + отдел: другая учётка и сменившийся доступ прежних сумм не получат.
 * - Ошибка (в том числе 403 после снятия доступа) прячет и прежние данные: React Query держит их у запроса с ошибкой.
 * - Месяц меняется 10-го в 00:00 МСК: таймер до next_from по часам сервера, проверка при возврате на вкладку; ответ,
 *   истёкший ещё на сервере, не показывается и запрашивается заново.
 * - Раз в 10 минут (только видимая вкладка) — перепроверка доступа и сумм.
 */
export const useTeamSalary = ({ departmentId, enabled }: IUseTeamSalaryParams): ITeamSalaryState => {
  const { profile, teamSalaryEpoch } = useAuth();
  const queryClient = useQueryClient();
  const profileId = profile?.id ?? '';
  const active = enabled && Boolean(departmentId) && Boolean(profileId) && profile?.has_team_salary_access === true;
  const queryKey = useMemo(
    () => teamSalaryKeys.byDepartment(profileId, teamSalaryEpoch, departmentId ?? ''),
    [profileId, teamSalaryEpoch, departmentId],
  );
  // Сдвиг часов клиента относительно сервера на момент последнего ответа.
  const clockOffsetRef = useRef(0);

  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const data = await teamSalaryService.get(departmentId as string, signal);
      clockOffsetRef.current = teamSalaryClockOffset(data.server_now, Date.now());
      return data;
    },
    enabled: active,
    staleTime: 5 * 60 * 1000,
    gcTime: 60 * 1000,
    retry: false,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    refetchInterval: current => (current.state.status === 'error' ? false : TEAM_SALARY_RECHECK_MS),
    refetchIntervalInBackground: false,
  });

  const fresh = query.isError ? undefined : query.data;
  const expired = fresh !== undefined && isTeamSalaryExpired(fresh);

  // Ответ истёк ещё на сервере — сразу новый запрос (месяц на сервере уже другой).
  useEffect(() => {
    if (expired) void queryClient.invalidateQueries({ queryKey, exact: true });
  }, [expired, queryClient, queryKey]);

  // Таймер до смены месяца; дольше суток — перевзвод (вкладка могла уснуть).
  const [timerTick, setTimerTick] = useState(0);
  const nextFrom = fresh?.next_from ?? null;
  useEffect(() => {
    if (!active || !nextFrom) return undefined;
    const left = msUntilNextMonth(nextFrom, clockOffsetRef.current, Date.now());
    if (left <= 0) {
      void queryClient.invalidateQueries({ queryKey, exact: true });
      return undefined;
    }
    const timer = window.setTimeout(() => {
      if (msUntilNextMonth(nextFrom, clockOffsetRef.current, Date.now()) <= 0) {
        void queryClient.invalidateQueries({ queryKey, exact: true });
      } else {
        setTimerTick(tick => tick + 1);
      }
    }, Math.min(left, TEAM_SALARY_TIMER_MAX_MS));
    return () => window.clearTimeout(timer);
  }, [active, nextFrom, queryClient, queryKey, timerTick]);

  // Вкладка проснулась или получила фокус — граница могла пройти, пока таймеры спали.
  useEffect(() => {
    if (!active || !nextFrom) return undefined;
    const recheck = (): void => {
      if (document.visibilityState !== 'visible') return;
      if (msUntilNextMonth(nextFrom, clockOffsetRef.current, Date.now()) <= 0) {
        void queryClient.invalidateQueries({ queryKey, exact: true });
      }
    };
    document.addEventListener('visibilitychange', recheck);
    window.addEventListener('focus', recheck);
    return () => {
      document.removeEventListener('visibilitychange', recheck);
      window.removeEventListener('focus', recheck);
    };
  }, [active, nextFrom, queryClient, queryKey]);

  const view = resolveTeamSalaryView({
    active,
    isError: query.isError,
    refused: query.isError && isAccessRefusal(query.error),
    data: query.data,
  });
  const rows = useMemo(
    () => (view.data ? new Map(view.data.rows.map(row => [row.employee_id, row])) : EMPTY_ROWS),
    [view.data],
  );

  return { ...view, rows };
};
