import { useState, useEffect, useCallback, useRef, type FC } from 'react';
import {
  LogIn, LogOut, ChevronDown, ChevronRight, ChevronLeft,
  Clock, RefreshCw, Timer,
} from 'lucide-react';
import { skudService } from '../../services/skudService';
import type { SkudEvent } from '../../types';

interface IEmployeeSkudSectionProps {
  employeeId: number;
  departmentId?: string;
  onSync?: () => void;
  focusDate?: string | null;
  focusKey?: number;
}

type ViewMode = 'day' | 'week' | 'month';

const VIEW_LABELS: Record<ViewMode, string> = {
  day: 'День',
  week: 'Неделя',
  month: 'Месяц',
};

const MONTH_NAMES = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

interface IDayGroup {
  date: string;
  events: SkudEvent[];
  firstEntry: string | null;
  lastExit: string | null;
  totalSeconds: number;
  spanSeconds: number;
}

const formatDateLabel = (dateStr: string): string => {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
};

const formatDateShort = (dateStr: string): string => {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

const formatTime = (time: string): string => time.slice(0, 8);
const formatTimeShort = (time: string): string => time.slice(0, 5);

const formatDuration = (seconds: number): string => {
  if (seconds <= 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h === 0 && m === 0) return `${s}с`;
  if (h === 0) return `${m}м ${s}с`;
  if (m === 0 && s === 0) return `${h}ч`;
  return `${h}ч ${m}м ${s}с`;
};

const timeToSeconds = (time: string): number => {
  const [h, m, s = 0] = time.split(':').map(Number);
  return h * 3600 + m * 60 + s;
};

/** Форматирует Date в YYYY-MM-DD в локальном часовом поясе */
const toLocalISO = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const isToday = (dateStr: string): boolean =>
  dateStr === toLocalISO(new Date());

const nowSeconds = (): number => {
  const now = new Date();
  return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
};

const calculateWorkMinutes = (events: SkudEvent[], internalPoints: Set<string>, dateStr?: string): number => {
  const filtered = events.filter(e => !e.access_point || !internalPoints.has(e.access_point));
  const sorted = [...filtered].sort((a, b) => a.event_time.localeCompare(b.event_time));
  let total = 0;
  let entryTime: number | null = null;

  for (const ev of sorted) {
    if (ev.direction === 'entry') {
      if (entryTime === null) entryTime = timeToSeconds(ev.event_time);
    } else if (ev.direction === 'exit' && entryTime !== null) {
      total += timeToSeconds(ev.event_time) - entryTime;
      entryTime = null;
    }
  }

  if (entryTime !== null && dateStr && isToday(dateStr)) {
    total += nowSeconds() - entryTime;
  }

  return total;
};

const groupByDay = (events: SkudEvent[], internalPoints: Set<string>): IDayGroup[] => {
  const map = new Map<string, SkudEvent[]>();
  for (const ev of events) {
    const key = ev.event_date;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(ev);
  }

  const groups: IDayGroup[] = [];
  for (const [date, dayEvents] of map) {
    dayEvents.sort((a, b) => a.event_time.localeCompare(b.event_time));
    const extEvents = dayEvents.filter(e => !e.access_point || !internalPoints.has(e.access_point));
    const entries = extEvents.filter(e => e.direction === 'entry');
    const exits = extEvents.filter(e => e.direction === 'exit');
    const lastExtEvent = extEvents.length > 0 ? extEvents[extEvents.length - 1] : null;
    const stillOnSite = lastExtEvent?.direction === 'entry' && isToday(date);

    let spanSeconds = 0;
    if (entries.length > 0) {
      if (stillOnSite) {
        spanSeconds = nowSeconds() - timeToSeconds(entries[0].event_time);
      } else if (exits.length > 0) {
        spanSeconds = timeToSeconds(exits[exits.length - 1].event_time) - timeToSeconds(entries[0].event_time);
      }
    }

    groups.push({
      date,
      events: dayEvents,
      firstEntry: entries.length > 0 ? entries[0].event_time : null,
      lastExit: stillOnSite ? null : (exits.length > 0 ? exits[exits.length - 1].event_time : null),
      totalSeconds: calculateWorkMinutes(dayEvents, internalPoints, date),
      spanSeconds,
    });
  }

  groups.sort((a, b) => b.date.localeCompare(a.date));
  return groups;
};

// Date range helpers
const getDateRange = (mode: ViewMode, viewDate: Date): { startDate: string; endDate: string } => {
  if (mode === 'day') {
    const d = toLocalISO(viewDate);
    return { startDate: d, endDate: d };
  }

  if (mode === 'week') {
    const day = viewDate.getDay();
    const diff = day === 0 ? -6 : 1 - day; // Monday start
    const monday = new Date(viewDate);
    monday.setDate(viewDate.getDate() + diff);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return {
      startDate: toLocalISO(monday),
      endDate: toLocalISO(sunday),
    };
  }

  // month
  const start = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1);
  const end = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 0);
  return {
    startDate: toLocalISO(start),
    endDate: toLocalISO(end),
  };
};

