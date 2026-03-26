import { type FC, useMemo } from 'react';
import type { TimesheetEntry, TimesheetEmployee, TimesheetStatus } from '../../types';
import {
  getDaysInMonth,
  isWeekend,
  getWeekdayShort,
  isToday,
  isFutureDay,
  getWorkingDaysUpToToday,
} from '../../utils/calendarUtils';

interface ITimesheetGridProps {
  employees: TimesheetEmployee[];
  entries: TimesheetEntry[];
  year: number;
  month: number;
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

const getDayCellClass = (entry: TimesheetEntry | null, weekend: boolean, today: boolean, future: boolean): string => {
  const classes = ['ts-day'];
  if (today) classes.push('ts-day--today');
  if (weekend) {
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
    case 'remote':
      if (entry.hours_worked && entry.hours_worked >= 8) classes.push('ts-day--full');
      else classes.push('ts-day--partial');
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
  return classes.join(' ');
};

const getDayCellText = (entry: TimesheetEntry | null, weekend: boolean): string => {
  if (weekend) return '—';
  if (!entry) return '';
  const special = STATUS_CELL_TEXT[entry.status];
  if (special) return special;
  if (entry.hours_worked != null) return formatCellHM(entry.hours_worked);
  return '';
};

export const TimesheetGrid: FC<ITimesheetGridProps> = ({
  employees,
  entries,
  year,
  month,
  onEmployeeClick,
  onDayClick,
}) => {
  const daysCount = getDaysInMonth(year, month);
  const days = Array.from({ length: daysCount }, (_, i) => i + 1);
  const normHoursPerEmp = getWorkingDaysUpToToday(year, month) * 8;

  const rows: IRowData[] = useMemo(() => {
    const dc = getDaysInMonth(year, month);
    const entryMap = new Map<string, TimesheetEntry>();
    for (const entry of entries) {
      entryMap.set(`${entry.employee_id}_${entry.work_date}`, entry);
    }

    return employees.map(emp => {
      const dayMap = new Map<number, TimesheetEntry>();
      let factHours = 0;

      for (let d = 1; d <= dc; d++) {
        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const entry = entryMap.get(`${emp.id}_${dateStr}`);
        if (entry) {
          dayMap.set(d, entry);
          if (entry.hours_worked) factHours += entry.hours_worked;
        }
      }

      return { employee: emp, days: dayMap, factHours, normHours: normHoursPerEmp };
    });
  }, [employees, entries, year, month, normHoursPerEmp]);

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
            <span className="ts-legend-dot ts-legend-dot--absent">Н</span>Неявка
          </div>
          <div className="ts-legend-item">
            <span className="ts-legend-dot ts-legend-dot--weekend">—</span>Выходной
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
                    <div className="ts-employee-name">{row.employee.full_name}</div>
                    <div className="ts-employee-role">{row.employee.position_name || '—'}</div>
                  </td>
                  {days.map(d => {
                    const weekend = isWeekend(year, month, d);
                    const today = isToday(year, month, d);
                    const future = isFutureDay(year, month, d);
                    const entry = row.days.get(d) || null;
                    const cls = getDayCellClass(entry, weekend, today, future);
                    const text = getDayCellText(entry, weekend);

                    return (
                      <td
                        key={d}
                        className={cls}
                        onClick={() => {
                          if (!weekend) onDayClick(row.employee, d, entry);
                        }}
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
