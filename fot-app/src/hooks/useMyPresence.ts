import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { skudService } from '../services/skudService';
import { useDocumentVisibility } from './useDocumentVisibility';

type PresenceStatus = 'online' | 'offline' | 'unknown';

const toLocalISO = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

export const useMyPresence = (): { status: PresenceStatus; loading: boolean } => {
  const { profile } = useAuth();
  const empId = profile?.employee_id ?? null;
  const isVisible = useDocumentVisibility();

  // Настройки точек доступа — меняются редко, единый кэш 10 мин на всё приложение
  const accessPointsQuery = useQuery({
    queryKey: ['skud-access-point-settings'],
    queryFn: () => skudService.getAccessPointSettings().catch(() => []),
    staleTime: 10 * 60_000,
  });

  // События сотрудника за сегодня — обновляются раз в 60с
  const today = toLocalISO(new Date());
  const eventsQuery = useQuery({
    queryKey: ['skud-employee-events', empId, today, today],
    queryFn: () => (empId ? skudService.getEmployeeEvents(empId, today, today) : Promise.resolve([])),
    enabled: !!empId,
    staleTime: 30_000,
    refetchInterval: isVisible ? 60_000 : false,
    refetchIntervalInBackground: false,
  });

  const status: PresenceStatus = useMemo(() => {
    if (!empId) return 'unknown';
    const events = eventsQuery.data ?? [];
    const apSettings = accessPointsQuery.data ?? [];
    const internalPoints = new Set(apSettings.filter(s => s.is_internal).map(s => s.access_point_name));
    const extEvents = events
      .filter(e => !e.access_point || !internalPoints.has(e.access_point))
      .sort((a, b) => b.event_time.localeCompare(a.event_time));
    const lastExt = extEvents[0];
    if (!lastExt) return 'unknown';
    return lastExt.direction === 'entry' ? 'online' : 'offline';
  }, [empId, eventsQuery.data, accessPointsQuery.data]);

  const loading = !!empId && (eventsQuery.isLoading || accessPointsQuery.isLoading);
  return { status, loading };
};
