import { type FC, useMemo, useState } from 'react';
import type { TimesheetEntry, TimesheetEmployee, TimesheetStatus } from '../../types';
import type { IResolvedSchedule } from '../../types/schedule';
import type { IProductionCalendarMonth } from '../../types/timesheet';
import { ChevronDown, ChevronUp } from 'lucide-react';
import {
  getDaysInMonth,
  isWeekend,
  getWeekdayShort,
  isToday,
  isFutureDay,
} from '../../utils/calendarUtils';
import {
  getScheduleForTimesheetDay,
  getFullDayThresholdHoursForDay,
  isScheduleDayOff,
} from '../../utils/scheduleUtils';
import { formatTimesheetEmployeeName } from '../../utils/timesheetDisplay';

interface ITimesheetGridProps {
  employees: TimesheetEmployee[];
  entries: TimesheetEntry[];
  year: number;
  month: number;
  schedules?: Record<number, IResolvedSchedule>;
  dailySchedules?: Record<number, Record<string, IResolvedSchedule>>;
  calendar?: IProductionCalendarMonth | null;
  compact?: boolean;
  bulkEditMode?: boolean;
  visibleDays?: number[];
  selectedEmployeeIds?: Set<number>;
  selectedDays?: Set<number>;
  selectedCellKeys?: Set<string>;
  allEmployeesSelected?: boolean;
  onToggleEmployeeSelection?: (employeeId: number) => void;
  onToggleDaySelection?: (day: number) => void;
  onToggleAllEmployees?: () => void;
  onToggleCellSelection?: (employeeId: number, day: number) => void;
  onEmployeeClick: (employee: TimesheetEmployee) => void;
  onDayClick: (employee: TimesheetEmployee, day: number, entry: TimesheetEntry | null) => void;
}

interface IRowData {
  employee: TimesheetEmployee;
  days: Map<number, TimesheetEntry>;
}

