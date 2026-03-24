import type { FC } from 'react';
import type { SkudEvent } from '../../types';
import styles from '../../pages/employee/EmployeeDashboard.module.css';

type ViewPeriod = 'day' | 'week' | 'month';

interface IDayAttendance {
  date: string;
  dayName: string;
  firstEntry: string | null;
  lastExit: string | null;
  totalMinutes: number;
  isToday: boolean;
  isWeekend: boolean;
}

interface IAttendanceCardProps {
  loading: boolean;
  eventsLoading: boolean;
  viewPeriod: ViewPeriod;
  setViewPeriod: (p: ViewPeriod) => void;
  setPeriodOffset: (fn: (o: number) => number) => void;
  periodLabel: string;
  isCurrentPeriod: boolean;
  dayEvents: SkudEvent[];
  dayData: { firstEntry: string | null; lastExit: string | null; totalMinutes: number };
  weekData: IDayAttendance[];
  monthDays: IDayAttendance[];
  getEventColor: (event: SkudEvent) => { dot: string; badge: string; label: string };
}

const formatTime = (t: string) => t.slice(0, 5);

const formatDateRu = (d: string) =>
  new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });

const formatHM = (totalMinutes: number): string => {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m} мин`;
  if (m === 0) return `${h} ч`;
  return `${h} ч ${m} мин`;
};

const timeToMinutes = (t: string): number => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

const DayView: FC<Pick<IAttendanceCardProps, 'dayEvents' | 'dayData' | 'getEventColor'>> = ({ dayEvents, dayData, getEventColor }) => (
  <>
    {dayEvents.length === 0 ? (
      <div className={styles.emptyState}>Нет событий СКУД</div>
    ) : (
      dayEvents.map((event, i) => {
        const { dot, badge, label } = getEventColor(event);
        const firstEntry = dayEvents[0]?.event_time;
        const duration = firstEntry && i > 0
          ? Math.max(0, timeToMinutes(event.event_time) - timeToMinutes(firstEntry))
          : 0;
        return (
          <div key={event.id || i} className={styles.requestItem}>
            <div className={`${styles.skudDot} ${dot}`} />
            <div className={styles.requestContent}>
              <div className={styles.requestTitle}>{label}</div>
              <div className={styles.requestMeta}>
                {event.access_point || '—'}
                {duration > 0 && <span className={styles.durationBadge}>{formatHM(duration)}</span>}
              </div>
            </div>
            <div className={`${styles.requestStatus} ${badge}`}>
              {formatTime(event.event_time)}
            </div>
          </div>
        );
      })
    )}
    {dayData.totalMinutes > 0 && (
      <div className={styles.todaySummary}>
        <span>Итого отработано:</span>
        <strong>{formatHM(dayData.totalMinutes)}</strong>
      </div>
    )}
  </>
);

const ScheduleRows: FC<{ days: IDayAttendance[] }> = ({ days }) => (
  <div className={styles.scheduleWeekFull}>
    {days.map((day) => (
      <div
        key={day.date}
        className={`${styles.scheduleRow} ${day.isToday ? styles.today : ''} ${day.isWeekend ? styles.weekend : ''}`}
      >
        <div className={styles.scheduleRowDay}>
          <span className={styles.scheduleDayName}>{day.dayName}</span>
          <span className={styles.scheduleDayDate}>{formatDateRu(day.date)}</span>
        </div>
        <div className={styles.scheduleRowTimes}>
          {day.firstEntry ? (
            <>
              <span className={styles.scheduleEntry}>{formatTime(day.firstEntry)}</span>
              <span className={styles.scheduleSep}>–</span>
              <span className={styles.scheduleExit}>{day.lastExit ? formatTime(day.lastExit) : 'на месте'}</span>
            </>
          ) : (
            <span className={styles.scheduleAbsent}>—</span>
          )}
        </div>
        {day.totalMinutes > 0 && (
          <div className={styles.scheduleRowHours}>{formatHM(day.totalMinutes)}</div>
        )}
      </div>
    ))}
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
  dayEvents,
  dayData,
  weekData,
  monthDays,
  getEventColor,
}) => {
  const weekTotal = weekData.reduce((s, d) => s + d.totalMinutes, 0);
  const monthTotal = monthDays.reduce((s, d) => s + d.totalMinutes, 0);
  const filteredMonthDays = monthDays.filter(d => !d.isWeekend || d.firstEntry);

  return (
    <div className={styles.card}>
      {/* Period controls */}
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

      <div className={styles.requestsList}>
        {(loading || eventsLoading) ? (
          <div className={styles.emptyState}>Загрузка...</div>
        ) : viewPeriod === 'day' ? (
          <DayView dayEvents={dayEvents} dayData={dayData} getEventColor={getEventColor} />
        ) : viewPeriod === 'week' ? (
          <>
            <ScheduleRows days={weekData} />
            {weekTotal > 0 && (
              <div className={styles.todaySummary}>
                <span>Итого за неделю:</span>
                <strong>{formatHM(weekTotal)}</strong>
              </div>
            )}
          </>
        ) : (
          <>
            <ScheduleRows days={filteredMonthDays} />
            {monthTotal > 0 && (
              <div className={styles.todaySummary}>
                <span>Итого за месяц:</span>
                <strong>{formatHM(monthTotal)}</strong>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
