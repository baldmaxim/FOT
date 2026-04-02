import { type FC, useState, useEffect } from 'react';
import type { SkudEvent } from '../../types';
import styles from '../../pages/employee/EmployeeDashboard.module.css';

type ViewPeriod = 'day' | 'week' | 'month';

export interface IDayGroup {
  date: string;
  dayName: string;
  events: SkudEvent[];
  firstEntry: string | null;
  lastExit: string | null;
  totalMinutes: number;
  isToday: boolean;
  isWeekend: boolean;
  pairs: IEntryExitPair[];
}

export interface IEntryExitPair {
  entry: SkudEvent;
  exit: SkudEvent | null;
  durationMinutes: number;
}

interface IAttendanceCardProps {
  loading: boolean;
  eventsLoading: boolean;
  viewPeriod: ViewPeriod;
  setViewPeriod: (p: ViewPeriod) => void;
  setPeriodOffset: (fn: (o: number) => number) => void;
  periodLabel: string;
  isCurrentPeriod: boolean;
  dayGroups: IDayGroup[];
}

const formatTime = (t: string) => t.slice(0, 5);

const formatHM = (totalMinutes: number): string => {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m} мин`;
  if (m === 0) return `${h} ч`;
  return `${h} ч ${m} мин`;
};

const formatDateLong = (d: string) =>
  new Date(d + 'T00:00:00').toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' });

const ChevronDown: FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
    <polyline points="6 9 12 15 18 9"/>
  </svg>
);

const ChevronRight: FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
    <polyline points="9 18 15 12 9 6"/>
  </svg>
);

const DayEvents: FC<{ group: IDayGroup }> = ({ group }) => (
  <div className={styles.skudDayEvents}>
    {group.pairs.length > 0 ? (
      group.pairs.map((pair, i) => (
        <div key={i} className={styles.skudPairBlock}>
          <div className={styles.skudEventRow}>
            <span className={`${styles.skudEventIcon} ${styles.skudEventEntry}`}>→</span>
            <span className={styles.skudEventTime}>{formatTime(pair.entry.event_time)}</span>
            <span className={styles.skudEventDir}>Вход</span>
            {pair.entry.access_point && <span className={styles.skudEventPoint}>{pair.entry.access_point}</span>}
          </div>
          {pair.exit ? (
            <div className={styles.skudEventRow}>
              <span className={`${styles.skudEventIcon} ${styles.skudEventExit}`}>←</span>
              <span className={styles.skudEventTime}>{formatTime(pair.exit.event_time)}</span>
              <span className={styles.skudEventDir}>Выход</span>
              {pair.exit.access_point && <span className={styles.skudEventPoint}>{pair.exit.access_point}</span>}
            </div>
          ) : (
            <div className={styles.skudEventRow}>
              <span className={`${styles.skudEventIcon} ${styles.skudEventEntry}`}>→</span>
              <span className={styles.skudEventTime}>—</span>
              <span className={styles.skudEventDir}>на месте</span>
            </div>
          )}
          {pair.durationMinutes > 0 && (
            <div className={styles.skudPairDuration}>{formatHM(pair.durationMinutes)}</div>
          )}
        </div>
      ))
    ) : (
      group.events.map((ev, i) => (
        <div key={i} className={styles.skudEventRow}>
          <span className={`${styles.skudEventIcon} ${ev.direction === 'entry' ? styles.skudEventEntry : styles.skudEventExit}`}>
            {ev.direction === 'entry' ? '→' : '←'}
          </span>
          <span className={styles.skudEventTime}>{formatTime(ev.event_time)}</span>
          <span className={styles.skudEventDir}>{ev.direction === 'entry' ? 'Вход' : 'Выход'}</span>
          {ev.access_point && <span className={styles.skudEventPoint}>{ev.access_point}</span>}
        </div>
      ))
    )}
  </div>
);

const DaySummaryBadges: FC<{ group: IDayGroup }> = ({ group }) => (
  <div className={styles.skudDaySummary}>
    {group.firstEntry && (
      <span className={`${styles.skudTimeBadge} ${styles.skudTimeBadgeEntry}`}>{formatTime(group.firstEntry)}</span>
    )}
    {group.lastExit && (
      <span className={`${styles.skudTimeBadge} ${styles.skudTimeBadgeExit}`}>{formatTime(group.lastExit)}</span>
    )}
    {group.totalMinutes > 0 && (
      <span className={`${styles.skudTimeBadge} ${styles.skudTimeBadgeDuration}`}>{formatHM(group.totalMinutes)}</span>
    )}
    <span className={styles.skudEventsCount}>{group.events.length} соб.</span>
  </div>
);

export const AttendanceCard: FC<IAttendanceCardProps> = ({
  loading,
  eventsLoading,
  viewPeriod,
  setViewPeriod,
  setPeriodOffset,
  periodLabel,
  isCurrentPeriod,
  dayGroups,
}) => {
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());

  // Auto-expand for day view
  useEffect(() => {
    if (viewPeriod === 'day' && dayGroups.length > 0) {
      setExpandedDays(new Set(dayGroups.map(g => g.date)));
    } else {
      setExpandedDays(new Set());
    }
  }, [viewPeriod, dayGroups]);

  const toggleDay = (date: string) => {
    setExpandedDays(prev => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  };

  const total = dayGroups.reduce((s, g) => s + g.totalMinutes, 0);
  const periodName = viewPeriod === 'day' ? 'день' : viewPeriod === 'week' ? 'неделю' : 'месяц';

  return (
    <div className={styles.card}>
      <div className={styles.attendanceHeader}>
        <div className={styles.periodTabs}>
          {(['day', 'week', 'month'] as ViewPeriod[]).map(p => (
            <button
              key={p}
              className={`${styles.periodTab} ${viewPeriod === p ? styles.periodTabActive : ''}`}
              onClick={() => { setViewPeriod(p); setPeriodOffset(() => 0); }}
            >
              {p === 'day' ? 'День' : p === 'week' ? 'Неделя' : 'Месяц'}
            </button>
          ))}
        </div>
        <div className={styles.periodNav}>
          <button className={styles.periodNavBtn} onClick={() => setPeriodOffset(o => o - 1)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <span className={styles.periodLabel}>{periodLabel}</span>
          <button
            className={styles.periodNavBtn}
            onClick={() => setPeriodOffset(o => o + 1)}
            disabled={isCurrentPeriod}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>
      </div>

      <div className={styles.skudDaysList}>
        {(loading || eventsLoading) ? (
          <div className={styles.emptyState}>Загрузка...</div>
        ) : dayGroups.length === 0 ? (
          <div className={styles.emptyState}>Нет событий СКУД</div>
        ) : (
          dayGroups.map(group => {
            const expanded = expandedDays.has(group.date);
            const hasEvents = group.events.length > 0;
            return (
              <div
                key={group.date}
                className={`${styles.skudDayCard} ${group.isToday ? styles.skudDayToday : ''} ${group.isWeekend ? styles.skudDayWeekend : ''}`}
              >
                <button
                  className={styles.skudDayHeader}
                  onClick={() => hasEvents && toggleDay(group.date)}
                  disabled={!hasEvents}
                >
                  <span className={styles.skudDayChevron}>
                    {hasEvents ? (expanded ? <ChevronDown /> : <ChevronRight />) : <span style={{ width: 16 }} />}
                  </span>
                  <span className={styles.skudDayDate}>{formatDateLong(group.date)}</span>
                  {hasEvents && <DaySummaryBadges group={group} />}
                  {!hasEvents && <span className={styles.skudAbsentLabel}>—</span>}
                </button>
                {expanded && hasEvents && <DayEvents group={group} />}
              </div>
            );
          })
        )}
      </div>

      {total > 0 && (
        <div className={styles.todaySummary}>
          <span>Итого за {periodName}:</span>
          <strong>{formatHM(total)}</strong>
        </div>
      )}
    </div>
  );
};
