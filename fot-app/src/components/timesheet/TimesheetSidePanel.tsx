import { type FC, useMemo, useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronDown, ChevronRight, LogIn, LogOut, Timer, Check, XCircle } from 'lucide-react';
import type { TimesheetEntry, TimesheetEmployee, SkudEvent, SkudEventFailure, IProductionCalendarMonth } from '../../types';
import type { IResolvedSchedule } from '../../types/schedule';
import { useAuth } from '../../contexts/AuthContext';
import { useAccessPointMapViewer } from '../../hooks/useAccessPointMapViewer';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { skudService } from '../../services/skudService';
import { AccessPointTrigger } from '../skud/AccessPointTrigger';
import {
  buildDisplayItems,
  mergeFailuresIntoDisplay,
} from '../../utils/skudDisplay';
import { formatFailureType } from '../../utils/skudFailureTypes';
import {
  getDaysInMonth,
  formatDateRu,
  getWeekdayFull,
  isToday,
} from '../../utils/calendarUtils';
import {
  getScheduleForTimesheetDay,
  isScheduleDayOff,
  isPreHolidayForSchedule,
  getFullDayThresholdHoursForDay,
} from '../../utils/scheduleUtils';
import { formatTimesheetEmployeeName } from '../../utils/timesheetDisplay';
import { selectVisibleHours, formatHoursLabel, formatSecondsLabel } from '../../utils/hoursDisplay';
import { getDayStatus, STATUS_TO_DETAIL_HOURS_CLASS } from '../../utils/dayStatus';

interface ISidePanelProps {
  open: boolean;
  onClose: () => void;
  employee: TimesheetEmployee | null;
  entries: TimesheetEntry[];
  year: number;
  month: number;
  schedules?: Record<number, IResolvedSchedule>;
  dailySchedules?: Record<number, Record<string, IResolvedSchedule>>;
  calendar?: IProductionCalendarMonth | null;
  visibleDays?: number[];
}

interface IDayEvents {
  date: string;
  events: SkudEvent[];
  failures: SkudEventFailure[];
}

const getInitials = (name: string): string => {
  const parts = name.split(' ');
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.substring(0, 2).toUpperCase();
};

const formatTime = (time: string): string => time.slice(0, 5);

