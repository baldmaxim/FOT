import { type FC, useMemo } from 'react';
import type { TimesheetEntry, TimesheetEmployee, TimesheetStatus } from '../../types';
import type { IResolvedSchedule } from '../../types/schedule';
import type { IProductionCalendarMonth } from '../../types/timesheet';
import {
  getDaysInMonth,
  isWeekend,
  getWeekdayShort,
  isToday,
  isFutureDay,
} from '../../utils/calendarUtils';
import {
  getScheduleForTimesheetDay,
  getWorkHoursForDay,
  getFullDayThresholdHoursForDay,
  isScheduleDayOff,
} from '../../utils/scheduleUtils';

interface ITimesheetGridProps {
  employees: TimesheetEmployee[];
  entries: TimesheetEntry[];
  year: number;
  month: number;
  schedules?: Record<number, IResolvedSchedule>;
  dailySchedules?: Record<number, Record<string, IResolvedSchedule>>;
  calendar?: IProductionCalendarMonth | null;
  compact?: boolean;
  onEmployeeClick: (employee: TimesheetEmployee) => void;
  onDayClick: (employee: TimesheetEmployee, day: number, entry: TimesheetEntry | null) => void;
}

interface IRowData {
  employee: TimesheetEmployee;
  days: Map<number, TimesheetEntry>;
  factHours: number;
  normHours: number;
}

/** Format decimal hours to "Xч Yм" */
const formatHM = (decimal: number): string => {
  const h = Math.floor(decimal);
  const m = Math.round((decimal - h) * 60);
  if (m === 0) return `${h}ч`;
  return `${h}ч${m}м`;
};

/** Short format for day cells: "X:MM" */
const formatCellHM = (decimal: number): string => {
  const h = Math.floor(decimal);
  const m = Math.round((decimal - h) * 60);
  if (m === 0) return `${h}`;
  return `${h}:${String(m).padStart(2, '0')}`;
};

const STATUS_CELL_TEXT: Record<TimesheetStatus, string> = {
  work: '',
  sick: 'Б',
  vacation: 'О',
  absent: 'Н',
  business_trip: 'К',
  dayoff: 'В',
  remote: 'У',
  unpaid: 'НО',
  manual: '',
};

const abbreviateName = (fullName: string): string => {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return fullName;
  return `${parts[0]} ${parts.slice(1).map(p => p[0] ? p[0] + '.' : '').join('')}`;
};

const getDayCellClass = (entry: TimesheetEntry | null, weekend: boolean, today: boolean, future: boolean, thresholdHours = 8): string => {
  const classes = ['ts-day'];
  if (today) classes.push('ts-day--today');
  if (weekend && !entry) {
    classes.push('ts-day--weekend');
    return classes.join(' ');
  }
  if (!entry) {
    if (future) classes.push('ts-day--empty');
    return classes.join(' ');
  }
  switch (entry.status) {
    case 'work':
    case 'manual':
      if (entry.hours_worked && entry.hours_worked >= thresholdHours) classes.push('ts-day--full');
      else classes.push('ts-day--partial');
      break;
    case 'remote':
      classes.push('ts-day--remote');
      break;
    case 'sick':
      classes.push('ts-day--sick');
      break;
    case 'vacation':
    case 'dayoff':
      classes.push('ts-day--vacation');
      break;
    case 'absent':
      classes.push('ts-day--absent');
      break;
    case 'business_trip':
      classes.push('ts-day--trip');
      break;
  }
  if (entry.is_correction) classes.push('ts-day--corrected');
  if ((entry.travel_problematic_segments || 0) > 0 || (entry.travel_delay_minutes || 0) > 0) {
    classes.push('ts-day--travel-issue');
  } else if ((entry.travel_minutes_credited || 0) > 0) {
    classes.push('ts-day--travel');
  }
  return classes.join(' ');
};

const getDayCellText = (entry: TimesheetEntry | null, weekend: boolean): string => {
  if (weekend && !entry) return '—';
  if (!entry) return '';
  const special = STATUS_CELL_TEXT[entry.status];
  if (special) return special;
  if (entry.hours_worked != null) return formatCellHM(entry.hours_worked);
  return '';
};

const getDayCellTitle = (entry: TimesheetEntry | null, weekend: boolean): string | undefined => {
  if (weekend && !entry) return 'Выходной';
  if (!entry) return undefined;

  const parts: string[] = [];
  if (entry.hours_worked != null) {
    parts.push(`Часы: ${formatHM(entry.hours_worked)}`);
  }
  if ((entry.travel_minutes_credited || 0) > 0) {
    parts.push(`Учтено время в дороге: ${formatHM((entry.travel_minutes_credited || 0) / 60)}`);
  }
  if ((entry.travel_delay_minutes || 0) > 0) {
    parts.push(`Задержка в дороге: ${formatHM((entry.travel_delay_minutes || 0) / 60)}`);
  }
  if ((entry.travel_problematic_segments || 0) > 0) {
    parts.push(`Проблемных дорожных сегментов: ${entry.travel_problematic_segments}`);
  }
  if (entry.is_correction) {
    parts.push('Есть корректировка');
  }

  return parts.length > 0 ? parts.join(' • ') : undefined;
};

