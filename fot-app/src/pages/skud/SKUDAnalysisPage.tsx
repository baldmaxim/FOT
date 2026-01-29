import React, { useState, useEffect, useCallback } from 'react';
import { BarChart3, ChevronLeft, ChevronRight, Clock, LogIn, LogOut, MapPin } from 'lucide-react';
import { skudService } from '../../services/skudService';
import { employeeService } from '../../services/employeeService';
import type { Employee, SkudEvent } from '../../types';
import '../../styles/SKUDAnalysisPage.css';

interface EmployeeWithStats extends Employee {
  totalDays: number;
  totalHours: number;
  avgHours: number;
}

interface DayEvents {
  date: string;
  dayOfWeek: string;
  events: SkudEvent[];
  totalHours: number | null;
  firstEntry: string | null;
  lastExit: string | null;
}

export const SKUDAnalysisPage: React.FC = () => {
  const [employees, setEmployees] = useState<EmployeeWithStats[]>([]);
  const [selectedEmployee, setSelectedEmployee] = useState<EmployeeWithStats | null>(null);
  const [events, setEvents] = useState<SkudEvent[]>([]);
  const [currentDate, setCurrentDate] = useState(new Date());
  const [loading, setLoading] = useState(true);
  const [loadingEvents, setLoadingEvents] = useState(false);

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const monthName = currentDate.toLocaleDateString('ru-RU', {
    month: 'long',
    year: 'numeric'
  });

  const weekDays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [employeesData, summaryData] = await Promise.all([
        employeeService.getAll(),
        skudService.getDailySummary(`${year}-${String(month + 1).padStart(2, '0')}-01`)
      ]);

      const activeEmployees = employeesData.filter(e => !e.is_archived);

      const employeesWithStats: EmployeeWithStats[] = activeEmployees.map(emp => {
        const empSummaries = summaryData.filter(s => s.employee_id === emp.id);
        const totalDays = empSummaries.length;
        const totalHours = empSummaries.reduce((sum, s) => sum + (s.total_hours || 0), 0);
        const avgHours = totalDays > 0 ? totalHours / totalDays : 0;

        return { ...emp, totalDays, totalHours, avgHours };
      });

      // Сортируем по количеству дней (больше дней — выше)
      employeesWithStats.sort((a, b) => b.totalDays - a.totalDays);

      setEmployees(employeesWithStats);

      if (employeesWithStats.length > 0 && !selectedEmployee) {
        setSelectedEmployee(employeesWithStats[0]);
      }
    } catch {
      // Error loading data
    } finally {
      setLoading(false);
    }
  }, [year, month, selectedEmployee]);

  const loadEmployeeEvents = useCallback(async (employeeId: number) => {
    setLoadingEvents(true);
    try {
      const startDate = `${year}-${String(month + 1).padStart(2, '0')}-01`;
      const endDate = `${year}-${String(month + 1).padStart(2, '0')}-${daysInMonth}`;

      const data = await skudService.getEvents({
        startDate,
        endDate,
        employeeId: String(employeeId)
      });

      setEvents(data);
    } catch {
      // Error loading events
    } finally {
      setLoadingEvents(false);
    }
  }, [year, month, daysInMonth]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (selectedEmployee) {
      loadEmployeeEvents(selectedEmployee.id);
    }
  }, [selectedEmployee, loadEmployeeEvents]);

  const prevMonth = () => {
    setCurrentDate(new Date(year, month - 1, 1));
  };

  const nextMonth = () => {
    setCurrentDate(new Date(year, month + 1, 1));
  };

  const formatHours = (hours: number | null) => {
    if (!hours) return '—';
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return `${h}:${String(m).padStart(2, '0')}`;
  };

  const formatTime = (time: string | null) => {
    if (!time) return '—';
    return time.slice(0, 5);
  };

  // Группируем события по дням
  const groupEventsByDay = (): DayEvents[] => {
    const grouped: { [date: string]: SkudEvent[] } = {};

    events.forEach(event => {
      if (!grouped[event.event_date]) {
        grouped[event.event_date] = [];
      }
      grouped[event.event_date].push(event);
    });

    const days: DayEvents[] = Object.entries(grouped)
      .map(([date, dayEvents]) => {
        const dateObj = new Date(date);
        const dayOfWeek = dateObj.toLocaleDateString('ru-RU', { weekday: 'short' });

        // Сортируем события по времени
        dayEvents.sort((a, b) => a.event_time.localeCompare(b.event_time));

        const entries = dayEvents.filter(e => e.direction === 'entry');
        const exits = dayEvents.filter(e => e.direction !== 'entry'); // всё кроме entry = exit

        const firstEntry = entries.length > 0 ? entries[0].event_time : null;
        const lastExit = exits.length > 0 ? exits[exits.length - 1].event_time : null;

        let totalHours: number | null = null;
        if (firstEntry && lastExit && lastExit > firstEntry) {
          const [h1, m1] = firstEntry.split(':').map(Number);
          const [h2, m2] = lastExit.split(':').map(Number);
          totalHours = (h2 * 60 + m2 - h1 * 60 - m1) / 60;
        }

        return { date, dayOfWeek, events: dayEvents, totalHours, firstEntry, lastExit };
      })
      .sort((a, b) => b.date.localeCompare(a.date)); // Новые сверху

    return days;
  };

  // Генерация мини-календаря
  const generateCalendar = () => {
    const firstDay = new Date(year, month, 1).getDay();
    const offset = firstDay === 0 ? 6 : firstDay - 1; // Понедельник = 0

    const daysWithEvents = new Set(events.map(e => parseInt(e.event_date.split('-')[2])));

    const cells: { day: number | null; isWeekend: boolean; hasEvents: boolean }[] = [];

    // Пустые ячейки в начале
    for (let i = 0; i < offset; i++) {
      cells.push({ day: null, isWeekend: false, hasEvents: false });
    }

    // Дни месяца
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(year, month, day);
      const dayOfWeek = date.getDay();
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
      const hasEvents = daysWithEvents.has(day);
      cells.push({ day, isWeekend, hasEvents });
    }

    return cells;
  };

  const dayEvents = groupEventsByDay();
  const calendarCells = generateCalendar();

  if (loading) {
    return (
      <div className="modal-overlay">
        <div className="loading-spinner">
          <div className="spinner"></div>
          <p>Загрузка данных...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="skud-analysis-page">
      <div className="skud-analysis-header">
        <div className="skud-analysis-title">
          <BarChart3 size={24} />
          <h1>Анализ СКУД</h1>
        </div>
        <div className="skud-analysis-controls">
          <button onClick={prevMonth} className="btn-month-nav">
            <ChevronLeft size={18} />
          </button>
          <h2>{monthName}</h2>
          <button onClick={nextMonth} className="btn-month-nav">
            <ChevronRight size={18} />
          </button>
        </div>
      </div>

      <div className="skud-analysis-content">
        {/* Левая панель: список сотрудников */}
        <div className="skud-analysis-employees">
          <div className="employees-list-header">
            <span>Сотрудники</span>
            <span className="employees-count">{employees.length}</span>
          </div>
          <div className="employees-list">
            {employees.map(emp => (
              <div
                key={emp.id}
                className={`employee-card ${selectedEmployee?.id === emp.id ? 'selected' : ''}`}
                onClick={() => setSelectedEmployee(emp)}
              >
                <div className="employee-card-info">
                  <span className="employee-card-name">{emp.full_name}</span>
                  <span className="employee-card-position">{emp.position}</span>
                </div>
                <div className="employee-card-stats">
                  {emp.totalDays > 0 ? (
                    <>
                      <span className="stat-badge">{emp.totalDays} дн.</span>
                      <span className="stat-badge">{formatHours(emp.avgHours)} ср.</span>
                    </>
                  ) : (
                    <span className="stat-badge empty">нет данных</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Правая панель: детали сотрудника */}
        <div className="skud-analysis-detail">
          {selectedEmployee ? (
            <>
              <div className="detail-header">
                <div className="detail-employee-info">
                  <h3>{selectedEmployee.full_name}</h3>
                  <span className="detail-position">{selectedEmployee.position}</span>
                </div>
                <div className="detail-stats">
                  <div className="detail-stat">
                    <span className="stat-value">{selectedEmployee.totalDays}</span>
                    <span className="stat-label">дней</span>
                  </div>
                  <div className="detail-stat">
                    <span className="stat-value">{formatHours(selectedEmployee.totalHours)}</span>
                    <span className="stat-label">часов</span>
                  </div>
                  <div className="detail-stat">
                    <span className="stat-value">{formatHours(selectedEmployee.avgHours)}</span>
                    <span className="stat-label">среднее</span>
                  </div>
                </div>
              </div>

              {/* Мини-календарь */}
              <div className="mini-calendar">
                <div className="mini-calendar-weekdays">
                  {weekDays.map(day => (
                    <span key={day}>{day}</span>
                  ))}
                </div>
                <div className="mini-calendar-days">
                  {calendarCells.map((cell, idx) => (
                    <div
                      key={idx}
                      className={`mini-calendar-day ${
                        cell.day === null ? 'empty' : ''
                      } ${cell.isWeekend ? 'weekend' : ''} ${
                        cell.hasEvents ? 'has-events' : ''
                      }`}
                    >
                      {cell.day}
                    </div>
                  ))}
                </div>
              </div>

              {/* Список событий по дням */}
              <div className="events-list">
                <div className="events-list-header">
                  <span>События за месяц</span>
                </div>

                {loadingEvents ? (
                  <div className="events-loading">
                    <div className="spinner small"></div>
                  </div>
                ) : dayEvents.length === 0 ? (
                  <div className="events-empty">
                    Нет событий за выбранный период
                  </div>
                ) : (
                  <div className="events-days">
                    {dayEvents.map(day => {
                      const dateObj = new Date(day.date);
                      const isWeekend = dateObj.getDay() === 0 || dateObj.getDay() === 6;

                      return (
                        <div key={day.date} className={`day-group ${isWeekend ? 'weekend' : ''}`}>
                          <div className="day-header">
                            <div className="day-date">
                              <span className="day-number">{dateObj.getDate()}</span>
                              <span className="day-name">{day.dayOfWeek}</span>
                            </div>
                            <div className="day-summary">
                              {day.firstEntry && (
                                <span className="time-badge entry">
                                  <LogIn size={12} />
                                  {formatTime(day.firstEntry)}
                                </span>
                              )}
                              {day.lastExit && (
                                <span className="time-badge exit">
                                  <LogOut size={12} />
                                  {formatTime(day.lastExit)}
                                </span>
                              )}
                              {day.totalHours && (
                                <span className="time-badge total">
                                  <Clock size={12} />
                                  {formatHours(day.totalHours)}
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="day-events">
                            {day.events.map((event, idx) => {
                              // Вычисляем время до следующего события (если текущее - выход, следующее - вход)
                              // direction: 'entry' = вход, всё остальное (включая null) = выход
                              const isExit = event.direction !== 'entry';
                              let gapTime: string | null = null;
                              if (isExit && idx < day.events.length - 1) {
                                const nextEvent = day.events[idx + 1];
                                if (nextEvent.direction === 'entry') {
                                  const [h1, m1] = event.event_time.split(':').map(Number);
                                  const [h2, m2] = nextEvent.event_time.split(':').map(Number);
                                  const diffMinutes = (h2 * 60 + m2) - (h1 * 60 + m1);
                                  if (diffMinutes > 0) {
                                    const hours = Math.floor(diffMinutes / 60);
                                    const mins = diffMinutes % 60;
                                    gapTime = hours > 0
                                      ? `${hours}ч ${mins}м`
                                      : `${mins}м`;
                                  }
                                }
                              }

                              return (
                                <div key={idx} className="event-row-wrapper">
                                  <div className="event-row">
                                    <span className="event-time">{formatTime(event.event_time)}</span>
                                    <span className={`event-direction ${event.direction === 'entry' ? 'entry' : 'exit'}`}>
                                      {event.direction === 'entry' ? 'вход' : 'выход'}
                                    </span>
                                    {event.access_point && (
                                      <span className="event-location">
                                        <MapPin size={12} />
                                        {event.access_point}
                                      </span>
                                    )}
                                  </div>
                                  {gapTime && (
                                    <div className="event-gap">
                                      <span className="gap-line"></span>
                                      <span className="gap-time">{gapTime}</span>
                                      <span className="gap-line"></span>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="detail-placeholder">
              Выберите сотрудника из списка
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
