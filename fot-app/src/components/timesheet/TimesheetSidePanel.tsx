import { type FC, useMemo, useState, useEffect, useCallback } from 'react';
import { X, ChevronDown, ChevronRight, LogIn, LogOut, Timer } from 'lucide-react';
import type { TimesheetEntry, TimesheetEmployee, SkudEvent, IProductionCalendarMonth } from '../../types';
import type { IResolvedSchedule } from '../../types/schedule';
import { skudService } from '../../services/skudService';
import {
  getDaysInMonth,
  formatDateRu,
  getWeekdayFull,
  isToday,
} from '../../utils/calendarUtils';
import {
  getEffectiveLateThresholdForDay,
  getScheduleForTimesheetDay,
  getWorkHoursForDay,
  isScheduleDayOff,
} from '../../utils/scheduleUtils';

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
}

interface IDayEvents {
  date: string;
  events: SkudEvent[];
  firstEntry: string | null;
  lastExit: string | null;
  totalSeconds: number;
}

const getInitials = (name: string): string => {
  const parts = name.split(' ');
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.substring(0, 2).toUpperCase();
};

const timeToSeconds = (time: string): number => {
  const [h, m, s = 0] = time.split(':').map(Number);
  return h * 3600 + m * 60 + s;
};

const formatTime = (time: string): string => time.slice(0, 5);

const formatDuration = (seconds: number): string => {
  if (seconds <= 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}м`;
  if (m === 0) return `${h}ч`;
  return `${h}ч ${m}м`;
};

const formatTravelMinutes = (minutes: number): string => {
  if (minutes <= 0) return '0 мин';
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins} мин`;
  if (mins === 0) return `${hours}ч`;
  return `${hours}ч ${mins}м`;
};

const todayISO = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const calcPairSeconds = (evts: SkudEvent[], dateStr?: string): number => {
  let total = 0;
  let entry: number | null = null;
  for (const ev of evts) {
    if (ev.direction === 'entry') {
      if (entry === null) entry = timeToSeconds(ev.event_time);
    } else if (ev.direction === 'exit' && entry !== null) {
      total += timeToSeconds(ev.event_time) - entry;
      entry = null;
    }
  }
  // Открытый вход (на работе сейчас) — считаем до текущего времени
  if (entry !== null && dateStr === todayISO()) {
    const now = new Date();
    const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    if (nowSec > entry) total += nowSec - entry;
  }
  return total;
};

