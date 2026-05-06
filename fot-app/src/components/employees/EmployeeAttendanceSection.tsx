import { useMemo, type FC } from 'react';
import { Clock, LogIn, LogOut } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useAccessPointMapViewer } from '../../hooks/useAccessPointMapViewer';
import type { Employee, EmployeeInput, SkudEvent } from '../../types';
import type { IAlert, IDayAttendance } from '../../utils/attendanceCalc';
import { formatSecondsLabel } from '../../utils/hoursDisplay';
import {
  buildDisplayItems,
  findFirstExternalEntry,
  findLastExternalExit,
  sumBreakSeconds,
} from '../../utils/skudDisplay';
import { AccessPointTrigger } from '../skud/AccessPointTrigger';
import { AttendanceCalendar } from './AttendanceCalendar';
import { EmployeeCardSidebar } from './EmployeeCardSidebar';
import { EmployeeInfoSection } from './EmployeeInfoSection';

interface IEmployeeAttendanceSectionProps {
  employee: Employee;
  attendanceDays: IDayAttendance[];
  attendanceLoading: boolean;
  // year/month — текущий выбранный календарный месяц (month — 0-based, как Date.getMonth()).
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
  alerts: IAlert[];
  internalPoints: Set<string>;
  isEditing: boolean;
  isSigurLinked: boolean;
  editData: Partial<EmployeeInput>;
  onEditDataChange: (data: Partial<EmployeeInput>) => void;
  onSave: () => void;
  onCancel: () => void;
}

// Форматтер для длительностей внутри СКУД-таймлайна (длительность пары вход→выход
// и строки «Перерыв»). Это сырые отрезки времени между событиями, отдельные от
// табельной суммы за день — поэтому здесь сохраняем особый кейс «<1м» для очень
// коротких отрезков, который не подходит для итоговой суммы дня.
const formatTimelineSegment = (seconds: number): string => {
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
  alerts,
  internalPoints,
  isEditing,
  isSigurLinked,
  editData,
  onEditDataChange,
  onSave,
  onCancel,
}) => {
  const { canViewPage } = useAuth();
  const {
    canOpenAccessPointMap,
    openAccessPointMap,
    accessPointMapModal,
  } = useAccessPointMapViewer(canViewPage('/skud-settings'));

  const { items, firstEntry, lastExit, breakSec } = useMemo(() => {
    const sortedEvents = [...showEvents].sort((a, b) => a.event_time.localeCompare(b.event_time));
    const displayItems = buildDisplayItems(sortedEvents, internalPoints, showDate);
    const firstExt = findFirstExternalEntry(sortedEvents, internalPoints);
    const lastExt = findLastExternalExit(sortedEvents, internalPoints);
    return {
      items: displayItems,
      firstEntry: firstExt?.event_time.slice(0, 5) || null,
      lastExit: lastExt?.event_time.slice(0, 5) || null,
      breakSec: sumBreakSeconds(displayItems),
    };
  }, [showDate, showEvents, internalPoints]);

  // Источник времени за выбранный день — табельные данные (selectVisibleHours).
  // Та же цифра, что и в календаре, табеле и боковой панели — единая для всех точек.
  const totalSec = useMemo(() => {
    const parts = showDate.split('-').map(Number);
    if (parts.length !== 3 || parts.some(Number.isNaN)) return 0;
    const [y, m, d] = parts;
    if (y !== year || m - 1 !== month) return 0;
    const dayData = attendanceDays.find(item => item.day === d);
    return dayData?.totalSeconds ?? 0;
  }, [showDate, year, month, attendanceDays]);

  const workCalc = totalSec > 0 ? formatSecondsLabel(totalSec) : null;
  const breakCalc = breakSec > 0 ? formatSecondsLabel(breakSec) : null;

  return (
    <div className="ec-attendance-merged">
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
                      <span className="ec-pair-break-label">Перерыв: {formatTimelineSegment(item.breakSeconds)}</span>
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
                      <span className="ec-pair-duration-inline">{formatTimelineSegment(pairDurationSeconds)}</span>
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

        <EmployeeCardSidebar alerts={alerts} />
      </div>

      <EmployeeInfoSection
        employee={employee}
        isEditing={isEditing}
        isSigurLinked={isSigurLinked}
        editData={editData}
        onEditDataChange={onEditDataChange}
        onSave={onSave}
        onCancel={onCancel}
      />
      {accessPointMapModal}
    </div>
  );
};