const formatTravelMinutes = (minutes: number): string => {
  if (minutes <= 0) return '0 мин';
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins} мин`;
  if (mins === 0) return `${hours}ч`;
  return `${hours}ч ${mins}м`;
};

const groupEventsByDay = (events: SkudEvent[], failures: SkudEventFailure[]): Map<string, IDayEvents> => {
  const eventMap = new Map<string, SkudEvent[]>();
  for (const ev of events) {
    const key = ev.event_date;
    if (!eventMap.has(key)) eventMap.set(key, []);
    eventMap.get(key)!.push(ev);
  }
  const failureMap = new Map<string, SkudEventFailure[]>();
  for (const f of failures) {
    const key = f.event_date;
    if (!failureMap.has(key)) failureMap.set(key, []);
    failureMap.get(key)!.push(f);
  }

  const allDates = new Set<string>([...eventMap.keys(), ...failureMap.keys()]);
  const result = new Map<string, IDayEvents>();
  for (const date of allDates) {
    const dayEvents = (eventMap.get(date) || []).slice().sort((a, b) => a.event_time.localeCompare(b.event_time));
    const dayFailures = (failureMap.get(date) || []).slice().sort((a, b) => a.event_time.localeCompare(b.event_time));
    result.set(date, { date, events: dayEvents, failures: dayFailures });
  }
  return result;
};


export const TimesheetSidePanel: FC<ISidePanelProps> = ({
  open,
  onClose,
  employee,
  entries,
  year,
  month,
  schedules = {},
  dailySchedules = {},
  calendar = null,
  visibleDays,
}) => {
  const { canViewPage, showActualHours } = useAuth();
  const {
    canOpenAccessPointMap,
    openAccessPointMap,
    accessPointMapModal,
  } = useAccessPointMapViewer(canViewPage('/skud-settings'));
  const [expandedDays, setExpandedDays] = useState<Set<number>>(new Set());
  const [skudEvents, setSkudEvents] = useState<Map<string, IDayEvents>>(new Map());
  const [loadingSkud, setLoadingSkud] = useState(false);
  const [internalPoints, setInternalPoints] = useState<Set<string>>(new Set());
  const overlayHandlers = useOverlayDismiss(onClose);

  useEffect(() => {
    skudService.getAccessPointSettings().then(settings => {
      setInternalPoints(new Set(settings.filter(s => s.is_internal).map(s => s.access_point_name.trim())));
    }).catch(() => {});
  }, []);

  // Load SKUD events when panel opens
  const loadSkudEvents = useCallback(async () => {
    if (!employee || !open) return;
    setLoadingSkud(true);
    try {
      const firstVisibleDay = visibleDays?.[0] || 1;
      const lastVisibleDay = visibleDays?.[visibleDays.length - 1] || getDaysInMonth(year, month);
      const startDate = `${year}-${String(month).padStart(2, '0')}-${String(firstVisibleDay).padStart(2, '0')}`;
      const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastVisibleDay).padStart(2, '0')}`;
      const { events, failures } = await skudService.getEmployeeEventsWithFailures(employee.id, startDate, endDate);
      setSkudEvents(groupEventsByDay(events, failures));
    } catch {
      setSkudEvents(new Map());
    } finally {
      setLoadingSkud(false);
    }
  }, [employee, open, year, month, visibleDays]);

  useEffect(() => {
    if (open && employee) {
      loadSkudEvents();
      setExpandedDays(new Set());
    }
  }, [open, employee, loadSkudEvents]);

  const toggleDay = (day: number) => {
    setExpandedDays(prev => {
      const next = new Set(prev);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });
  };

  const dayDetails = useMemo(() => {
    if (!employee) return [];
    const details: Array<{
      day: number;
      entry: TimesheetEntry | null;
      isWeekend: boolean;
      isPreHoliday: boolean;
      fullDayThreshold: number;
    }> = [];

    for (const d of (visibleDays || Array.from({ length: getDaysInMonth(year, month) }, (_, index) => index + 1))) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const entry = entries.find(e => e.work_date === dateStr) || null;
      const sched = getScheduleForTimesheetDay(schedules, dailySchedules, employee.id, year, month, d);
      const dayOff = isScheduleDayOff(sched, calendar, year, month, d);
      if (dayOff && !entry) continue;
      const isPreHoliday = isPreHolidayForSchedule(sched, calendar ?? null, year, month, d);
      const fullDayThreshold = getFullDayThresholdHoursForDay(sched, calendar ?? null, year, month, d);

      const dayDate = new Date(year, month - 1, d);
      const today = new Date();
      today.setHours(23, 59, 59, 999);
      if (dayDate > today) continue;

      details.push({ day: d, entry, isWeekend: dayOff, isPreHoliday, fullDayThreshold });
    }

    return details;
  }, [employee, entries, year, month, schedules, dailySchedules, calendar, visibleDays]);

  const getHoursClass = (entry: TimesheetEntry | null, fullDayThreshold: number, isWeekendDay: boolean): string => {
    const status = getDayStatus(entry, {
      showActualHours,
      fullDayThresholdHours: fullDayThreshold,
      isScheduledDayOff: isWeekendDay,
    });
    return STATUS_TO_DETAIL_HOURS_CLASS[status];
  };

  const getHoursLabel = (entry: TimesheetEntry | null): string => {
    const visibleHours = selectVisibleHours(entry, showActualHours);
    if (!entry) return '—';
    if (entry.status === 'absent') return 'Неявка';
    if (entry.status === 'sick') return 'Б/л';
    if (entry.status === 'vacation') return 'Отпуск';
    return formatHoursLabel(visibleHours);
  };

  const getTravelIssueLabel = (entry: TimesheetEntry): string => {
    const parts: string[] = [];
    if ((entry.travel_delay_minutes || 0) > 0) {
      parts.push(`превышение лимита ${formatTravelMinutes(entry.travel_delay_minutes || 0)}`);
    }
    if ((entry.travel_problematic_segments || 0) > 0) {
      const count = entry.travel_problematic_segments || 0;
      parts.push(count === 1 ? 'не определён объект' : `не определён объект (${count})`);
    }
    return parts.join(' • ');
  };

  if (!employee) return null;

  const displayName = formatTimesheetEmployeeName(employee.full_name);

  return createPortal(
    <>
      <div
        className={`ts-backdrop ${open ? 'ts-backdrop--open' : ''}`}
        {...overlayHandlers}
      />
      <div className={`ts-side-panel ${open ? 'ts-side-panel--open' : ''}`}>
        <div className="ts-panel-header">
          <h3 className="ts-panel-title">Детализация</h3>
          <button className="ts-panel-close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="ts-panel-content">
          <div className="ts-panel-employee">
            <div className="ts-panel-avatar">{getInitials(employee.full_name)}</div>
            <div>
              <div className="ts-panel-emp-name">{displayName}</div>
            </div>
          </div>

          <div className="ts-panel-section">
            <div className="ts-panel-section-title">Детализация по дням</div>
            {dayDetails.map(({ day, entry, isWeekend: isWeekendDay, isPreHoliday, fullDayThreshold }) => {
              const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
              const dayEventsData = skudEvents.get(dateStr);
              const expanded = expandedDays.has(day);
              const hasEvents = dayEventsData && (dayEventsData.events.length > 0 || dayEventsData.failures.length > 0);
              // Источник суммарного времени и пограничных меток — табельная запись
              // (entry). Бэк уже замыкает open-entry для today по now() и применяет
              // cap по длине смены / show_actual_hours. Раньше здесь был fallback
              // на сырые СКУД-секунды без вычета обеда — он давал расхождение.
              const summaryFirstEntry = entry?.first_entry || null;
              const summaryLastExit = entry?.last_exit || null;
              const visibleHours = selectVisibleHours(entry, showActualHours);
              const summaryTotalSeconds = visibleHours != null
                ? Math.max(0, Math.round(visibleHours * 3600))
                : 0;

              return (
                <div key={day} className="ts-day-detail-wrap">
                  <div
                    className={`ts-day-detail ts-day-detail--clickable${entry?.status === 'absent' ? ' ts-day-detail--absent' : ''}${isPreHoliday ? ' ts-day-detail--pre-holiday' : ''}`}
                    onClick={() => toggleDay(day)}
                  >
                    <div className="ts-day-detail-left">
                      <span className="ts-day-detail-chevron">
                        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </span>
                      <div>
                        <div className="ts-day-detail-date">{formatDateRu(day, month)}</div>
                        <div className="ts-day-detail-day">
                          {getWeekdayFull(year, month, day)}
                          {isToday(year, month, day) ? ' (сегодня)' : ''}
                          {isPreHoliday ? ' • предпраздничный (−1ч)' : ''}
                        </div>
                      </div>
                    </div>
                    <div className="ts-day-detail-right">
                      {summaryFirstEntry && (
                        <span className="ts-day-detail-time-badge entry">
                          {formatTime(summaryFirstEntry)}
                        </span>
                      )}
                      {summaryLastExit && (
                        <span className="ts-day-detail-time-badge exit">
                          {formatTime(summaryLastExit)}
                        </span>
                      )}
                      <div className={`ts-day-detail-hours ${getHoursClass(entry, fullDayThreshold, isWeekendDay)}`}>
                        {getHoursLabel(entry)}
                      </div>
                      {entry && (
                        ((entry.travel_delay_minutes || 0) > 0
                          || (entry.travel_problematic_segments || 0) > 0)
                      ) && (
                        <div className="ts-day-detail-travel">
                          {getTravelIssueLabel(entry)}
                        </div>
                      )}
                    </div>
                  </div>

                  {expanded && (
                    <div className="ts-day-events-panel">
                      {loadingSkud ? (
                        <div className="ts-day-events-loading">Загрузка...</div>
                      ) : !hasEvents ? (
                        <div className="ts-day-events-empty">Нет событий СКУД</div>
                      ) : (
                        <>
                          {mergeFailuresIntoDisplay(
                            buildDisplayItems(dayEventsData.events, internalPoints, dateStr),
                            dayEventsData.failures,
                          ).map((item, idx) => {
                            if (item.kind === 'break') {
                              return (
                                <div key={`break-${idx}`} className="ts-day-event-row ts-day-event-row--break">
                                  <span className="ts-day-event-break-label">
                                    Перерыв: {formatSecondsLabel(item.breakSeconds)}
                                  </span>
                                </div>
                              );
                            }
                            if (item.kind === 'failure') {
                              const f = item.failure;
                              return (
                                <div
                                  key={`failure-${f.id}`}
                                  className="ts-day-event-row ts-day-event-row--failure"
                                  title={f.reason || ''}
                                >
                                  <span className="event-status-mark event-status-mark--failure" aria-label="Не учитывается">
                                    <XCircle size={13} />
                                  </span>
                                  <span className="ts-day-event-time">{formatTime(f.event_time)}</span>
                                  <span className="ts-day-event-failure-badge" title={f.failure_type}>{formatFailureType(f.failure_type)}</span>
                                  {f.access_point && (
                                    <AccessPointTrigger
                                      accessPointName={f.access_point}
                                      className="ts-day-event-point"
                                      canOpen={canOpenAccessPointMap}
                                      onOpen={openAccessPointMap}
                                    />
                                  )}
                                  {f.reason && (
                                    <span className="ts-day-event-failure-reason">{f.reason}</span>
                                  )}
                                </div>
                              );
                            }
                            const { event: ev, pairDurationSeconds, isInternal } = item;
                            return (
                            <div
                              key={ev.id}
                              className={`ts-day-event-row ${ev.direction || ''} ${isInternal ? 'internal' : ''}`}
                            >
                              {!isInternal && (
                                <span className="event-status-mark event-status-mark--success" aria-label="Учтено">
                                  <Check size={12} />
                                </span>
                              )}
                              <span className="ts-day-event-icon">
                                {ev.direction === 'entry' ? <LogIn size={13} /> : <LogOut size={13} />}
                              </span>
                              <span className="ts-day-event-time">
                                {formatTime(ev.event_time)}
                              </span>
                              <span className="ts-day-event-dir">
                                {ev.direction === 'entry' ? 'Вход' : 'Выход'}
                              </span>
                              {ev.access_point && (
                                <AccessPointTrigger
                                  accessPointName={ev.access_point}
                                  className="ts-day-event-point"
                                  canOpen={canOpenAccessPointMap}
                                  onOpen={openAccessPointMap}
                                />
                              )}
                              {pairDurationSeconds !== null && pairDurationSeconds > 0 && (
                                <span className="ts-day-event-pair-duration">
                                  {formatSecondsLabel(pairDurationSeconds)}
                                </span>
                              )}
                            </div>
                            );
                          })}
                          {summaryTotalSeconds > 0 && (
                            <div className="ts-day-events-summary">
                              {summaryFirstEntry && (
                                <span className="skud-time-badge entry">
                                  <LogIn size={11} /> {formatTime(summaryFirstEntry)}
                                </span>
                              )}
                              {summaryLastExit && (
                                <span className="skud-time-badge exit">
                                  <LogOut size={11} /> {formatTime(summaryLastExit)}
                                </span>
                              )}
                              <span className="skud-time-badge duration">
                                <Timer size={11} /> {formatSecondsLabel(summaryTotalSeconds)}
                              </span>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {dayDetails.length === 0 && (
              <div className="ts-loading">Нет данных за этот период</div>
            )}
          </div>
        </div>
      </div>
      {accessPointMapModal}
    </>,
    document.body,
  );
};