const navigateDate = (mode: ViewMode, current: Date, direction: -1 | 1): Date => {
  const next = new Date(current);
  if (mode === 'day') {
    next.setDate(next.getDate() + direction);
  } else if (mode === 'week') {
    next.setDate(next.getDate() + direction * 7);
  } else {
    next.setMonth(next.getMonth() + direction);
  }
  return next;
};

const getNavLabel = (mode: ViewMode, viewDate: Date): string => {
  if (mode === 'day') {
    return formatDateLabel(toLocalISO(viewDate));
  }
  if (mode === 'week') {
    const { startDate, endDate } = getDateRange('week', viewDate);
    return `${formatDateShort(startDate)} — ${formatDateShort(endDate)}`;
  }
  return `${MONTH_NAMES[viewDate.getMonth()]} ${viewDate.getFullYear()}`;
};


export const EmployeeSkudSection: FC<IEmployeeSkudSectionProps> = ({
  employeeId, onSync, focusDate, focusKey,
}) => {
  const [groups, setGroups] = useState<IDayGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<ViewMode>(focusDate ? 'day' : 'day');
  const [viewDate, setViewDate] = useState(() => {
    if (focusDate) {
      const [y, m, d] = focusDate.split('-').map(Number);
      return new Date(y, m - 1, d);
    }
    return new Date();
  });
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [internalPoints, setInternalPoints] = useState<Set<string>>(new Set());
  const prevFocusKey = useRef<number>(0);

  // Load internal point settings (org-level, без department_id)
  useEffect(() => {
    skudService.getAccessPointSettings().then(settings => {
      setInternalPoints(new Set(settings.filter(s => s.is_internal).map(s => s.access_point_name.trim())));
    }).catch(() => {});
  }, []);

  // React to focusDate from calendar click
  useEffect(() => {
    if (focusDate && focusKey !== undefined && focusKey !== prevFocusKey.current) {
      prevFocusKey.current = focusKey;
      setViewMode('day');
      const [fy, fm, fd] = focusDate.split('-').map(Number);
      setViewDate(new Date(fy, fm - 1, fd));
    }
  }, [focusDate, focusKey]);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    try {
      const { startDate, endDate } = getDateRange(viewMode, viewDate);
      const events = await skudService.getEmployeeEvents(employeeId, startDate, endDate);
      const grouped = groupByDay(events, internalPoints);
      setGroups(grouped);
      if (viewMode === 'day' && grouped.length > 0) {
        setExpandedDays(new Set([grouped[0].date]));
      }
    } catch {
      setGroups([]);
    } finally {
      setLoading(false);
    }
  }, [employeeId, viewMode, viewDate, internalPoints]);

  useEffect(() => { loadEvents(); }, [loadEvents]);

  const handleSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const { startDate, endDate } = getDateRange(viewMode, viewDate);
      const result = await skudService.syncEmployee(
        employeeId, startDate, endDate,
        (msg) => setSyncResult(msg),
      );
      setSyncResult(`Загружено ${result.inserted} новых событий (пропущено ${result.skipped})`);
      await loadEvents();
      if (result.inserted > 0) {
        onSync?.();
      }
    } catch {
      setSyncResult('Ошибка синхронизации');
    } finally {
      setSyncing(false);
    }
  };

  const toggleDay = (date: string) => {
    setExpandedDays(prev => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  };

  const goBack = () => setViewDate(d => navigateDate(viewMode, d, -1));
  const goForward = () => setViewDate(d => navigateDate(viewMode, d, 1));

  const allEvents = groups.flatMap(g => g.events).sort((a, b) => a.event_time.localeCompare(b.event_time));

  return (
    <div className="skud-section">
      {/* Navigation Bar */}
      <div className="skud-nav-bar">
        <div className="skud-view-selector">
          {(['day', 'week', 'month'] as ViewMode[]).map(m => (
            <button
              key={m}
              className={`skud-view-btn ${viewMode === m ? 'active' : ''}`}
              onClick={() => { setViewMode(m); setViewDate(new Date()); }}
            >
              {VIEW_LABELS[m]}
            </button>
          ))}
        </div>
        <div className="skud-date-nav">
          <button className="skud-nav-arrow" onClick={goBack}>
            <ChevronLeft size={16} />
          </button>
          <span className="skud-nav-label">{getNavLabel(viewMode, viewDate)}</span>
          <button className="skud-nav-arrow" onClick={goForward}>
            <ChevronRight size={16} />
          </button>
        </div>
        <button
          className="skud-period-btn skud-sync-btn"
          onClick={handleSync}
          disabled={syncing}
          title="Загрузить события из Сигур"
        >
          <RefreshCw size={14} className={syncing ? 'spinning' : ''} />
          {syncing ? 'Синхронизация...' : 'Из Сигур'}
        </button>
      </div>
      {syncResult && <div className="skud-sync-result">{syncResult}</div>}

      {loading ? (
        <div className="skud-loading">Загрузка событий СКУД...</div>
      ) : groups.length === 0 ? (
        <div className="card-history-empty">Нет событий СКУД за выбранный период</div>
      ) : viewMode === 'day' ? (
        /* Day view — table */
        <div className="skud-table-card">
          <div className="skud-table-header">
            <div>Время</div>
            <div>Событие</div>
            <div className="skud-col-point">Точка прохода</div>
          </div>
          {allEvents.map(ev => {
            const isInternal = ev.access_point ? internalPoints.has(ev.access_point) : false;
            return (
              <div
                key={ev.id}
                className={`skud-table-row ${isInternal ? 'internal' : ''}`}
              >
                <div className="skud-table-time">{formatTimeShort(ev.event_time)}</div>
                <div className="skud-table-event">
                  <span className={`skud-table-event-icon ${ev.direction === 'entry' ? 'in' : 'out'}`}>
                    {ev.direction === 'entry' ? <LogIn size={14} /> : <LogOut size={14} />}
                  </span>
                  {ev.direction === 'entry' ? 'Вход' : 'Выход'}
                </div>
                <div className="skud-col-point skud-table-point">{ev.access_point || '—'}</div>
              </div>
            );
          })}
          {/* Day summary */}
          {groups.length > 0 && (
            <div className="skud-day-summary-bar">
              {groups[0].firstEntry && (
                <span className="skud-time-badge entry">
                  <LogIn size={12} /> {formatTime(groups[0].firstEntry)}
                </span>
              )}
              {groups[0].lastExit && (
                <span className="skud-time-badge exit">
                  <LogOut size={12} /> {formatTime(groups[0].lastExit)}
                </span>
              )}
              {groups[0].spanSeconds > 0 && (
                <span className="skud-time-badge span">
                  <Clock size={12} /> {formatDuration(groups[0].spanSeconds)}
                </span>
              )}
              {groups[0].totalSeconds > 0 && (
                <span className="skud-time-badge duration">
                  <Timer size={12} /> {formatDuration(groups[0].totalSeconds)}
                </span>
              )}
            </div>
          )}
        </div>
      ) : (
        /* Week/Month view — expandable day cards */
        <div className="skud-days-list">
          {groups.map(group => {
            const expanded = expandedDays.has(group.date);
            const duration = formatDuration(group.totalSeconds);
            const span = formatDuration(group.spanSeconds);
            return (
              <div key={group.date} className="skud-day-card">
                <button className="skud-day-header" onClick={() => toggleDay(group.date)}>
                  <span className="skud-day-chevron">
                    {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </span>
                  <span className="skud-day-date">{formatDateLabel(group.date)}</span>
                  <span className="skud-day-summary">
                    {group.firstEntry && (
                      <span className="skud-time-badge entry">
                        <LogIn size={12} /> {formatTime(group.firstEntry)}
                      </span>
                    )}
                    {group.lastExit && (
                      <span className="skud-time-badge exit">
                        <LogOut size={12} /> {formatTime(group.lastExit)}
                      </span>
                    )}
                    {span && (
                      <span className="skud-time-badge span">
                        <Clock size={12} /> {span}
                      </span>
                    )}
                    {duration && (
                      <span className="skud-time-badge duration">
                        <Timer size={12} /> {duration}
                      </span>
                    )}
                    <span className="skud-events-count">{group.events.length} соб.</span>
                  </span>
                </button>

                {expanded && (
                  <div className="skud-day-events">
                    {group.events.map(ev => {
                      const isInternal = ev.access_point ? internalPoints.has(ev.access_point) : false;
                      return (
                        <div
                          key={ev.id}
                          className={`skud-event-row ${ev.direction || ''} ${isInternal ? 'internal' : ''}`}
                        >
                          <span className="skud-event-icon">
                            {ev.direction === 'entry' ? <LogIn size={14} /> : <LogOut size={14} />}
                          </span>
                          <span className="skud-event-time">
                            <Clock size={12} /> {formatTime(ev.event_time)}
                          </span>
                          <span className="skud-event-direction">
                            {ev.direction === 'entry' ? 'Вход' : 'Выход'}
                          </span>
                          {ev.access_point && (
                            <span className="skud-event-point">{ev.access_point}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