export const TimesheetGrid: FC<ITimesheetGridProps> = ({
  employees,
  entries,
  year,
  month,
  schedules = {},
  dailySchedules = {},
  calendar = null,
  compact = false,
  onEmployeeClick,
  onDayClick,
}) => {
  const daysCount = getDaysInMonth(year, month);
  const days = Array.from({ length: daysCount }, (_, i) => i + 1);
  const rows: IRowData[] = useMemo(() => {
    const dc = getDaysInMonth(year, month);
    const entryMap = new Map<string, TimesheetEntry>();
    for (const entry of entries) {
      entryMap.set(`${entry.employee_id}_${entry.work_date}`, entry);
    }

    const now = new Date();
    const todayDate = now.getDate();
    const isCurrentMonth = now.getFullYear() === year && now.getMonth() + 1 === month;

    return employees.map(emp => {
      const dayMap = new Map<number, TimesheetEntry>();
      let factHours = 0;
      let normHours = 0;

      for (let d = 1; d <= dc; d++) {
        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const entry = entryMap.get(`${emp.id}_${dateStr}`);
        if (entry) {
          dayMap.set(d, entry);
          if (entry.hours_worked) factHours += entry.hours_worked;
        }

        // Считаем норму часов до сегодня с учётом day_overrides
        const sched = getScheduleForTimesheetDay(schedules, dailySchedules, emp.id, year, month, d);
        const dayOff = isScheduleDayOff(sched, calendar, year, month, d);
        const isPast = !isCurrentMonth || d <= todayDate;
        if (!dayOff && isPast) {
          normHours += getWorkHoursForDay(sched, year, month, d);
        }
      }

      return { employee: emp, days: dayMap, factHours, normHours };
    });
  }, [employees, entries, year, month, schedules, dailySchedules, calendar]);

  if (compact) {
    return (
      <div className="ts-table-container">
        <div className="ts-table-header-bar">
          <h3 className="ts-table-title">Табель учёта рабочего времени</h3>
        </div>

        <div className="ts-mobile-list">
          {rows.map(row => {
            const diff = row.factHours - row.normHours;
            const hasVacation = Array.from(row.days.values()).some(e => e.status === 'vacation');

            return (
              <article key={row.employee.id} className="ts-mobile-card">
                <button
                  type="button"
                  className="ts-mobile-card-header"
                  onClick={() => onEmployeeClick(row.employee)}
                >
                  <div className="ts-mobile-card-meta">
                    <div className="ts-mobile-card-name">{row.employee.full_name}</div>
                    <div className="ts-mobile-card-role">{row.employee.position_name || '—'}</div>
                  </div>
                  <div className="ts-mobile-summary">
                    <span className="ts-mobile-summary-chip">Факт {formatHM(row.factHours)}</span>
                    <span className="ts-mobile-summary-chip">Норма {formatHM(row.normHours)}</span>
                    <span
                      className={`ts-mobile-summary-chip ${
                        hasVacation && row.factHours === 0
                          ? ''
                          : diff >= 0
                            ? 'ts-mobile-summary-chip--positive'
                            : 'ts-mobile-summary-chip--negative'
                      }`}
                    >
                      {hasVacation && row.factHours === 0
                        ? 'Отпуск'
                        : `${diff >= 0 ? '+' : '−'}${formatHM(Math.abs(diff))}`}
                    </span>
                  </div>
                </button>

                <div className="ts-mobile-days">
                  {days.map(d => {
                    const sched = getScheduleForTimesheetDay(schedules, dailySchedules, row.employee.id, year, month, d);
                    const dayOff = isScheduleDayOff(sched, calendar, year, month, d);
                    const today = isToday(year, month, d);
                    const future = isFutureDay(year, month, d);
                    const entry = row.days.get(d) || null;
                    const thresholdHours = getFullDayThresholdHoursForDay(sched, calendar, year, month, d);
                    const cls = getDayCellClass(entry, dayOff, today, future, thresholdHours);
                    const text = getDayCellText(entry, dayOff);
                    const title = getDayCellTitle(entry, dayOff);

                    return (
                      <button
                        key={d}
                        type="button"
                        className={`${cls} ts-mobile-day-btn`}
                        title={title}
                        onClick={() => onDayClick(row.employee, d, entry)}
                      >
                        <span className="ts-mobile-day-head">
                          <span className="ts-mobile-day-num">{d}</span>
                          <span className="ts-mobile-day-weekday">{getWeekdayShort(year, month, d)}</span>
                        </span>
                        <span className="ts-mobile-day-value">{text || '·'}</span>
                      </button>
                    );
                  })}
                </div>
              </article>
            );
          })}

          {rows.length === 0 && (
            <div className="ts-mobile-empty">Нет сотрудников для отображения</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="ts-table-container">
      <div className="ts-table-header-bar">
        <h3 className="ts-table-title">Табель учёта рабочего времени</h3>
        <div className="ts-legend">
          <div className="ts-legend-item">
            <span className="ts-legend-dot ts-legend-dot--full">8</span>Полный день
          </div>
          <div className="ts-legend-item">
            <span className="ts-legend-dot ts-legend-dot--partial">7</span>Неполный
          </div>
          <div className="ts-legend-item">
            <span className="ts-legend-dot ts-legend-dot--sick">Б</span>Больничный
          </div>
          <div className="ts-legend-item">
            <span className="ts-legend-dot ts-legend-dot--vacation">О</span>Отпуск
          </div>
          <div className="ts-legend-item">
            <span className="ts-legend-dot ts-legend-dot--remote">У</span>Удалёнка
          </div>
          <div className="ts-legend-item">
            <span className="ts-legend-dot ts-legend-dot--absent">Н</span>Неявка
          </div>
          <div className="ts-legend-item">
            <span className="ts-legend-dot ts-legend-dot--weekend">—</span>Выходной
          </div>
          <div className="ts-legend-item">
            <span className="ts-legend-dot ts-legend-dot--corrected">К</span>Корректировка
          </div>
          <div className="ts-legend-item">
            <span className="ts-legend-dot ts-legend-dot--travel">↔</span>Учтено время в дороге
          </div>
          <div className="ts-legend-item">
            <span className="ts-legend-dot ts-legend-dot--travel-issue">!</span>Проблема в дороге
          </div>
        </div>
      </div>

      <div className="ts-table-scroll">
        <table className="ts-table">
          <thead>
            <tr>
              <th className="ts-col-sticky">Сотрудник</th>
              {days.map(d => {
                const weekend = isWeekend(year, month, d);
                const today = isToday(year, month, d);
                let cls = '';
                if (today) cls = 'ts-th--today';
                else if (weekend) cls = 'ts-th--weekend';
                return (
                  <th key={d} className={cls}>
                    {d}<br />
                    <span style={{ fontWeight: 400 }}>{getWeekdayShort(year, month, d)}</span>
                  </th>
                );
              })}
              <th>Факт</th>
              <th>Норма</th>
              <th>+/−</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => {
              const diff = row.factHours - row.normHours;
              const hasVacation = Array.from(row.days.values()).some(e => e.status === 'vacation');

              return (
                <tr key={row.employee.id}>
                  <td
                    className="ts-col-sticky ts-employee-cell"
                    onClick={() => onEmployeeClick(row.employee)}
                  >
                    <div className="ts-employee-name" title={row.employee.full_name}>
                      {compact ? abbreviateName(row.employee.full_name) : row.employee.full_name}
                    </div>
                    {!compact && <div className="ts-employee-role">{row.employee.position_name || '—'}</div>}
                  </td>
                  {days.map(d => {
                    const sched = getScheduleForTimesheetDay(schedules, dailySchedules, row.employee.id, year, month, d);
                    const dayOff = isScheduleDayOff(sched, calendar, year, month, d);
                    const today = isToday(year, month, d);
                    const future = isFutureDay(year, month, d);
                    const entry = row.days.get(d) || null;
                    const thresholdHours = getFullDayThresholdHoursForDay(sched, calendar, year, month, d);
                    const cls = getDayCellClass(entry, dayOff, today, future, thresholdHours);
                    const text = getDayCellText(entry, dayOff);
                    const title = getDayCellTitle(entry, dayOff);

                    return (
                      <td
                        key={d}
                        className={cls}
                        title={title}
                        onClick={() => onDayClick(row.employee, d, entry)}
                      >
                        {text}
                      </td>
                    );
                  })}
                  <td className="ts-summary ts-summary--total">{formatHM(row.factHours)}</td>
                  <td className="ts-summary">{formatHM(row.normHours)}</td>
                  <td className={`ts-summary ${hasVacation && row.factHours === 0 ? '' : diff >= 0 ? 'ts-summary--positive' : 'ts-summary--negative'}`}>
                    {hasVacation && row.factHours === 0
                      ? 'отпуск'
                      : `${diff >= 0 ? '+' : '−'}${formatHM(Math.abs(diff))}`
                    }
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={daysCount + 4} className="ts-loading">
                  Нет сотрудников для отображения
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
