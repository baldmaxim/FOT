import { useState, useEffect, type FC } from 'react';
import { LogIn, LogOut, ChevronDown, ChevronRight, Clock } from 'lucide-react';
import { skudService } from '../../services/skudService';
import type { SkudEvent } from '../../types';

interface IEmployeeSkudSectionProps {
  employeeId: number;
}

interface IDayGroup {
  date: string;
  events: SkudEvent[];
  firstEntry: string | null;
  lastExit: string | null;
}

const formatDateLabel = (dateStr: string): string => {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
};

const formatTime = (time: string): string => time.slice(0, 5);

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
    });
  }

  groups.sort((a, b) => b.date.localeCompare(a.date));
  return groups;
};

export const EmployeeSkudSection: FC<IEmployeeSkudSectionProps> = ({ employeeId }) => {
  const [groups, setGroups] = useState<IDayGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());
  const [daysToShow, setDaysToShow] = useState(30);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const now = new Date();
        const startDate = new Date(now);
        startDate.setDate(startDate.getDate() - daysToShow);
        const events = await skudService.getEvents({
          employeeId: String(employeeId),
          startDate: startDate.toISOString().slice(0, 10),
          endDate: now.toISOString().slice(0, 10),
        });
        setGroups(groupByDay(events));
      } catch {
        setGroups([]);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [employeeId, daysToShow]);

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
    return <div className="card-history-empty">Нет событий СКУД за последние {daysToShow} дней</div>;
  }

  return (
    <div className="skud-section">
      <div className="skud-period-selector">
        {[7, 14, 30, 90].map(d => (
          <button
            key={d}
            className={`skud-period-btn ${daysToShow === d ? 'active' : ''}`}
            onClick={() => setDaysToShow(d)}
          >
            {d} дн.
          </button>
        ))}
      </div>

      <div className="skud-days-list">
        {groups.map(group => {
          const expanded = expandedDays.has(group.date);
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
