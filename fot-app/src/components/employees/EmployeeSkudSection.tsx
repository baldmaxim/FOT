import { useState, useEffect, useCallback, useRef, type FC } from 'react';
import { LogIn, LogOut, ChevronDown, ChevronRight, Clock, RefreshCw, Timer, X } from 'lucide-react';
import { skudService } from '../../services/skudService';
import type { SkudEvent } from '../../types';

interface IEmployeeSkudSectionProps {
  employeeId: number;
  departmentId?: string;
  onSync?: () => void;
  focusDate?: string | null;
  focusKey?: number;
}

type Period = 'today' | 'week' | 'month';

const PERIOD_LABELS: Record<Period, string> = {
  today: 'Сегодня',
  week: 'Неделя',
  month: 'Месяц',
};

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

const formatTime = (time: string): string => time.slice(0, 8);

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

const isToday = (dateStr: string): boolean => {
  const now = new Date();
  return dateStr === now.toISOString().slice(0, 10);
};

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
      if (entryTime === null) {
        entryTime = timeToSeconds(ev.event_time);
      }
    } else if (ev.direction === 'exit' && entryTime !== null) {
      total += timeToSeconds(ev.event_time) - entryTime;
      entryTime = null;
    }
  }

  // Если последний вход без выхода и это сегодня — считаем до текущего момента
  if (entryTime !== null && dateStr && isToday(dateStr)) {
    total += nowSeconds() - entryTime;
  }

  return total;
};

const getDateRange = (period: Period): { startDate: string; endDate: string } => {
  const now = new Date();
  const endDate = now.toISOString().slice(0, 10);

  if (period === 'today') {
    return { startDate: endDate, endDate };
  }

  if (period === 'week') {
    const start = new Date(now);
    start.setDate(start.getDate() - 6);
    return { startDate: start.toISOString().slice(0, 10), endDate };
  }

  // month — с 1-го числа текущего месяца
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return { startDate: start.toISOString().slice(0, 10), endDate };
};

const EMPTY_LABELS: Record<Period, string> = {
  today: 'Нет событий СКУД за сегодня',
  week: 'Нет событий СКУД за неделю',
  month: 'Нет событий СКУД за текущий месяц',
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
    // Для расчётов summary — фильтруем внутренние точки
    const extEvents = dayEvents.filter(e => !e.access_point || !internalPoints.has(e.access_point));
    const entries = extEvents.filter(e => e.direction === 'entry');
    const exits = extEvents.filter(e => e.direction === 'exit');

    // Определяем последнее внешнее событие
    const lastExtEvent = extEvents.length > 0 ? extEvents[extEvents.length - 1] : null;
    const stillOnSite = lastExtEvent?.direction === 'entry' && isToday(date);

    // Если человек ещё на объекте (сегодня, последний вход без выхода) — span до текущего момента
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

export const EmployeeSkudSection: FC<IEmployeeSkudSectionProps> = ({ employeeId, departmentId, onSync, focusDate, focusKey }) => {
  const [groups, setGroups] = useState<IDayGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());
  const [period, setPeriod] = useState<Period>('today');
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [internalPoints, setInternalPoints] = useState<Set<string>>(new Set());
  const [customDate, setCustomDate] = useState<string | null>(null);
  const prevFocusKey = useRef<number>(0);

  // Загружаем настройки внутренних точек
  useEffect(() => {
    if (!departmentId) {
      setInternalPoints(new Set());
      return;
    }
    skudService.getAccessPointSettings(departmentId).then(settings => {
      const pts = new Set<string>();
      for (const s of settings) {
        if (s.is_internal) pts.add(s.access_point_name);
      }
      setInternalPoints(pts);
    }).catch(() => {});
  }, [departmentId]);

  // React to focusDate from calendar click
  useEffect(() => {
    if (focusDate && focusKey !== undefined && focusKey !== prevFocusKey.current) {
      prevFocusKey.current = focusKey;
      setCustomDate(focusDate);
    }
  }, [focusDate, focusKey]);

  const handlePeriodChange = (p: Period) => {
    setCustomDate(null);
    setPeriod(p);
  };

  const loadEvents = useCallback(async () => {
    setLoading(true);
    try {
      let startDate: string, endDate: string;
      if (customDate) {
        startDate = customDate;
        endDate = customDate;
      } else {
        ({ startDate, endDate } = getDateRange(period));
      }
      const events = await skudService.getEmployeeEvents(employeeId, startDate, endDate);
      setGroups(groupByDay(events, internalPoints));
      if (customDate) {
        setExpandedDays(new Set([customDate]));
      }
    } catch {
      setGroups([]);
    } finally {
      setLoading(false);
    }
  }, [employeeId, period, internalPoints, customDate]);

  useEffect(() => { loadEvents(); }, [loadEvents]);

  const handleSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const { startDate, endDate } = getDateRange(period);
      const result = await skudService.syncEmployee(
        employeeId,
        startDate,
        endDate,
        (msg) => setSyncResult(msg),
      );
      setSyncResult(`Загружено ${result.inserted} новых событий (пропущено ${result.skipped})`);
      if (result.inserted > 0) {
        await loadEvents();
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

  const emptyLabel = customDate
    ? `Нет событий СКУД за ${formatDateLabel(customDate)}`
    : EMPTY_LABELS[period];

  return (
    <div className="skud-section">
      <div className="skud-period-selector">
        {(['today', 'week', 'month'] as Period[]).map(p => (
          <button
            key={p}
            className={`skud-period-btn ${!customDate && period === p ? 'active' : ''}`}
            onClick={() => handlePeriodChange(p)}
          >
            {PERIOD_LABELS[p]}
          </button>
        ))}
        {customDate && (
          <button
            className="skud-period-btn active skud-custom-date-btn"
            onClick={() => setCustomDate(null)}
          >
            {formatDateLabel(customDate)} <X size={12} />
          </button>
        )}
        <button
          className="skud-period-btn skud-sync-btn"
          onClick={handleSync}
          disabled={syncing || !!customDate}
          title="Загрузить события из Сигур"
        >
          <RefreshCw size={14} className={syncing ? 'spinning' : ''} /> {syncing ? 'Синхронизация...' : 'Из Сигур'}
        </button>
      </div>
      {syncResult && <div className="skud-sync-result">{syncResult}</div>}

      {loading ? (
        <div className="skud-loading">Загрузка событий СКУД...</div>
      ) : groups.length === 0 ? (
        <div className="card-history-empty">{emptyLabel}</div>
      ) : (
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