const EMPTY_SELECTION = new Set<number>();
const EMPTY_CELL_SELECTION = new Set<string>();
const getBulkCellKey = (employeeId: number, day: number): string => `${employeeId}:${day}`;

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
  if ((entry.travel_delay_minutes || 0) > 0) {
    parts.push(`Превышение лимита передвижения: ${formatHM((entry.travel_delay_minutes || 0) / 60)}`);
  }
  if ((entry.travel_problematic_segments || 0) > 0) {
    parts.push(`Есть передвижения без привязки объекта: ${entry.travel_problematic_segments}`);
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
  bulkEditMode = false,
  visibleDays,
  selectedEmployeeIds = EMPTY_SELECTION,
  selectedDays = EMPTY_SELECTION,
  selectedCellKeys = EMPTY_CELL_SELECTION,
  allEmployeesSelected = false,
  onToggleEmployeeSelection,
  onToggleDaySelection,
  onToggleAllEmployees,
  onToggleCellSelection,
  onEmployeeClick,
  onDayClick,
}) => {
  const daysCount = getDaysInMonth(year, month);
  const days = visibleDays || Array.from({ length: daysCount }, (_, i) => i + 1);
  const [expandedEmployeeId, setExpandedEmployeeId] = useState<number | null>(null);
  const rows: IRowData[] = useMemo(() => {
    const dc = getDaysInMonth(year, month);
    const entryMap = new Map<string, TimesheetEntry>();
    for (const entry of entries) {
      entryMap.set(`${entry.employee_id}_${entry.work_date}`, entry);
    }

    return employees.map(emp => {
      const dayMap = new Map<number, TimesheetEntry>();

      for (let d = 1; d <= dc; d++) {
        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const entry = entryMap.get(`${emp.id}_${dateStr}`);
        if (entry) {
          dayMap.set(d, entry);
        }
      }

      return { employee: emp, days: dayMap };
    });
  }, [employees, entries, year, month]);

  const activeExpandedEmployeeId = expandedEmployeeId != null
    && rows.some(row => row.employee.id === expandedEmployeeId)
    ? expandedEmployeeId
    : null;

  if (compact) {
    return (
      <div className="ts-table-container">
        <div className="ts-table-header-bar ts-table-header-bar--mobile">
          <h3 className="ts-table-title">Сотрудники</h3>
          <div className="ts-mobile-list-hint">
            {rows.length > 0 ? `${rows.length} чел. • откройте дни по сотруднику` : 'Нет данных за месяц'}
          </div>
        </div>

        <div className="ts-mobile-list">
          {rows.map((row, index) => {
            const expanded = activeExpandedEmployeeId === row.employee.id;
            const employeeIndex = index + 1;
            const displayName = formatTimesheetEmployeeName(row.employee.full_name);

            return (
              <article
                key={row.employee.id}
                className={`ts-mobile-card${expanded ? ' ts-mobile-card--expanded' : ''}`}
              >
                <div className="ts-mobile-card-header">
                  <div className="ts-mobile-card-meta">
                    <div className="ts-mobile-card-name-row">
                      <span className="ts-employee-index">{employeeIndex}.</span>
                      <div className="ts-mobile-card-name">{displayName}</div>
                    </div>
                  </div>
                </div>

                <div className="ts-mobile-card-actions">
                  <button
                    type="button"
                    className="ts-mobile-action-btn"
                    onClick={() => setExpandedEmployeeId(current => (
                      current === row.employee.id ? null : row.employee.id
                    ))}
                    aria-expanded={expanded}
                  >
                    {expanded ? 'Скрыть дни' : 'Показать дни'}
                    {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  </button>
                  <button
                    type="button"
                    className="ts-mobile-action-btn ts-mobile-action-btn--secondary"
                    onClick={() => onEmployeeClick(row.employee)}
                  >
                    Детализация
                  </button>
                </div>

                {expanded && (
                  <div className="ts-mobile-days-wrap">
                    <div className="ts-mobile-days-caption">
                      Нажмите на день, чтобы посмотреть или скорректировать отметку
                    </div>
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
                  </div>
                )}
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
            <span className="ts-legend-dot ts-legend-dot--travel-issue">!</span>Превышение лимита или проблема объекта
          </div>
        </div>
      </div>

      <div className="ts-table-scroll">
        <table className="ts-table">
          <thead>
            <tr>
              <th className="ts-col-sticky">
                {bulkEditMode ? (
                  <label className="ts-bulk-header-label">
                    <input
                      type="checkbox"
                      className="ts-bulk-checkbox"
                      checked={allEmployeesSelected}
                      onChange={() => onToggleAllEmployees?.()}
                    />
                    <span className="ts-col-sticky-label">Сотрудник</span>
                  </label>
                ) : 'Сотрудник'}
              </th>
              {days.map(d => {
                const weekend = isWeekend(year, month, d);
                const today = isToday(year, month, d);
                const daySelected = bulkEditMode && selectedDays.has(d);
                let cls = '';
                if (today) cls = 'ts-th--today';
                else if (weekend) cls = 'ts-th--weekend';
                return (
                  <th key={d} className={`${cls}${bulkEditMode ? ' ts-bulk-day-head' : ''}${daySelected ? ' ts-bulk-day-head--selected' : ''}`}>
                    {bulkEditMode ? (
                      <label className="ts-bulk-day-select">
                        <input
                          type="checkbox"
                          className="ts-bulk-checkbox ts-bulk-checkbox--day"
                          checked={daySelected}
                          onChange={() => onToggleDaySelection?.(d)}
                        />
                        <span className="ts-bulk-day-label">
                          <span>{d}</span>
                          <span className="ts-bulk-day-weekday">{getWeekdayShort(year, month, d)}</span>
                        </span>
                      </label>
                    ) : (
                      <>
                        {d}<br />
                        <span style={{ fontWeight: 400 }}>{getWeekdayShort(year, month, d)}</span>
                      </>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const employeeIndex = index + 1;
              const displayName = formatTimesheetEmployeeName(row.employee.full_name);
              const employeeSelected = bulkEditMode && selectedEmployeeIds.has(row.employee.id);

              return (
                <tr key={row.employee.id}>
                  <td
                    className={`ts-col-sticky ts-employee-cell${bulkEditMode ? ' ts-employee-cell--bulk' : ''}${employeeSelected ? ' ts-employee-cell--selected' : ''}`}
                    onClick={bulkEditMode ? undefined : () => onEmployeeClick(row.employee)}
                  >
                    {bulkEditMode ? (
                      <label className="ts-employee-select-label">
                        <input
                          type="checkbox"
                          className="ts-bulk-checkbox"
                          checked={employeeSelected}
                          onChange={() => onToggleEmployeeSelection?.(row.employee.id)}
                        />
                        <span className="ts-employee-index">{employeeIndex}.</span>
                        <div className="ts-employee-name" title={row.employee.full_name}>
                          {displayName}
                        </div>
                      </label>
                    ) : (
                      <div className="ts-employee-name-row">
                        <span className="ts-employee-index">{employeeIndex}.</span>
                        <div className="ts-employee-name" title={row.employee.full_name}>
                          {displayName}
                        </div>
                      </div>
                    )}
                  </td>
                  {days.map(d => {
                    const sched = getScheduleForTimesheetDay(schedules, dailySchedules, row.employee.id, year, month, d);
                    const dayOff = isScheduleDayOff(sched, calendar, year, month, d);
                    const today = isToday(year, month, d);
                    const future = isFutureDay(year, month, d);
                    const entry = row.days.get(d) || null;
                    const thresholdHours = getFullDayThresholdHoursForDay(sched, calendar, year, month, d);
                    const directSelected = bulkEditMode && selectedCellKeys.has(getBulkCellKey(row.employee.id, d));
                    const targeted = bulkEditMode && (directSelected || (employeeSelected && selectedDays.has(d)));
                    const cls = `${getDayCellClass(entry, dayOff, today, future, thresholdHours)}${targeted ? ' ts-day--bulk-target' : ''}${directSelected ? ' ts-day--bulk-direct' : ''}`;
                    const text = getDayCellText(entry, dayOff);
                    const title = getDayCellTitle(entry, dayOff);
                    const bulkTitle = bulkEditMode
                      ? [title, directSelected ? 'Нажмите, чтобы снять точечный выбор' : 'Нажмите, чтобы выбрать ячейку для массовой корректировки']
                        .filter(Boolean)
                        .join(' • ')
                      : title;

                    return (
                      <td
                        key={d}
                        className={cls}
                        title={bulkTitle}
                        onClick={bulkEditMode ? () => onToggleCellSelection?.(row.employee.id, d) : () => onDayClick(row.employee, d, entry)}
                      >
                        {text}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={days.length + 1} className="ts-loading">
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
