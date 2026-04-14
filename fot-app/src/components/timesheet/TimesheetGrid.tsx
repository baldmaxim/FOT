import { Fragment, type FC, type MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useState } from 'react';
import type { TimesheetEntry, TimesheetEmployee, TimesheetObjectEntry, TimesheetStatus } from '../../types';
import type { IResolvedSchedule } from '../../types/schedule';
import type { IProductionCalendarMonth } from '../../types/timesheet';
import { ChevronDown, ChevronUp, UserMinus } from 'lucide-react';
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
  objectEntries: TimesheetObjectEntry[];
  year: number;
  month: number;
  schedules?: Record<number, IResolvedSchedule>;
  dailySchedules?: Record<number, Record<string, IResolvedSchedule>>;
  calendar?: IProductionCalendarMonth | null;
  compact?: boolean;
  bulkEditMode?: boolean;
  visibleDays?: number[];
  selectedCellKeys?: Set<string>;
  splitDayKeys?: Set<string>;
  canManageTeam?: boolean;
  pendingEmployeeId?: number | null;
  onBulkSelectionChange?: (cellKeys: Set<string>) => void;
  onBulkBlockedSelectionAttempt?: () => void;
  onEmployeeClick: (employee: TimesheetEmployee) => void;
  onExcludeEmployee?: (employee: TimesheetEmployee) => void;
  onDayClick: (employee: TimesheetEmployee, day: number, entry: TimesheetEntry | null) => void;
  onObjectDayClick: (
    employee: TimesheetEmployee,
    day: number,
    target: { object_key: string; object_id: string | null; object_name: string },
    entry: TimesheetObjectEntry | null,
  ) => void;
}

interface IRowData {
  employee: TimesheetEmployee;
  days: Map<number, TimesheetEntry>;
  objectRows: IObjectRowData[];
  hasExpandableObjects: boolean;
}

interface IObjectRowData {
  object_key: string;
  object_id: string | null;
  object_name: string;
  days: Map<number, TimesheetObjectEntry>;
}

const EMPTY_CELL_SELECTION = new Set<string>();
const getBulkCellKey = (employeeId: number, day: number): string => `${employeeId}:${day}`;

