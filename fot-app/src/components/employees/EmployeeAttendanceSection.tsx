import { useMemo, type FC } from 'react';
import { Clock, LogIn, LogOut } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useAccessPointMapViewer } from '../../hooks/useAccessPointMapViewer';
import type { Employee, SkudEvent } from '../../types';
import type { IAlert, IDayAttendance, IWeekdayPattern } from '../../utils/attendanceCalc';
import {
  buildDisplayItems,
  calculateWorkSeconds,
  findFirstExternalEntry,
  findLastExternalExit,
  sumBreakSeconds,
} from '../../utils/skudDisplay';
import { AccessPointTrigger } from '../skud/AccessPointTrigger';
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
  internalPoints: Set<string>;
}

const formatHM = (seconds: number): string => {
  if (seconds <= 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0 && m === 0) return '<1м';
  if (h === 0) return `${m}м`;
  if (m === 0) return `${h}ч`;
  return `${h}ч ${m}м`;
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
  internalPoints,
}) => {
  const { canViewPage } = useAuth();
  const {
    canOpenAccessPointMap,
    openAccessPointMap,
    accessPointMapModal,
  } = useAccessPointMapViewer(canViewPage('/skud-settings'));

  const { items, totalSec, firstEntry, lastExit, breakSec } = useMemo(() => {
    const sortedEvents = [...showEvents].sort((a, b) => a.event_time.localeCompare(b.event_time));
    const displayItems = buildDisplayItems(sortedEvents, internalPoints, showDate);
    const total = calculateWorkSeconds(sortedEvents, internalPoints, showDate);
    const firstExt = findFirstExternalEntry(sortedEvents, internalPoints);
    const lastExt = findLastExternalExit(sortedEvents, internalPoints);
    return {
      items: displayItems,
      totalSec: total,
      firstEntry: firstExt?.event_time.slice(0, 5) || null,
      lastExit: lastExt?.event_time.slice(0, 5) || null,
      breakSec: sumBreakSeconds(displayItems),
    };
  }, [showDate, showEvents, internalPoints]);

  const workCalc = totalSec > 0
    ? `${Math.floor(totalSec / 3600)}ч ${Math.floor((totalSec % 3600) / 60)}м`
    : null;
  const breakCalc = breakSec > 0
    ? `${Math.floor(breakSec / 3600)}ч ${Math.floor((breakSec % 3600) / 60)}м`
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
        ) : items.length > 0 ? (
          <div className="ec-today-events">
            {items.map((item, index) => {
              if (item.kind === 'break') {
                return (
                  <div key={`break-${index}`} className="ec-event-row ec-pair-break">
                    <span className="ec-pair-break-label">Перерыв: {formatHM(item.breakSeconds)}</span>
                  </div>
                );
              }
              const { event, pairDurationSeconds, isInternal } = item;
              return (
                <div
                  key={event.id}
                  className={`ec-event-row ${isInternal ? 'ec-event-row--internal' : ''}`}
                >
                  <span className={`ec-event-icon ${event.direction === 'entry' ? 'ec-event-entry' : 'ec-event-exit'}`}>
                    {event.direction === 'entry' ? '→' : '←'}
                  </span>
                  <span className="ec-event-time">{event.event_time.slice(0, 5)}</span>
                  <span className="ec-event-dir">{event.direction === 'entry' ? 'Вход' : 'Выход'}</span>
                  {event.access_point && (
                    <AccessPointTrigger
                      accessPointName={event.access_point}
                      className="ec-event-point"
                      canOpen={canOpenAccessPointMap}
                      onOpen={openAccessPointMap}
                    />
                  )}
                  {pairDurationSeconds !== null && pairDurationSeconds > 0 && (
                    <span className="ec-pair-duration-inline">{formatHM(pairDurationSeconds)}</span>
                  )}
                </div>
              );
            })}
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
            {breakCalc && (
              <div className="ec-today-badge ec-today-badge-absent">
                <span>Перерыв: {breakCalc}</span>
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
      {accessPointMapModal}
    </div>
  );
};
