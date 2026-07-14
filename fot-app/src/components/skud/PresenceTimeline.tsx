import { type FC, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { skudService } from '../../services/skudService';
import { buildPresenceIntervals, isToday } from '../../utils/skudDisplay';
import { formatSecondsLabel } from '../../utils/hoursDisplay';
import styles from './PresenceTimeline.module.css';

interface IPresenceTimelineProps {
  employeeId: number;
  /** YYYY-MM-DD */
  date: string;
  className?: string;
}

const formatClock = (totalSeconds: number): string => {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

export const PresenceTimeline: FC<IPresenceTimelineProps> = ({ employeeId, date, className }) => {
  const today = isToday(date);

  // Тот же queryKey, что у useMyPresence — в ЛК запрос не дублируется.
  const eventsQuery = useQuery({
    queryKey: ['skud-employee-events', employeeId, date, date],
    queryFn: () => skudService.getEmployeeEvents(employeeId, date, date),
    staleTime: 30_000,
  });

  const accessPointsQuery = useQuery({
    queryKey: ['skud-access-point-settings'],
    queryFn: () => skudService.getAccessPointSettings().catch(() => []),
    staleTime: 10 * 60_000,
  });

  // Минутный тик — двигает открытый интервал «сотрудник на месте прямо сейчас».
  const [tick, setTick] = useState(0);

  const intervals = useMemo(() => {
    void tick;
    const events = eventsQuery.data ?? [];
    const settings = accessPointsQuery.data ?? [];
    const internalPoints = new Set(settings.filter(s => s.is_internal).map(s => s.access_point_name));
    return buildPresenceIntervals(events, internalPoints, date);
  }, [eventsQuery.data, accessPointsQuery.data, date, tick]);

  const hasOpen = intervals.some(i => i.isOpen);

  useEffect(() => {
    if (!today || !hasOpen) return;
    const id = window.setInterval(() => setTick(t => t + 1), 60_000);
    return () => window.clearInterval(id);
  }, [today, hasOpen]);

  if (intervals.length === 0) return null;

  const windowStart = intervals[0].startSec;
  const windowEnd = intervals[intervals.length - 1].endSec;
  const span = Math.max(windowEnd - windowStart, 1);
  const totalSeconds = intervals.reduce((sum, i) => sum + (i.endSec - i.startSec), 0);

  return (
    <div className={className ? `${styles.wrap} ${className}` : styles.wrap}>
      <div className={styles.head}>
        <span className={styles.title}>Интервалы присутствия</span>
        <span className={styles.total}>{formatSecondsLabel(totalSeconds)}</span>
      </div>

      <div className={styles.track}>
        {intervals.map(iv => (
          <div
            key={`${iv.startSec}-${iv.endSec}`}
            className={iv.isOpen ? `${styles.segment} ${styles.segmentOpen}` : styles.segment}
            style={{
              left: `${((iv.startSec - windowStart) / span) * 100}%`,
              width: `${((iv.endSec - iv.startSec) / span) * 100}%`,
            }}
            title={`${formatClock(iv.startSec)} — ${formatClock(iv.endSec)}${iv.isOpen ? ' (на месте)' : ''}`}
          />
        ))}
      </div>

      <div className={styles.scale}>
        <span>{formatClock(windowStart)}</span>
        <span>{formatClock(windowEnd)}</span>
      </div>
    </div>
  );
};
