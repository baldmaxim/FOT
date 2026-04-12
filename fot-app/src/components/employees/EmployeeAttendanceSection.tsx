import { useMemo, type FC } from 'react';
import { Clock, LogIn, LogOut } from 'lucide-react';
import type { Employee, SkudEvent } from '../../types';
import type { IAlert, IDayAttendance, IWeekdayPattern } from '../../utils/attendanceCalc';
import { AttendanceCalendar } from './AttendanceCalendar';
import { EmployeeCardSidebar } from './EmployeeCardSidebar';

interface IEmployeeAttendanceSectionProps {
  employee: Employee;
  attendanceDays: IDayAttendance[];
  attendanceLoading: boolean;
  year: number;
  month: number;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onDayClick: (day: number) => void;
  onDayPrefetch?: (day: number) => void;
  selectedDay: number | null;
  dayLabel: string;
  showDate: string;
  showEvents: SkudEvent[];
  showEventsLoading: boolean;
  weeklyPattern: IWeekdayPattern[];
  alerts: IAlert[];
}

const timeToSec = (time: string): number => {
  const [h, m, s = 0] = time.split(':').map(Number);
  return h * 3600 + m * 60 + s;
};

const formatMinutes = (mins: number): string => {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m} мин`;
  if (m === 0) return `${h} ч`;
  return `${h} ч ${m} мин`;
};

export const EmployeeAttendanceSection: FC<IEmployeeAttendanceSectionProps> = ({
  employee,
  attendanceDays,
  attendanceLoading,
  year,
  month,
  onPrevMonth,
  onNextMonth,
  onDayClick,
  onDayPrefetch,
  selectedDay,
  dayLabel,
  showDate,
  showEvents,
  showEventsLoading,
  weeklyPattern,
  alerts,
}) => {
  const { pairs, totalSec, firstEntry, lastExit, absentSec } = useMemo(() => {
    const todayStr = new Date().toISOString().slice(0, 10);
    const computedPairs: { entry: SkudEvent; exit: SkudEvent | null; durationMinutes: number }[] = [];
    let totalSeconds = 0;
    let currentEntry: SkudEvent | null = null;

    for (const event of showEvents) {
      if (event.direction === 'entry') {
        if (!currentEntry) currentEntry = event;
        continue;
      }
      if (event.direction === 'exit' && currentEntry) {
        const duration = timeToSec(event.event_time) - timeToSec(currentEntry.event_time);
        totalSeconds += duration;
        computedPairs.push({
          entry: currentEntry,
          exit: event,
          durationMinutes: Math.round(duration / 60),
        });
        currentEntry = null;
      }
    }

    const viewingToday = showDate === todayStr;
    if (currentEntry && viewingToday) {
      const now = new Date();
      const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
      const duration = nowSec - timeToSec(currentEntry.event_time);
      if (duration > 0) {
        totalSeconds += duration;
        computedPairs.push({
          entry: currentEntry,
          exit: null,
          durationMinutes: Math.round(duration / 60),
        });
      }
    }

    let totalAbsentSec = 0;
    for (let i = 0; i < computedPairs.length - 1; i += 1) {
      const exitTime = computedPairs[i].exit?.event_time;
      const nextEntry = computedPairs[i + 1].entry.event_time;
      if (exitTime) totalAbsentSec += timeToSec(nextEntry) - timeToSec(exitTime);
    }

    return {
      pairs: computedPairs,
      totalSec: totalSeconds,
      firstEntry: showEvents.find(event => event.direction === 'entry')?.event_time?.slice(0, 5) || null,
      lastExit: [...showEvents].reverse().find(event => event.direction === 'exit')?.event_time?.slice(0, 5) || null,
      absentSec: totalAbsentSec,
    };
  }, [showDate, showEvents]);

  const workCalc = totalSec > 0
    ? `${Math.floor(totalSec / 3600)}ч ${Math.floor((totalSec % 3600) / 60)}м`
    : null;
  const absentCalc = absentSec > 0
    ? `${Math.floor(absentSec / 3600)}ч ${Math.floor((absentSec % 3600) / 60)}м`
    : null;

  return (
    <div className="ec-attendance-3col">
      <div className="ec-card ec-today-card">
        <div className="ec-card-header">
          <div className="ec-card-title">
            <Clock size={16} />
            {dayLabel}
          </div>
        </div>
        {showEventsLoading ? (
          <div className="ec-tl-empty">Загрузка событий...</div>
        ) : showEvents.length > 0 ? (
          <div className="ec-today-events">
            {pairs.length > 0 ? pairs.map((pair, index) => (
              <div key={index} className="ec-pair-block">
                <div className="ec-event-row">
                  <span className="ec-event-icon ec-event-entry">→</span>
                  <span className="ec-event-time">{pair.entry.event_time.slice(0, 5)}</span>
                  <span className="ec-event-dir">Вход</span>
                  {pair.entry.access_point && <span className="ec-event-point">{pair.entry.access_point}</span>}
                </div>
                {pair.exit ? (
                  <div className="ec-event-row">
                    <span className="ec-event-icon ec-event-exit">←</span>
                    <span className="ec-event-time">{pair.exit.event_time.slice(0, 5)}</span>
                    <span className="ec-event-dir">Выход</span>
                    {pair.exit.access_point && <span className="ec-event-point">{pair.exit.access_point}</span>}
                  </div>
                ) : (
                  <div className="ec-event-row">
                    <span className="ec-event-icon ec-event-entry">→</span>
                    <span className="ec-event-time">—</span>
                    <span className="ec-event-dir ec-on-site">на месте</span>
                  </div>
                )}
                {pair.durationMinutes > 0 && (
                  <div className="ec-pair-duration">{formatMinutes(pair.durationMinutes)}</div>
                )}
              </div>
            )) : showEvents.map((event, index) => (
              <div key={index} className="ec-event-row">
                <span className={`ec-event-icon ${event.direction === 'entry' ? 'ec-event-entry' : 'ec-event-exit'}`}>
                  {event.direction === 'entry' ? '→' : '←'}
                </span>
                <span className="ec-event-time">{event.event_time.slice(0, 5)}</span>
                <span className="ec-event-dir">{event.direction === 'entry' ? 'Вход' : 'Выход'}</span>
                {event.access_point && <span className="ec-event-point">{event.access_point}</span>}
              </div>
            ))}
          </div>
        ) : (
          <div className="ec-tl-empty">Нет событий</div>
        )}
        {workCalc && (
          <div className="ec-today-footer">
            {firstEntry && (
              <div className="ec-today-badge ec-today-badge-entry">
                <LogIn size={14} />
                <span>{firstEntry}</span>
              </div>
            )}
            {lastExit && (
              <div className="ec-today-badge ec-today-badge-exit">
                <LogOut size={14} />
                <span>{lastExit}</span>
              </div>
            )}
            {absentCalc && (
              <div className="ec-today-badge ec-today-badge-absent">
                <span>Перерыв: {absentCalc}</span>
              </div>
            )}
            <div className="ec-today-total">{workCalc}</div>
          </div>
        )}
      </div>

      <div className="ec-calendar-col">
        <AttendanceCalendar
          days={attendanceDays}
          month={month}
          year={year}
          onPrevMonth={onPrevMonth}
          onNextMonth={onNextMonth}
          onDayClick={onDayClick}
          onDayPrefetch={onDayPrefetch}
          selectedDay={selectedDay}
          loading={attendanceLoading}
        />
      </div>

      <EmployeeCardSidebar
        weeklyPattern={weeklyPattern}
        alerts={alerts}
        employee={employee}
      />
    </div>
  );
};