const groupEventsByDay = (events: SkudEvent[], internalPoints: Set<string>): Map<string, IDayEvents> => {
  const map = new Map<string, SkudEvent[]>();
  for (const ev of events) {
    const key = ev.event_date;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(ev);
  }

  const result = new Map<string, IDayEvents>();
  for (const [date, dayEvents] of map) {
    dayEvents.sort((a, b) => a.event_time.localeCompare(b.event_time));

    // Filter out internal access points (same as EmployeeSkudSection)
    const extEvents = dayEvents.filter(e => !e.access_point || !internalPoints.has(e.access_point));

    // Calculate from external events; fallback to all if external gives 0
    let totalSeconds = calcPairSeconds(extEvents, date);
    if (totalSeconds === 0 && dayEvents.length > 0) {
      totalSeconds = calcPairSeconds(dayEvents, date);
    }

    const srcEvents = extEvents.length > 0 ? extEvents : dayEvents;
    const srcEntries = srcEvents.filter(e => e.direction === 'entry');
    const srcExits = srcEvents.filter(e => e.direction === 'exit');

    result.set(date, {
      date,
      events: dayEvents,
      firstEntry: srcEntries.length > 0 ? srcEntries[0].event_time : null,
      lastExit: srcExits.length > 0 ? srcExits[srcExits.length - 1].event_time : null,
      totalSeconds,
    });
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
}) => {
  const [expandedDays, setExpandedDays] = useState<Set<number>>(new Set());
  const [skudEvents, setSkudEvents] = useState<Map<string, IDayEvents>>(new Map());
  const [loadingSkud, setLoadingSkud] = useState(false);
  const [internalPoints, setInternalPoints] = useState<Set<string>>(new Set());

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
      const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
      const lastDay = getDaysInMonth(year, month);
      const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      const events = await skudService.getEmployeeEvents(employee.id, startDate, endDate);
      setSkudEvents(groupEventsByDay(events, internalPoints));
    } catch {
      setSkudEvents(new Map());
    } finally {
      setLoadingSkud(false);
    }
  }, [employee, open, year, month, internalPoints]);

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
    const daysCount = getDaysInMonth(year, month);
    const details: Array<{
      day: number;
      entry: TimesheetEntry | null;
      isWeekend: boolean;
    }> = [];

    for (let d = 1; d <= daysCount; d++) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const entry = entries.find(e => e.work_date === dateStr) || null;
      const sched = getScheduleForTimesheetDay(schedules, dailySchedules, employee.id, year, month, d);
      const dayOff = isScheduleDayOff(sched, calendar, year, month, d);
      if (dayOff && !entry) continue;

      const dayDate = new Date(year, month - 1, d);
      const today = new Date();
      today.setHours(23, 59, 59, 999);
      if (dayDate > today) continue;

      details.push({ day: d, entry, isWeekend: dayOff });
    }

    return details;
  }, [employee, entries, year, month, schedules, dailySchedules, calendar]);

  const stats = useMemo(() => {
    const normHours = employee ? (() => {
      const daysCount = getDaysInMonth(year, month);
      let total = 0;
      const now = new Date();
      now.setHours(23, 59, 59, 999);

      for (let d = 1; d <= daysCount; d++) {
        const dayDate = new Date(year, month - 1, d);
        if (dayDate > now) continue;

        const sched = getScheduleForTimesheetDay(schedules, dailySchedules, employee.id, year, month, d);
        if (isScheduleDayOff(sched, calendar, year, month, d)) continue;
        total += getWorkHoursForDay(sched, year, month, d);
      }

      return total;
    })() : 0;
    let factHours = 0;
    let lateCount = 0;
    let absentCount = 0;

    for (const entry of entries) {
      if (entry.hours_worked) factHours += entry.hours_worked;
      if (entry.status === 'absent') absentCount++;
      if (entry.status === 'work' && entry.first_entry) {
        const [entryYear, entryMonth, entryDay] = entry.work_date.split('-').map(Number);
        const sched = getScheduleForTimesheetDay(schedules, dailySchedules, entry.employee_id, entryYear, entryMonth, entryDay);
        const threshold = getEffectiveLateThresholdForDay(sched, entryYear, entryMonth, entryDay);
        const firstEntry = entry.first_entry.length === 5 ? `${entry.first_entry}:00` : entry.first_entry;
        if (firstEntry > threshold) lateCount++;
      }
    }

    return { factHours, normHours, lateCount, absentCount };
  }, [entries, year, month, employee, schedules, dailySchedules, calendar]);

  const getHoursClass = (entry: TimesheetEntry | null): string => {
    if (!entry) return 'ts-day-detail-hours--absent';
    if (entry.status === 'absent') return 'ts-day-detail-hours--absent';
    if (entry.status === 'sick') return 'ts-day-detail-hours--sick';
    if (entry.status === 'vacation') return 'ts-day-detail-hours--vacation';
    if (entry.hours_worked && entry.hours_worked >= 8) return 'ts-day-detail-hours--full';
    return 'ts-day-detail-hours--partial';
  };

  const formatHM = (decimal: number): string => {
    const h = Math.floor(decimal);
    const m = Math.round((decimal - h) * 60);
    if (m === 0) return `${h}ч`;
    return `${h}ч ${m}м`;
  };

  const getHoursLabel = (entry: TimesheetEntry | null): string => {
    if (!entry) return '—';
    if (entry.status === 'absent') return 'Неявка';
    if (entry.status === 'sick') return 'Б/л';
    if (entry.status === 'vacation') return 'Отпуск';
    if (entry.status === 'business_trip') return 'Ком-ка';
    if (entry.hours_worked != null) return formatHM(entry.hours_worked);
    return '—';
  };

  if (!employee) return null;

  return (
    <>
      <div
        className={`ts-backdrop ${open ? 'ts-backdrop--open' : ''}`}
        onClick={onClose}
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
              <div className="ts-panel-emp-name">{employee.full_name}</div>
              <div className="ts-panel-emp-role">{employee.position_name || '—'}</div>
            </div>
          </div>

          <div className="ts-panel-stats">
            <div className="ts-panel-stat">
              <div className="ts-panel-stat-value" style={{ color: 'var(--success)' }}>
                {formatHM(stats.factHours)}
              </div>
              <div className="ts-panel-stat-label">Отработано</div>
            </div>
            <div className="ts-panel-stat">
              <div className="ts-panel-stat-value">{stats.normHours}ч</div>
              <div className="ts-panel-stat-label">Норма</div>
            </div>
            <div className="ts-panel-stat">
              <div className="ts-panel-stat-value" style={{ color: 'var(--warning)' }}>
                {stats.lateCount}
              </div>
              <div className="ts-panel-stat-label">Опозданий</div>
            </div>
            <div className="ts-panel-stat">
              <div className="ts-panel-stat-value" style={{ color: 'var(--error)' }}>
                {stats.absentCount}
              </div>
              <div className="ts-panel-stat-label">Неявок</div>
            </div>
          </div>

          <div className="ts-panel-section">
            <div className="ts-panel-section-title">Детализация по дням</div>
            {dayDetails.map(({ day, entry }) => {
              const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
              const dayEventsData = skudEvents.get(dateStr);
              const expanded = expandedDays.has(day);
              const hasEvents = dayEventsData && dayEventsData.events.length > 0;

              return (
                <div key={day} className="ts-day-detail-wrap">
                  <div
                    className={`ts-day-detail ts-day-detail--clickable ${entry?.status === 'absent' ? 'ts-day-detail--absent' : ''}`}
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
                        </div>
                      </div>
                    </div>
                    <div className="ts-day-detail-right">
                      {entry?.first_entry && (
                        <span className="ts-day-detail-time-badge entry">
                          {formatTime(entry.first_entry)}
                        </span>
                      )}
                      {entry?.last_exit && (
                        <span className="ts-day-detail-time-badge exit">
                          {formatTime(entry.last_exit)}
                        </span>
                      )}
                      <div className={`ts-day-detail-hours ${getHoursClass(entry)}`}>
                        {getHoursLabel(entry)}
                      </div>
                      {entry && (
                        ((entry.travel_minutes_credited || 0) > 0
                          || (entry.travel_delay_minutes || 0) > 0
                          || (entry.travel_problematic_segments || 0) > 0)
                      ) && (
                        <div className="ts-day-detail-travel">
                          {(entry.travel_minutes_credited || 0) > 0
                            ? `дорога +${formatTravelMinutes(entry.travel_minutes_credited || 0)}`
                            : 'дорога не зачтена'}
                          {(entry.travel_delay_minutes || 0) > 0
                            ? ` • задержка ${formatTravelMinutes(entry.travel_delay_minutes || 0)}`
                            : ''}
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
                          {dayEventsData.events.map(ev => {
                            const isInternal = ev.access_point ? internalPoints.has(ev.access_point) : false;
                            return (
                            <div
                              key={ev.id}
                              className={`ts-day-event-row ${ev.direction || ''} ${isInternal ? 'internal' : ''}`}
                            >
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
                                <span className="ts-day-event-point">{ev.access_point}</span>
                              )}
                            </div>
                            );
                          })}
                          {dayEventsData.totalSeconds > 0 && (
                            <div className="ts-day-events-summary">
                              {dayEventsData.firstEntry && (
                                <span className="skud-time-badge entry">
                                  <LogIn size={11} /> {formatTime(dayEventsData.firstEntry)}
                                </span>
                              )}
                              {dayEventsData.lastExit && (
                                <span className="skud-time-badge exit">
                                  <LogOut size={11} /> {formatTime(dayEventsData.lastExit)}
                                </span>
                              )}
                              <span className="skud-time-badge duration">
                                <Timer size={11} /> {formatDuration(dayEventsData.totalSeconds)}
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
    </>
  );
};