interface IBulkCellCoord {
  employeeId: number;
  day: number;
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

const getObjectCellTitle = (entry: TimesheetObjectEntry | null): string | undefined => {
  if (!entry) return undefined;
  const parts = [`Объект: ${entry.object_name}`, `Часы: ${formatHM(entry.hours_worked)}`];
  if (entry.is_correction) {
    parts.push('Есть корректировка по объекту');
  }
  return parts.join(' • ');
};

export const TimesheetGrid: FC<ITimesheetGridProps> = ({
  employees,
  entries,
  objectEntries,
  year,
  month,
  schedules = {},
  dailySchedules = {},
  calendar = null,
  compact = false,
  bulkEditMode = false,
  visibleDays,
  selectedCellKeys = EMPTY_CELL_SELECTION,
  splitDayKeys = EMPTY_CELL_SELECTION,
  canManageTeam = false,
  pendingEmployeeId = null,
  onBulkSelectionChange,
  onBulkBlockedSelectionAttempt,
  onEmployeeClick,
  onExcludeEmployee,
  onDayClick,
  onObjectDayClick,
}) => {
  const daysCount = getDaysInMonth(year, month);
  const days = visibleDays || Array.from({ length: daysCount }, (_, i) => i + 1);
  const [expandedEmployeeIds, setExpandedEmployeeIds] = useState<Set<number>>(new Set());
  const [bulkDragAnchor, setBulkDragAnchor] = useState<IBulkCellCoord | null>(null);
  const [bulkDragPreviewKeys, setBulkDragPreviewKeys] = useState<Set<string> | null>(null);
  const rows: IRowData[] = useMemo(() => {
    const dc = getDaysInMonth(year, month);
    const entryMap = new Map<string, TimesheetEntry>();
    for (const entry of entries) {
      entryMap.set(`${entry.employee_id}_${entry.work_date}`, entry);
    }

    const visibleDateSet = new Set(
      days.map(day => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`),
    );
    const objectsByEmployee = new Map<number, Map<string, IObjectRowData>>();
    const distinctObjectsByEmployee = new Map<number, Set<string>>();

    for (const objectEntry of objectEntries) {
      if (!visibleDateSet.has(objectEntry.work_date)) continue;
      if (!objectsByEmployee.has(objectEntry.employee_id)) {
        objectsByEmployee.set(objectEntry.employee_id, new Map());
      }
      if (!distinctObjectsByEmployee.has(objectEntry.employee_id)) {
        distinctObjectsByEmployee.set(objectEntry.employee_id, new Set());
      }

      distinctObjectsByEmployee.get(objectEntry.employee_id)!.add(objectEntry.object_key);

      const byObject = objectsByEmployee.get(objectEntry.employee_id)!;
      const current = byObject.get(objectEntry.object_key) || {
        object_key: objectEntry.object_key,
        object_id: objectEntry.object_id,
        object_name: objectEntry.object_name,
        days: new Map<number, TimesheetObjectEntry>(),
      };
      const dayNumber = Number.parseInt(objectEntry.work_date.slice(-2), 10);
      if (Number.isFinite(dayNumber)) {
        current.days.set(dayNumber, objectEntry);
      }
      byObject.set(objectEntry.object_key, current);
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

      const employeeObjectRows = [...(objectsByEmployee.get(emp.id)?.values() || [])]
        .sort((left, right) => left.object_name.localeCompare(right.object_name, 'ru'));
      const hasExpandableObjects = (distinctObjectsByEmployee.get(emp.id)?.size || 0) > 1;

      return {
        employee: emp,
        days: dayMap,
        objectRows: hasExpandableObjects ? employeeObjectRows : [],
        hasExpandableObjects,
      };
    });
  }, [days, employees, entries, objectEntries, year, month]);

  const activeExpandedEmployeeIds = useMemo(() => (
    new Set(
      [...expandedEmployeeIds].filter(employeeId => rows.some(row => row.employee.id === employeeId)),
    )
  ), [expandedEmployeeIds, rows]);
  const employeeRowIndexById = useMemo(() => (
    new Map(rows.map((row, index) => [row.employee.id, index]))
  ), [rows]);
  const dayIndexByValue = useMemo(() => (
    new Map(days.map((day, index) => [day, index]))
  ), [days]);
  const activeSelectedCellKeys = bulkDragPreviewKeys ?? selectedCellKeys;

  const toggleEmployeeExpanded = (employeeId: number): void => {
    setExpandedEmployeeIds(current => {
      const next = new Set(current);
      if (next.has(employeeId)) next.delete(employeeId);
      else next.add(employeeId);
      return next;
    });
  };

  const buildBulkRangeSelection = useCallback((anchor: IBulkCellCoord, current: IBulkCellCoord): Set<string> => {
    const anchorRowIndex = employeeRowIndexById.get(anchor.employeeId);
    const currentRowIndex = employeeRowIndexById.get(current.employeeId);
    const anchorDayIndex = dayIndexByValue.get(anchor.day);
    const currentDayIndex = dayIndexByValue.get(current.day);

    if (
      anchorRowIndex == null
      || currentRowIndex == null
      || anchorDayIndex == null
      || currentDayIndex == null
    ) {
      return new Set();
    }

    const startRowIndex = Math.min(anchorRowIndex, currentRowIndex);
    const endRowIndex = Math.max(anchorRowIndex, currentRowIndex);
    const startDayIndex = Math.min(anchorDayIndex, currentDayIndex);
    const endDayIndex = Math.max(anchorDayIndex, currentDayIndex);
    const nextSelection = new Set<string>();

    for (let rowIndex = startRowIndex; rowIndex <= endRowIndex; rowIndex += 1) {
      const employee = rows[rowIndex]?.employee;
      if (!employee) continue;

      for (let dayIndex = startDayIndex; dayIndex <= endDayIndex; dayIndex += 1) {
        const day = days[dayIndex];
        if (day == null) continue;
        const workDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (splitDayKeys.has(`${employee.id}_${workDate}`)) continue;
        nextSelection.add(getBulkCellKey(employee.id, day));
      }
    }

    return nextSelection;
  }, [dayIndexByValue, days, employeeRowIndexById, month, rows, splitDayKeys, year]);

  const finishBulkDragSelection = useCallback(() => {
    if (!bulkDragAnchor) return;
    onBulkSelectionChange?.(new Set(bulkDragPreviewKeys ?? []));
    setBulkDragAnchor(null);
    setBulkDragPreviewKeys(null);
  }, [bulkDragAnchor, bulkDragPreviewKeys, onBulkSelectionChange]);

  useEffect(() => {
    if (!bulkEditMode) {
      setBulkDragAnchor(null);
      setBulkDragPreviewKeys(null);
      return;
    }

    const handleMouseUp = () => {
      finishBulkDragSelection();
    };

    window.addEventListener('mouseup', handleMouseUp);
    return () => window.removeEventListener('mouseup', handleMouseUp);
  }, [bulkEditMode, finishBulkDragSelection]);

  const handleBulkCellMouseDown = useCallback((
    event: ReactMouseEvent<HTMLTableCellElement>,
    employeeId: number,
    day: number,
  ) => {
    if (!bulkEditMode || event.button !== 0) return;

    const workDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (splitDayKeys.has(`${employeeId}_${workDate}`)) {
      onBulkBlockedSelectionAttempt?.();
      return;
    }

    event.preventDefault();
    const anchor = { employeeId, day };
    setBulkDragAnchor(anchor);
    setBulkDragPreviewKeys(buildBulkRangeSelection(anchor, anchor));
  }, [buildBulkRangeSelection, bulkEditMode, month, onBulkBlockedSelectionAttempt, splitDayKeys, year]);

  const handleBulkCellMouseEnter = useCallback((employeeId: number, day: number) => {
    if (!bulkEditMode || !bulkDragAnchor) return;
    setBulkDragPreviewKeys(buildBulkRangeSelection(bulkDragAnchor, { employeeId, day }));
  }, [buildBulkRangeSelection, bulkDragAnchor, bulkEditMode]);

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
            const expanded = activeExpandedEmployeeIds.has(row.employee.id);
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
                  {canManageTeam && onExcludeEmployee && (
                    <button
                      type="button"
                      className="ts-mobile-action-btn ts-mobile-action-btn--danger"
                      onClick={() => onExcludeEmployee(row.employee)}
                      disabled={pendingEmployeeId === row.employee.id}
                    >
                      <UserMinus size={14} />
                      {pendingEmployeeId === row.employee.id ? 'Исключение...' : 'Исключить'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="ts-mobile-action-btn"
                    onClick={() => toggleEmployeeExpanded(row.employee.id)}
                    aria-expanded={expanded}
                  >
                    {expanded ? 'Скрыть детали' : row.hasExpandableObjects ? 'Показать дни и объекты' : 'Показать дни'}
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
                    {row.hasExpandableObjects && (
                      <div className="ts-mobile-objects">
                        <div className="ts-mobile-objects-title">Объекты</div>
                        {row.objectRows.map(objectRow => (
                          <div key={objectRow.object_key} className="ts-mobile-object-row">
                            <div className="ts-mobile-object-name">{objectRow.object_name}</div>
                            <div className="ts-mobile-object-days">
                              {days.map(d => {
                                const objectEntry = objectRow.days.get(d) || null;
                                if (!objectEntry) return null;
                                return (
                                  <button
                                    key={`${objectRow.object_key}_${d}`}
                                    type="button"
                                    className={`ts-mobile-object-chip${objectEntry.is_correction ? ' ts-mobile-object-chip--corrected' : ''}`}
                                    onClick={() => onObjectDayClick(row.employee, d, {
                                      object_key: objectRow.object_key,
                                      object_id: objectRow.object_id,
                                      object_name: objectRow.object_name,
                                    }, objectEntry)}
                                  >
                                    {d}: {formatCellHM(objectEntry.hours_worked)}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
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
        <table className={`ts-table${bulkEditMode ? ' ts-table--bulk-mode' : ''}`}>
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
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const employeeIndex = index + 1;
              const displayName = formatTimesheetEmployeeName(row.employee.full_name);
              const expanded = activeExpandedEmployeeIds.has(row.employee.id);

              return (
                <Fragment key={row.employee.id}>
                  <tr key={row.employee.id}>
                    <td
                      className={`ts-col-sticky ts-employee-cell${bulkEditMode ? ' ts-employee-cell--bulk' : ''}`}
                      onClick={bulkEditMode ? undefined : () => onEmployeeClick(row.employee)}
                    >
                      <div className="ts-employee-cell-content">
                        <div className="ts-employee-name-row">
                          {row.hasExpandableObjects && (
                            <button
                              type="button"
                              className="ts-expand-btn"
                              onClick={(event) => {
                                event.stopPropagation();
                                toggleEmployeeExpanded(row.employee.id);
                              }}
                              aria-expanded={expanded}
                            >
                              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                            </button>
                          )}
                          <span className="ts-employee-index">{employeeIndex}.</span>
                          <div className="ts-employee-name" title={row.employee.full_name}>
                            {displayName}
                          </div>
                        </div>
                          {canManageTeam && onExcludeEmployee && (
                            <div
                              className="ts-employee-cell-actions"
                              onClick={event => event.stopPropagation()}
                            >
                              <button
                                type="button"
                                className="ts-employee-inline-btn"
                                title="Исключить сотрудника"
                                aria-label="Исключить сотрудника"
                                onClick={() => onExcludeEmployee(row.employee)}
                                disabled={pendingEmployeeId === row.employee.id}
                              >
                                <UserMinus size={12} />
                                {pendingEmployeeId === row.employee.id ? '...' : 'Искл.'}
                              </button>
                            </div>
                          )}
                      </div>
                    </td>
                    {days.map(d => {
                      const sched = getScheduleForTimesheetDay(schedules, dailySchedules, row.employee.id, year, month, d);
                      const dayOff = isScheduleDayOff(sched, calendar, year, month, d);
                      const today = isToday(year, month, d);
                      const future = isFutureDay(year, month, d);
                      const entry = row.days.get(d) || null;
                      const thresholdHours = getFullDayThresholdHoursForDay(sched, calendar, year, month, d);
                      const targeted = bulkEditMode && activeSelectedCellKeys.has(getBulkCellKey(row.employee.id, d));
                      const cls = `${getDayCellClass(entry, dayOff, today, future, thresholdHours)}${targeted ? ' ts-day--bulk-target' : ''}${bulkEditMode ? ' ts-day--bulk-selectable' : ''}`;
                      const text = getDayCellText(entry, dayOff);
                      const title = getDayCellTitle(entry, dayOff);
                      const bulkTitle = bulkEditMode
                        ? [title, 'Зажмите левую кнопку мыши и протяните диапазон для массовой корректировки']
                          .filter(Boolean)
                          .join(' • ')
                        : title;

                      return (
                        <td
                          key={d}
                          className={cls}
                          title={bulkTitle}
                          onMouseDown={bulkEditMode ? (event) => handleBulkCellMouseDown(event, row.employee.id, d) : undefined}
                          onMouseEnter={bulkEditMode ? () => handleBulkCellMouseEnter(row.employee.id, d) : undefined}
                          onClick={bulkEditMode ? undefined : () => onDayClick(row.employee, d, entry)}
                        >
                          {text}
                        </td>
                      );
                    })}
                  </tr>
                  {expanded && row.hasExpandableObjects && row.objectRows.map(objectRow => (
                    <tr key={`${row.employee.id}_${objectRow.object_key}`} className="ts-object-row">
                      <td className="ts-col-sticky ts-object-cell">
                        <div className="ts-object-name" title={objectRow.object_name}>
                          ↳ {objectRow.object_name}
                        </div>
                      </td>
                      {days.map(d => {
                        const objectEntry = objectRow.days.get(d) || null;
                        const sched = getScheduleForTimesheetDay(schedules, dailySchedules, row.employee.id, year, month, d);
                        const dayOff = isScheduleDayOff(sched, calendar, year, month, d);
                        const future = isFutureDay(year, month, d);
                        const text = objectEntry ? formatCellHM(objectEntry.hours_worked) : '';
                        const title = getObjectCellTitle(objectEntry);
                        const isClickable = !future && !dayOff;
                        return (
                          <td
                            key={`${objectRow.object_key}_${d}`}
                            className={`ts-day ts-day--object${objectEntry?.is_correction ? ' ts-day--corrected' : ''}`}
                            title={title}
                            onClick={isClickable ? () => onObjectDayClick(row.employee, d, {
                              object_key: objectRow.object_key,
                              object_id: objectRow.object_id,
                              object_name: objectRow.object_name,
                            }, objectEntry) : undefined}
                          >
                            {text}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </Fragment>
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
