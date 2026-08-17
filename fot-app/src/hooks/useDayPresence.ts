import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { skudService } from '../services/skudService';
import {
  buildPresenceIntervals,
  findUnclosedEntryId,
  isToday,
} from '../utils/skudDisplay';
import { useNowSeconds } from './useNowTick';

export interface IDayPresence {
  /** Сырое присутствие: Σ интервалов вход→выход, открытый — до «сейчас». Обед НЕ вычтен. */
  workSeconds: number;
  /** Суммарные перерывы за день = размах присутствия − рабочее время. */
  breakSeconds: number;
  /** Сотрудник внутри прямо сейчас — цифры тикают раз в секунду. */
  isLive: boolean;
  /** Есть хотя бы один закрытый или открытый интервал. */
  hasData: boolean;
}

const EMPTY: IDayPresence = { workSeconds: 0, breakSeconds: 0, isLive: false, hasData: false };

/**
 * Присутствие за день по событиям СКУД — единый «сырой» знаменатель для ЛК.
 *
 * Запрашивается только для сегодняшнего дня, тем же queryKey, что использует
 * useMyPresence и PresenceTimeline, — то есть данные берутся из общего кэша
 * react-query без дополнительного обращения к API.
 */
export const useDayPresence = (employeeId: number | null, date: string): IDayPresence => {
  const today = isToday(date);

  const eventsQuery = useQuery({
    queryKey: ['skud-employee-events', employeeId, date, date],
    queryFn: () => skudService.getEmployeeEvents(employeeId!, date, date),
    enabled: Boolean(employeeId) && today,
    staleTime: 30_000,
  });

  const accessPointsQuery = useQuery({
    queryKey: ['skud-access-point-settings'],
    queryFn: () => skudService.getAccessPointSettings().catch(() => []),
    enabled: today,
    staleTime: 10 * 60_000,
  });

  const events = useMemo(() => eventsQuery.data ?? [], [eventsQuery.data]);
  const internalPoints = useMemo(
    () => new Set((accessPointsQuery.data ?? []).filter(s => s.is_internal).map(s => s.access_point_name)),
    [accessPointsQuery.data],
  );

  const hasOpenEntry = useMemo(
    () => today && findUnclosedEntryId(events, internalPoints) !== null,
    [today, events, internalPoints],
  );

  const nowSec = useNowSeconds(hasOpenEntry);

  return useMemo(() => {
    if (!today || events.length === 0) return EMPTY;
    const intervals = buildPresenceIntervals(events, internalPoints, date, nowSec);
    if (intervals.length === 0) return EMPTY;

    const workSeconds = intervals.reduce((sum, i) => sum + (i.endSec - i.startSec), 0);
    const spanSeconds = intervals[intervals.length - 1].endSec - intervals[0].startSec;

    return {
      workSeconds,
      breakSeconds: Math.max(0, spanSeconds - workSeconds),
      isLive: hasOpenEntry,
      hasData: true,
    };
  }, [today, events, internalPoints, date, nowSec, hasOpenEntry]);
};
