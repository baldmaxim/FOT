import { useState, useEffect, useCallback, type FC } from 'react';
import { LogIn, LogOut, ChevronDown, ChevronRight, Clock, RefreshCw, Timer } from 'lucide-react';
import { skudService } from '../../services/skudService';
import type { SkudEvent } from '../../types';

interface IEmployeeSkudSectionProps {
  employeeId: number;
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
  totalMinutes: number;
  spanMinutes: number;
}

const formatDateLabel = (dateStr: string): string => {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
};

const formatTime = (time: string): string => time.slice(0, 5);

const formatDuration = (minutes: number): string => {
  if (minutes <= 0) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}м`;
  if (m === 0) return `${h}ч`;
  return `${h}ч ${m}м`;
};

const timeToMinutes = (time: string): number => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};

const calculateWorkMinutes = (events: SkudEvent[]): number => {
  const sorted = [...events].sort((a, b) => a.event_time.localeCompare(b.event_time));
  let total = 0;
  let entryTime: number | null = null;

  for (const ev of sorted) {
    if (ev.direction === 'entry') {
      if (entryTime === null) {
        entryTime = timeToMinutes(ev.event_time);
      }
    } else if (ev.direction === 'exit' && entryTime !== null) {
      total += timeToMinutes(ev.event_time) - entryTime;
      entryTime = null;
    }
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

const groupByDay = (events: SkudEvent[]): IDayGroup[] => {
  const map = new Map<string, SkudEvent[]>();
  for (const ev of events) {
    const key = ev.event_date;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(ev);
  }

  const groups: IDayGroup[] = [];
  for (const [date, dayEvents] of map) {
    dayEvents.sort((a, b) => a.event_time.localeCompare(b.event_time));
    const entries = dayEvents.filter(e => e.direction === 'entry');
    const exits = dayEvents.filter(e => e.direction === 'exit');
    groups.push({
      date,
      events: dayEvents,
      firstEntry: entries.length > 0 ? entries[0].event_time : null,
      lastExit: exits.length > 0 ? exits[exits.length - 1].event_time : null,
      totalMinutes: calculateWorkMinutes(dayEvents),
      spanMinutes: entries.length > 0 && exits.length > 0
        ? timeToMinutes(exits[exits.length - 1].event_time) - timeToMinutes(entries[0].event_time)
        : 0,
    });
  }

  groups.sort((a, b) => b.date.localeCompare(a.date));
  return groups;
};

export const EmployeeSkudSection: FC<IEmployeeSkudSectionProps> = ({ employeeId }) => {
  const [groups, setGroups] = useState<IDayGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());
  const [period, setPeriod] = useState<Period>('month');
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    try {
      const { startDate, endDate } = getDateRange(period);
      const events = await skudService.getEmployeeEvents(employeeId, startDate, endDate);
      setGroups(groupByDay(events));
    } catch {
      setGroups([]);
    } finally {
      setLoading(false);
    }
  }, [employeeId, period]);

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
      if (result.inserted > 0) await loadEvents();
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

  if (loading) {
    return <div className="skud-loading">Загрузка событий СКУД...</div>;
  }

  if (groups.length === 0) {
    return <div className="card-history-empty">{EMPTY_LABELS[period]}</div>;
  }

  return (
    <div className="skud-section">
      <div className="skud-period-selector">
        {(['today', 'week', 'month'] as Period[]).map(p => (
          <button
            key={p}
            className={`skud-period-btn ${period === p ? 'active' : ''}`}
            onClick={() => setPeriod(p)}
          >
            {PERIOD_LABELS[p]}
          </button>
        ))}
        <button
          className="skud-period-btn skud-sync-btn"
          onClick={handleSync}
          disabled={syncing}
          title="Загрузить события из Сигур"
        >
          <RefreshCw size={14} className={syncing ? 'spinning' : ''} /> {syncing ? 'Синхронизация...' : 'Из Сигур'}
        </button>
      </div>
      {syncResult && <div className="skud-sync-result">{syncResult}</div>}

      <div className="skud-days-list">
        {groups.map(group => {
          const expanded = expandedDays.has(group.date);
          const duration = formatDuration(group.totalMinutes);
          const span = formatDuration(group.spanMinutes);
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
                  {group.events.map(ev => (
                    <div key={ev.id} className={`skud-event-row ${ev.direction || ''}`}>
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
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
