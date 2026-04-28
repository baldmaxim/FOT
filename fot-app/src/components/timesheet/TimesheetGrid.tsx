import { Fragment, type FC, type MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Menu, UserMinus } from 'lucide-react';
import type { TimesheetEntry, TimesheetEmployee, TimesheetObjectEntry, TimesheetStatus } from '../../types';
import type { IResolvedSchedule } from '../../types/schedule';
import type { IProductionCalendarMonth, IEmployeeStats } from '../../types/timesheet';
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
import '../../pages/timesheet/TimesheetPage.css';

type TimesheetViewMode = 'employees' | 'objects';

interface ITimesheetGridProps {
  employees: TimesheetEmployee[];
  entries: TimesheetEntry[];
  objectEntries: TimesheetObjectEntry[];
  employeeStats?: IEmployeeStats[];
  year: number;
  month: number;
  viewMode?: TimesheetViewMode;
  schedules?: Record<number, IResolvedSchedule>;
  dailySchedules?: Record<number, Record<string, IResolvedSchedule>>;
  calendar?: IProductionCalendarMonth | null;
  compact?: boolean;
  bulkEditMode?: boolean;
  visibleDays?: number[];
  selectedCellKeys?: Set<string>;
  splitDayKeys?: Set<string>;
  lockedDates?: Set<string>;
  problemDates?: { red?: Set<string>; yellow?: Set<string> };
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

interface IObjectRowData {
  object_key: string;
  object_id: string | null;
  object_name: string;
  days: Map<number, TimesheetObjectEntry>;
}

interface IEmployeeRowData {
  employee: TimesheetEmployee;
  days: Map<number, TimesheetEntry>;
  objectRows: IObjectRowData[];
  hasExpandableObjects: boolean;
}

interface IObjectViewRow {
  employee: TimesheetEmployee;
  object_key: string;
  object_id: string | null;
  object_name: string;
  days: Map<number, TimesheetObjectEntry>;
  dailyEntries: Map<number, TimesheetEntry>;
  isSynthetic: boolean;
}

interface IObjectViewGroup {
  object_key: string;
  object_id: string | null;
  object_name: string;
  rows: IObjectViewRow[];
  isSynthetic: boolean;
}

interface IBulkCellCoord {
  rowKey: string;
  day: number;
}

const EMPTY_CELL_SELECTION = new Set<string>();
const UNASSIGNED_OBJECT_KEY = '__timesheet_unassigned__';
const UNASSIGNED_OBJECT_NAME = 'Не определён / без объекта';

const getEmployeeBulkRowKey = (employeeId: number): string => `employee:${employeeId}`;
const getObjectBulkRowKey = (employeeId: number, objectKey: string): string => `object:${employeeId}:${encodeURIComponent(objectKey)}`;
const getEmployeeBulkCellKey = (employeeId: number, day: number): string => `${getEmployeeBulkRowKey(employeeId)}:${day}`;
const getObjectBulkCellKey = (employeeId: number, objectKey: string, day: number): string => (
  `${getObjectBulkRowKey(employeeId, objectKey)}:${day}`
);

const roundHours = (value: number): number => Math.round(value * 100) / 100;
const getVisibleHours = (entry: TimesheetEntry | null | undefined): number | null => (
  entry?.display_hours_worked ?? entry?.hours_worked ?? null
);
const getObjectVisibleHours = (entry: TimesheetObjectEntry | null | undefined): number => (
  entry?.display_hours_worked ?? entry?.hours_worked ?? 0
);

const hasPositiveHours = (value: number | null | undefined): boolean => (
  typeof value === 'number' && value > 0.001
);

const formatHM = (decimal: number): string => {
  const h = Math.floor(decimal);
  const m = Math.round((decimal - h) * 60);
  if (m === 0) return `${h}ч`;
  return `${h}ч${m}м`;
};

const formatDeviationHours = (value: number): string => {
  const abs = Math.abs(value);
  const rounded = Math.round(abs * 10) / 10;
  const sign = value > 0.05 ? '+' : value < -0.05 ? '−' : '';
  return `${sign}${rounded.toFixed(1)} ч`;
};

const formatBadgeDate = (iso: string): string => {
  const [, m, d] = iso.split('-');
  if (!m || !d) return iso;
  return `${d}.${m}`;
};

/**
 * Дата выхода из табеля (включительно): минимум из transferred_out_date и excluded_from_timesheet_date.
 * После неё — день рендерится как inactive (серый, line-through).
 */
const getInactiveFromDate = (employee: TimesheetEmployee): string | null => {
  const a = employee.transferred_out_date ?? null;
  const b = employee.excluded_from_timesheet_date ?? null;
  if (a && b) return a < b ? a : b;
  return a || b || null;
};

const isDayInactiveForEmployee = (employee: TimesheetEmployee, year: number, month: number, day: number): boolean => {
  const cutoff = getInactiveFromDate(employee);
  if (!cutoff) return false;
  const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return dateStr >= cutoff;
};

const getDeviationCellClass = (deviation: number): string => {
  if (deviation > 0.05) return 'ts-day--deviation-undertime';
  if (deviation < -0.05) return 'ts-day--deviation-overtime';
  return 'ts-day--deviation-zero';
};

const formatCellHM = (decimal: number): string => {
  const h = Math.floor(decimal);
  const m = Math.round((decimal - h) * 60);
  if (m === 0) return `${h}`;
  return `${h}:${String(m).padStart(2, '0')}`;
};

const STATUS_CELL_TEXT: Record<TimesheetStatus, string> = {
  work: '',
  sick: 'Б',
  vacation: 'От',
  absent: 'Н',
  dayoff: 'В',
  remote: 'УУ',
  unpaid: 'С',
  educational_leave: 'У',
  manual: '',
};

const getDayCellClass = (
  entry: TimesheetEntry | null,
  weekend: boolean,
  today: boolean,
  future: boolean,
  thresholdHours = 8,
): string => {
  const classes = ['ts-day'];
  const visibleHours = getVisibleHours(entry);
  if (today) classes.push('ts-day--today');
  if (weekend && !entry) {
    classes.push('ts-day--weekend');
    return classes.join(' ');
  }
  if (!entry) {
    if (future) classes.push('ts-day--empty');
    return classes.join(' ');
  }
  const hasSkudEvents = Boolean(entry.first_entry || entry.last_exit);
  const zeroHours = !hasPositiveHours(visibleHours);
  const incompleteSkud = hasSkudEvents && zeroHours;
  switch (entry.status) {
    case 'work':
    case 'manual': {
      if (incompleteSkud) {
        classes.push('ts-day--incomplete-skud');
        break;
      }
      const hoursOk = hasPositiveHours(visibleHours) && (visibleHours as number) >= thresholdHours;
      const spanOk = entry.presence_covers_shift !== false;
      classes.push(hoursOk && spanOk ? 'ts-day--full' : 'ts-day--partial');
      break;
    }
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
      if (hasSkudEvents) {
        classes.push('ts-day--incomplete-skud');
      } else {
        classes.push('ts-day--absent');
      }
      break;
    case 'unpaid':
      classes.push('ts-day--unpaid');
      break;
    case 'educational_leave':
      classes.push('ts-day--educational');
      break;
  }
  if (entry.is_correction) classes.push('ts-day--corrected');
  if ((entry.travel_problematic_segments || 0) > 0 || (entry.travel_delay_minutes || 0) > 0) {
    classes.push('ts-day--travel-issue');
  }
  return classes.join(' ');
};

const getDayCellText = (entry: TimesheetEntry | null, weekend: boolean): string => {
  const visibleHours = getVisibleHours(entry);
  if (weekend && !entry) return '—';
  if (!entry) return '';
  const special = STATUS_CELL_TEXT[entry.status];
  if (special) return special;
  if (visibleHours != null) return formatCellHM(visibleHours);
  return '';
};

const getDayCellTextMobile = (entry: TimesheetEntry | null, weekend: boolean): string => {
  const visibleHours = getVisibleHours(entry);
  if (weekend && !entry) return '—';
  if (!entry) return '';
  const special = STATUS_CELL_TEXT[entry.status];
  if (special) return special;
  if (visibleHours != null) return String(Math.round(visibleHours));
  return '';
};

const getDayCellTitle = (entry: TimesheetEntry | null, weekend: boolean): string | undefined => {
  const visibleHours = getVisibleHours(entry);
  if (weekend && !entry) return 'Выходной';
  if (!entry) return undefined;

  const parts: string[] = [];
  if (visibleHours != null) {
    parts.push(`Часы: ${formatHM(visibleHours)}`);
  }
  if ((entry.status === 'work' || entry.status === 'manual') && entry.presence_covers_shift === false) {
    parts.push('Присутствие меньше длительности смены');
  }
  const hasSkudEventsTooltip = Boolean(entry.first_entry || entry.last_exit);
  const zeroHoursTooltip = !hasPositiveHours(visibleHours);
  if (hasSkudEventsTooltip && zeroHoursTooltip) {
    parts.push('Есть события СКУД, но время не учтено (только вход или только выход)');
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

const getObjectCellTitle = (entry: TimesheetObjectEntry | null, objectName?: string): string | undefined => {
  if (!entry && !objectName) return undefined;
  const parts = [`Объект: ${objectName || entry?.object_name || UNASSIGNED_OBJECT_NAME}`];
  if (entry) {
    parts.push(`Часы: ${formatHM(getObjectVisibleHours(entry))}`);
    if (entry.is_correction) {
      parts.push('Есть корректировка по объекту');
    }
  }
  return parts.join(' • ');
};

const compareEmployeeNames = (left: TimesheetEmployee, right: TimesheetEmployee): number => (
  left.full_name.localeCompare(right.full_name, 'ru')
);

export const TimesheetGrid: FC<ITimesheetGridProps> = ({
  employees,
  entries,
  objectEntries,
  employeeStats = [],
  year,
  month,
  viewMode = 'employees',
  schedules = {},
  dailySchedules = {},
  calendar = null,
  compact = false,
  bulkEditMode = false,
  visibleDays,
  selectedCellKeys = EMPTY_CELL_SELECTION,
  splitDayKeys = EMPTY_CELL_SELECTION,
  problemDates,
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
  const employeeStatsMap = useMemo(() => {
    const map = new Map<number, IEmployeeStats>();
    for (const stat of employeeStats) {
      map.set(stat.employee_id, stat);
    }
    return map;
  }, [employeeStats]);
  const showDeviationColumn = viewMode === 'employees';
  const [expandedEmployeeIds, setExpandedEmployeeIds] = useState<Set<number>>(new Set());
  const [bulkDragAnchor, setBulkDragAnchor] = useState<IBulkCellCoord | null>(null);
  const [bulkDragBaseKeys, setBulkDragBaseKeys] = useState<Set<string>>(new Set());
  const [bulkDragPreviewKeys, setBulkDragPreviewKeys] = useState<Set<string> | null>(null);

  const employeeRows = useMemo<IEmployeeRowData[]>(() => {
    const visibleDateSet = new Set(
      days.map(day => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`),
    );
    const entryMap = new Map<string, TimesheetEntry>();
    for (const entry of entries) {
      entryMap.set(`${entry.employee_id}_${entry.work_date}`, entry);
    }

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
      current.days.set(Number.parseInt(objectEntry.work_date.slice(-2), 10), objectEntry);
      byObject.set(objectEntry.object_key, current);
    }

    return employees.map(employee => {
      const dayMap = new Map<number, TimesheetEntry>();
      for (const day of days) {
        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const entry = entryMap.get(`${employee.id}_${dateStr}`);
        if (entry) {
          dayMap.set(day, entry);
        }
      }

      const employeeObjectRows = [...(objectsByEmployee.get(employee.id)?.values() || [])]
        .sort((left, right) => left.object_name.localeCompare(right.object_name, 'ru'));
      const hasExpandableObjects = (distinctObjectsByEmployee.get(employee.id)?.size || 0) > 1;

      return {
        employee,
        days: dayMap,
        objectRows: hasExpandableObjects ? employeeObjectRows : [],
        hasExpandableObjects,
      };
    });
  }, [days, employees, entries, objectEntries, year, month]);

  const objectViewGroups = useMemo<IObjectViewGroup[]>(() => {
    const employeeById = new Map(employees.map(employee => [employee.id, employee]));
    const dailyEntryByEmployee = new Map<number, Map<number, TimesheetEntry>>();
    for (const row of employeeRows) {
      dailyEntryByEmployee.set(row.employee.id, row.days);
    }

    const visibleDateSet = new Set(
      days.map(day => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`),
    );
    const groups = new Map<string, IObjectViewGroup>();
    const ensureGroup = (
      objectKey: string,
      objectId: string | null,
      objectName: string,
      isSynthetic: boolean,
    ): IObjectViewGroup => {
      const existing = groups.get(objectKey);
      if (existing) return existing;
      const next: IObjectViewGroup = {
        object_key: objectKey,
        object_id: objectId,
        object_name: objectName,
        rows: [],
        isSynthetic,
      };
      groups.set(objectKey, next);
      return next;
    };

    const ensureRow = (
      group: IObjectViewGroup,
      employee: TimesheetEmployee,
      isSynthetic: boolean,
    ): IObjectViewRow => {
      const existing = group.rows.find(row => row.employee.id === employee.id);
      if (existing) return existing;
      const next: IObjectViewRow = {
        employee,
        object_key: group.object_key,
        object_id: group.object_id,
        object_name: group.object_name,
        days: new Map<number, TimesheetObjectEntry>(),
        dailyEntries: dailyEntryByEmployee.get(employee.id) || new Map<number, TimesheetEntry>(),
        isSynthetic,
      };
      group.rows.push(next);
      return next;
    };

    const allocatedHoursByEmployeeDay = new Map<string, number>();
    const backendObjectDayKeys = new Set<string>();

    for (const objectEntry of objectEntries) {
      if (!visibleDateSet.has(objectEntry.work_date)) continue;
      const employee = employeeById.get(objectEntry.employee_id);
      if (!employee) continue;
      backendObjectDayKeys.add(`${objectEntry.employee_id}_${objectEntry.work_date}`);

      const normalizedName = objectEntry.object_name?.trim() || UNASSIGNED_OBJECT_NAME;
      const normalizedKey = normalizedName === UNASSIGNED_OBJECT_NAME ? UNASSIGNED_OBJECT_KEY : objectEntry.object_key;
      const group = ensureGroup(
        normalizedKey,
        normalizedKey === UNASSIGNED_OBJECT_KEY ? null : objectEntry.object_id,
        normalizedName,
        normalizedKey === UNASSIGNED_OBJECT_KEY,
      );
      const row = ensureRow(group, employee, normalizedKey === UNASSIGNED_OBJECT_KEY);
      const day = Number.parseInt(objectEntry.work_date.slice(-2), 10);
      row.days.set(day, {
        ...objectEntry,
        object_key: normalizedKey,
        object_id: normalizedKey === UNASSIGNED_OBJECT_KEY ? null : objectEntry.object_id,
        object_name: normalizedName,
      });

      const allocationKey = `${objectEntry.employee_id}_${objectEntry.work_date}`;
      allocatedHoursByEmployeeDay.set(
        allocationKey,
        roundHours((allocatedHoursByEmployeeDay.get(allocationKey) || 0) + getObjectVisibleHours(objectEntry)),
      );
    }

    for (const row of employeeRows) {
      for (const day of days) {
        const dailyEntry = row.days.get(day);
        const visibleHours = getVisibleHours(dailyEntry);
        if (!hasPositiveHours(visibleHours)) continue;

        const workDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (backendObjectDayKeys.has(`${row.employee.id}_${workDate}`)) continue;
        const allocatedHours = allocatedHoursByEmployeeDay.get(`${row.employee.id}_${workDate}`) || 0;
        const remainingHours = roundHours((visibleHours as number) - allocatedHours);
        if (remainingHours <= 0.001) continue;

        const group = ensureGroup(UNASSIGNED_OBJECT_KEY, null, UNASSIGNED_OBJECT_NAME, true);
        const objectRow = ensureRow(group, row.employee, true);
        objectRow.days.set(day, {
          adjustment_id: null,
          employee_id: row.employee.id,
          work_date: workDate,
          object_key: UNASSIGNED_OBJECT_KEY,
          object_id: null,
          object_name: UNASSIGNED_OBJECT_NAME,
          hours_worked: remainingHours,
          display_hours_worked: remainingHours,
          base_hours_worked: remainingHours,
          is_correction: false,
        });
      }
    }

    return [...groups.values()]
      .map(group => ({
        ...group,
        rows: [...group.rows].sort((left, right) => compareEmployeeNames(left.employee, right.employee)),
      }))
      .sort((left, right) => {
        if (left.object_key === UNASSIGNED_OBJECT_KEY) return 1;
        if (right.object_key === UNASSIGNED_OBJECT_KEY) return -1;
        return left.object_name.localeCompare(right.object_name, 'ru');
      });
  }, [days, employees, employeeRows, objectEntries, year, month]);

  const activeExpandedEmployeeIds = useMemo(() => (
    new Set(
      [...expandedEmployeeIds].filter(employeeId => employeeRows.some(row => row.employee.id === employeeId)),
    )
  ), [expandedEmployeeIds, employeeRows]);

  const objectViewRowsFlat = useMemo(() => (
    objectViewGroups.flatMap(group => group.rows)
  ), [objectViewGroups]);
  const employeeRowIndexByKey = useMemo(() => (
    new Map(employeeRows.map((row, index) => [getEmployeeBulkRowKey(row.employee.id), index]))
  ), [employeeRows]);
  const objectRowIndexByKey = useMemo(() => (
    new Map(objectViewRowsFlat.map((row, index) => [getObjectBulkRowKey(row.employee.id, row.object_key), index]))
  ), [objectViewRowsFlat]);
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

  const [bulkDragMode, setBulkDragMode] = useState<'add' | 'remove'>('add');

  const mergeBulkSelections = useCallback((
    base: Set<string>,
    nextRange: Set<string>,
    mode: 'add' | 'remove',
  ): Set<string> => {
    const merged = new Set(base);
    for (const cellKey of nextRange) {
      if (mode === 'remove') merged.delete(cellKey);
      else merged.add(cellKey);
    }
    return merged;
  }, []);

  const buildBulkRangeSelection = useCallback((anchor: IBulkCellCoord, current: IBulkCellCoord): Set<string> => {
    const anchorDayIndex = dayIndexByValue.get(anchor.day);
    const currentDayIndex = dayIndexByValue.get(current.day);

    if (anchorDayIndex == null || currentDayIndex == null) {
      return new Set();
    }

    const startDayIndex = Math.min(anchorDayIndex, currentDayIndex);
    const endDayIndex = Math.max(anchorDayIndex, currentDayIndex);
    const nextSelection = new Set<string>();

    if (viewMode === 'objects') {
      const anchorRowIndex = objectRowIndexByKey.get(anchor.rowKey);
      const currentRowIndex = objectRowIndexByKey.get(current.rowKey);
      if (anchorRowIndex == null || currentRowIndex == null) {
        return new Set();
      }

      const startRowIndex = Math.min(anchorRowIndex, currentRowIndex);
      const endRowIndex = Math.max(anchorRowIndex, currentRowIndex);

      for (let rowIndex = startRowIndex; rowIndex <= endRowIndex; rowIndex += 1) {
        const row = objectViewRowsFlat[rowIndex];
        if (!row) continue;

        for (let dayIndex = startDayIndex; dayIndex <= endDayIndex; dayIndex += 1) {
          const day = days[dayIndex];
          if (day == null) continue;
          if (row.isSynthetic) continue;
          nextSelection.add(getObjectBulkCellKey(row.employee.id, row.object_key, day));
        }
      }

      return nextSelection;
    }

    const anchorRowIndex = employeeRowIndexByKey.get(anchor.rowKey);
    const currentRowIndex = employeeRowIndexByKey.get(current.rowKey);
    if (anchorRowIndex == null || currentRowIndex == null) {
      return new Set();
    }

    const startEmployeeRowIndex = Math.min(anchorRowIndex, currentRowIndex);
    const endEmployeeRowIndex = Math.max(anchorRowIndex, currentRowIndex);

    for (let rowIndex = startEmployeeRowIndex; rowIndex <= endEmployeeRowIndex; rowIndex += 1) {
      const row = employeeRows[rowIndex];
      if (!row) continue;

      for (let dayIndex = startDayIndex; dayIndex <= endDayIndex; dayIndex += 1) {
        const day = days[dayIndex];
        if (day == null) continue;
        const workDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (splitDayKeys.has(`${row.employee.id}_${workDate}`)) continue;
        nextSelection.add(getEmployeeBulkCellKey(row.employee.id, day));
      }
    }

    return nextSelection;
  }, [
    dayIndexByValue,
    viewMode,
    objectRowIndexByKey,
    employeeRowIndexByKey,
    days,
    objectViewRowsFlat,
    employeeRows,
    month,
    splitDayKeys,
    year,
  ]);

  const finishBulkDragSelection = useCallback(() => {
    if (!bulkDragAnchor) return;
    onBulkSelectionChange?.(new Set(bulkDragPreviewKeys ?? []));
    setBulkDragAnchor(null);
    setBulkDragBaseKeys(new Set());
    setBulkDragPreviewKeys(null);
  }, [bulkDragAnchor, bulkDragPreviewKeys, onBulkSelectionChange]);

  useEffect(() => {
    if (!bulkEditMode) {
      setBulkDragAnchor(null);
      setBulkDragBaseKeys(new Set());
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
    rowKey: string,
    day: number,
    blocked = false,
  ) => {
    if (!bulkEditMode || event.button !== 0) return;
    if (blocked) {
      onBulkBlockedSelectionAttempt?.();
      return;
    }

    event.preventDefault();
    const anchor = { rowKey, day };
    const baseSelection = new Set(selectedCellKeys);
    const anchorRange = buildBulkRangeSelection(anchor, anchor);
    const anchorAlreadySelected = [...anchorRange].every((key) => baseSelection.has(key));
    const mode: 'add' | 'remove' = anchorAlreadySelected && anchorRange.size > 0 ? 'remove' : 'add';
    setBulkDragMode(mode);
    setBulkDragAnchor(anchor);
    setBulkDragBaseKeys(baseSelection);
    setBulkDragPreviewKeys(mergeBulkSelections(baseSelection, anchorRange, mode));
  }, [
    buildBulkRangeSelection,
    bulkEditMode,
    mergeBulkSelections,
    onBulkBlockedSelectionAttempt,
    selectedCellKeys,
  ]);

  const handleBulkCellMouseEnter = useCallback((rowKey: string, day: number) => {
    if (!bulkEditMode || !bulkDragAnchor) return;
    setBulkDragPreviewKeys(
      mergeBulkSelections(
        bulkDragBaseKeys,
        buildBulkRangeSelection(bulkDragAnchor, { rowKey, day }),
        bulkDragMode,
      ),
    );
  }, [buildBulkRangeSelection, bulkDragAnchor, bulkDragBaseKeys, bulkDragMode, bulkEditMode, mergeBulkSelections]);

  if (compact && viewMode === 'objects') {
    const jsDow = new Date(year, month - 1, 1).getDay();
    const firstDayOffset = (jsDow + 6) % 7;
    const formatHourCell = (hours: number): string => {
      if (hours <= 0) return '';
      return String(Math.round(hours));
    };

    return (
      <div className="ts-table-container">
        <div className="ts-table-header-bar ts-table-header-bar--mobile">
          <h3 className="ts-table-title">По объектам</h3>
          <div className="ts-mobile-list-hint">
            {employeeRows.length > 0 ? `${employeeRows.length} чел. • часы по объектам` : 'Нет данных за выбранный период'}
          </div>
        </div>

        <div className="ts-mobile-list">
          {employeeRows.map((row, index) => {
            const sortedObjects = [...row.objectRows]
              .map(objRow => {
                let total = 0;
                for (const entry of objRow.days.values()) {
                  total += getObjectVisibleHours(entry) || 0;
                }
                return { objRow, total };
              })
              .sort((a, b) => b.total - a.total)
              .map(x => x.objRow);
            const [topObj, bottomObj] = sortedObjects;
            const extraObjects = sortedObjects.slice(2);
            const employeeIndex = index + 1;
            const displayName = formatTimesheetEmployeeName(row.employee.full_name);

            return (
              <article key={row.employee.id} className="ts-mobile-card ts-mobile-card--expanded">
                <div className="ts-mobile-card-header">
                  <div className="ts-mobile-card-name-row">
                    <span className="ts-employee-index">{employeeIndex}.</span>
                    <div className="ts-mobile-card-name">{displayName}</div>
                  </div>
                </div>

                {sortedObjects.length === 0 ? (
                  <div className="ts-mobile-empty">Нет отметок по объектам</div>
                ) : (
                  <>
                    <div className="ts-mobile-weekdays-header" aria-hidden>
                      <span>Пн</span>
                      <span>Вт</span>
                      <span>Ср</span>
                      <span>Чт</span>
                      <span>Пт</span>
                      <span className="ts-mobile-weekday--weekend">Сб</span>
                      <span className="ts-mobile-weekday--weekend">Вс</span>
                    </div>
                    <div className="ts-mobile-days">
                      {Array.from({ length: firstDayOffset }).map((_, i) => (
                        <div key={`pad-${row.employee.id}-${i}`} className="ts-mobile-day-empty" aria-hidden />
                      ))}
                      {days.map(day => {
                        const topEntry = topObj ? topObj.days.get(day) || null : null;
                        const bottomEntry = bottomObj ? bottomObj.days.get(day) || null : null;
                        const topHours = topEntry ? getObjectVisibleHours(topEntry) : 0;
                        const bottomHours = bottomEntry ? getObjectVisibleHours(bottomEntry) : 0;
                        const hasAny = topHours > 0 || bottomHours > 0;
                        const weekend = isWeekend(year, month, day);
                        const today = isToday(year, month, day);
                        const clickEntry = topEntry || bottomEntry;
                        const clickObj = topEntry ? topObj : bottomObj;
                        const classes = ['ts-mobile-day-btn', 'ts-mobile-day-btn--dual'];
                        if (weekend) classes.push('ts-day--weekend');
                        if (today) classes.push('ts-day--today');
                        if (hasAny) classes.push('ts-day--full');

                        return (
                          <button
                            key={`obj-${row.employee.id}-${day}`}
                            type="button"
                            className={classes.join(' ')}
                            onClick={() => {
                              if (clickEntry && clickObj) {
                                onObjectDayClick(row.employee, day, {
                                  object_key: clickObj.object_key,
                                  object_id: clickObj.object_id,
                                  object_name: clickObj.object_name,
                                }, clickEntry);
                              } else {
                                onDayClick(row.employee, day, row.days.get(day) || null);
                              }
                            }}
                          >
                            <span className="ts-mobile-day-num">{day}</span>
                            <span className="ts-mobile-day-dual-top">{formatHourCell(topHours) || '·'}</span>
                            {bottomObj && (
                              <span className="ts-mobile-day-dual-bottom">{formatHourCell(bottomHours) || '·'}</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                    <div className="ts-mobile-objects-legend">
                      {topObj && (
                        <div className="ts-mobile-objects-legend-row">
                          <span className="ts-mobile-objects-legend-marker">↑</span>
                          <span className="ts-mobile-objects-legend-name">{topObj.object_name}</span>
                        </div>
                      )}
                      {bottomObj && (
                        <div className="ts-mobile-objects-legend-row">
                          <span className="ts-mobile-objects-legend-marker">↓</span>
                          <span className="ts-mobile-objects-legend-name">{bottomObj.object_name}</span>
                        </div>
                      )}
                      {extraObjects.length > 0 && (
                        <div className="ts-mobile-objects-legend-extra">
                          + ещё {extraObjects.length} {extraObjects.length === 1 ? 'объект' : 'объекта'}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </article>
            );
          })}

          {employeeRows.length === 0 && (
            <div className="ts-mobile-empty">Нет сотрудников для отображения</div>
          )}
        </div>
      </div>
    );
  }

  if (compact) {
    return (
      <div className="ts-table-container">
        <div className="ts-table-header-bar ts-table-header-bar--mobile">
          <h3 className="ts-table-title">Сотрудники</h3>
          <div className="ts-mobile-list-hint">
            {employeeRows.length > 0 ? `${employeeRows.length} чел. • откройте дни по сотруднику` : 'Нет данных за месяц'}
          </div>
        </div>

        <div className="ts-mobile-list">
          {employeeRows.map((row, index) => {
            const expanded = activeExpandedEmployeeIds.has(row.employee.id);
            const employeeIndex = index + 1;
            const displayName = formatTimesheetEmployeeName(row.employee.full_name);
            const stat = employeeStatsMap.get(row.employee.id);

            return (
              <article
                key={row.employee.id}
                className={`ts-mobile-card${expanded ? ' ts-mobile-card--expanded' : ''}`}
              >
                <div className="ts-mobile-card-header">
                  <div className="ts-mobile-card-name-row">
                    <span className="ts-employee-index">{employeeIndex}.</span>
                    <div className="ts-mobile-card-name">{displayName}</div>
                    {row.employee.transferred_out_date && (
                      <span className="ts-employee-badge ts-employee-badge--transfer" title={`Переведён ${formatBadgeDate(row.employee.transferred_out_date)}`}>
                        Переведён {formatBadgeDate(row.employee.transferred_out_date)}
                      </span>
                    )}
                    {row.employee.excluded_from_timesheet_date && !row.employee.transferred_out_date && (
                      <span className="ts-employee-badge ts-employee-badge--excluded" title={`Исключён с ${formatBadgeDate(row.employee.excluded_from_timesheet_date)}`}>
                        Исключён {formatBadgeDate(row.employee.excluded_from_timesheet_date)}
                      </span>
                    )}
                    {stat && (
                      <span
                        className={`ts-mobile-deviation ${getDeviationCellClass(stat.deviation_hours)}`}
                        title={`План ${stat.norm_hours.toFixed(1)} ч, факт ${stat.fact_hours.toFixed(1)} ч`}
                      >
                        {formatDeviationHours(stat.deviation_hours)}
                      </span>
                    )}
                    <button
                      type="button"
                      className="ts-mobile-chip-btn"
                      onClick={() => toggleEmployeeExpanded(row.employee.id)}
                      aria-expanded={expanded}
                      title={expanded ? 'Скрыть дни' : 'Показать дни'}
                      aria-label={expanded ? 'Скрыть дни' : 'Показать дни'}
                    >
                      {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                    </button>
                  </div>
                  <div className="ts-mobile-header-actions">
                    <button
                      type="button"
                      className="ts-mobile-chip-btn"
                      onClick={() => onEmployeeClick(row.employee)}
                      title="Детализация"
                      aria-label="Детализация"
                    >
                      <Menu size={16} />
                    </button>
                    {canManageTeam && onExcludeEmployee && (
                      <button
                        type="button"
                        className="ts-mobile-exclude-btn"
                        onClick={() => onExcludeEmployee(row.employee)}
                        disabled={pendingEmployeeId === row.employee.id}
                        title="Исключить"
                        aria-label="Исключить"
                      >
                        <UserMinus size={16} />
                      </button>
                    )}
                  </div>
                </div>

                {expanded && (() => {
                  const jsDow = new Date(year, month - 1, 1).getDay();
                  const firstDayOffset = (jsDow + 6) % 7;
                  return (
                  <div className="ts-mobile-days-wrap">
                    <div className="ts-mobile-days-caption">
                      Нажмите на день, чтобы посмотреть или скорректировать отметку
                    </div>
                    <div className="ts-mobile-weekdays-header" aria-hidden>
                      <span>Пн</span>
                      <span>Вт</span>
                      <span>Ср</span>
                      <span>Чт</span>
                      <span>Пт</span>
                      <span className="ts-mobile-weekday--weekend">Сб</span>
                      <span className="ts-mobile-weekday--weekend">Вс</span>
                    </div>
                    <div className="ts-mobile-days">
                      {Array.from({ length: firstDayOffset }).map((_, i) => (
                        <div key={`pad-${i}`} className="ts-mobile-day-empty" aria-hidden />
                      ))}
                      {days.map(day => {
                        const sched = getScheduleForTimesheetDay(schedules, dailySchedules, row.employee.id, year, month, day);
                        const dayOff = isScheduleDayOff(sched, calendar, year, month, day);
                        const today = isToday(year, month, day);
                        const future = isFutureDay(year, month, day);
                        const entry = row.days.get(day) || null;
                        const thresholdHours = getFullDayThresholdHoursForDay(sched, calendar, year, month, day);
                        const inactive = isDayInactiveForEmployee(row.employee, year, month, day);
                        const baseCls = getDayCellClass(entry, dayOff, today, future, thresholdHours);
                        const text = getDayCellTextMobile(entry, dayOff);
                        const title = getDayCellTitle(entry, dayOff);
                        const inactiveCls = inactive ? ' ts-day--inactive' : '';
                        const isoDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                        const problemCls = problemDates?.red?.has(isoDate)
                          ? ' ts-day--problem-red'
                          : problemDates?.yellow?.has(isoDate)
                            ? ' ts-day--problem-yellow'
                            : '';

                        return (
                          <button
                            key={day}
                            type="button"
                            className={`${baseCls}${inactiveCls}${problemCls} ts-mobile-day-btn`}
                            title={title}
                            disabled={inactive}
                            onClick={() => !inactive && onDayClick(row.employee, day, entry)}
                          >
                            <span className="ts-mobile-day-num">{day}</span>
                            <span className="ts-mobile-day-value">{text || '·'}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  );
                })()}
              </article>
            );
          })}

          {employeeRows.length === 0 && (
            <div className="ts-mobile-empty">Нет сотрудников для отображения</div>
          )}
        </div>
      </div>
    );
  }

  if (viewMode === 'objects') {
    return (
      <div className="ts-table-container">
        <div className="ts-table-header-bar">
          <h3 className="ts-table-title">Табель по объектам</h3>
          <div className="ts-legend">
            <div className="ts-legend-item">
              <span className="ts-legend-dot ts-legend-dot--full">8</span>Распределённые часы
            </div>
            <div className="ts-legend-item">
              <span className="ts-legend-dot ts-legend-dot--corrected">К</span>Корректировка
            </div>
            <div className="ts-legend-item">
              <span className="ts-legend-dot ts-legend-dot--weekend">—</span>Выходной
            </div>
          </div>
        </div>

        <div className="ts-table-scroll">
          <table className={`ts-table ts-table--objects${bulkEditMode ? ' ts-table--bulk-mode' : ''}`}>
            <thead>
              <tr>
                <th className="ts-col-sticky">Объект / сотрудник</th>
                {days.map(day => {
                  const weekend = isWeekend(year, month, day);
                  const today = isToday(year, month, day);
                  let cls = '';
                  if (today) cls = 'ts-th--today';
                  else if (weekend) cls = 'ts-th--weekend';
                  return (
                    <th key={day} className={cls}>
                      {day}<br />
                      <span style={{ fontWeight: 400 }}>{getWeekdayShort(year, month, day)}</span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {objectViewGroups.map(group => (
                <Fragment key={group.object_key}>
                  <tr className="ts-object-group-row">
                    <td className="ts-col-sticky ts-object-group-cell" colSpan={days.length + 1}>
                      <span className="ts-object-group-name">{group.object_name}</span>
                      <span className="ts-object-group-meta">{group.rows.length} чел.</span>
                    </td>
                  </tr>
                  {group.rows.map(row => (
                    <tr key={`${group.object_key}_${row.employee.id}`}>
                      <td
                        className="ts-col-sticky ts-object-employee-cell"
                        onClick={bulkEditMode ? undefined : () => onEmployeeClick(row.employee)}
                      >
                        <div className="ts-object-employee-name" title={row.employee.full_name}>
                          {formatTimesheetEmployeeName(row.employee.full_name)}
                        </div>
                      </td>
                      {days.map(day => {
                        const objectEntry = row.days.get(day) || null;
                        const sched = getScheduleForTimesheetDay(schedules, dailySchedules, row.employee.id, year, month, day);
                        const dayOff = isScheduleDayOff(sched, calendar, year, month, day);
                        const future = isFutureDay(year, month, day);
                        const text = objectEntry ? formatCellHM(getObjectVisibleHours(objectEntry)) : '';
                        const targeted = bulkEditMode && activeSelectedCellKeys.has(getObjectBulkCellKey(row.employee.id, row.object_key, day));
                        const title = bulkEditMode
                          ? [getObjectCellTitle(objectEntry, row.object_name), 'Зажмите левую кнопку мыши и протяните диапазон для массовой корректировки по объектам']
                            .filter(Boolean)
                            .join(' • ')
                          : getObjectCellTitle(objectEntry, row.object_name);
                        const isClickable = !future && !dayOff;
                        const isBlocked = row.isSynthetic;
                        return (
                          <td
                            key={`${group.object_key}_${row.employee.id}_${day}`}
                            className={`ts-day ts-day--object${objectEntry?.is_correction ? ' ts-day--corrected' : ''}${targeted ? ' ts-day--bulk-target' : ''}${bulkEditMode && !isBlocked ? ' ts-day--bulk-selectable' : ''}`}
                            title={title}
                            onMouseDown={bulkEditMode && isClickable ? (event) => handleBulkCellMouseDown(
                              event,
                              getObjectBulkRowKey(row.employee.id, row.object_key),
                              day,
                              isBlocked,
                            ) : undefined}
                            onMouseEnter={bulkEditMode && isClickable ? () => handleBulkCellMouseEnter(
                              getObjectBulkRowKey(row.employee.id, row.object_key),
                              day,
                            ) : undefined}
                            onClick={!bulkEditMode && isClickable ? () => {
                              if (row.isSynthetic) {
                                onDayClick(row.employee, day, row.dailyEntries.get(day) || null);
                                return;
                              }
                              onObjectDayClick(row.employee, day, {
                                object_key: row.object_key,
                                object_id: row.object_id,
                                object_name: row.object_name,
                              }, objectEntry);
                            } : undefined}
                          >
                            {text}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </Fragment>
              ))}
              {objectViewGroups.length === 0 && (
                <tr>
                  <td colSpan={days.length + 1} className="ts-loading">
                    Нет объектов для отображения
                  </td>
                </tr>
              )}
            </tbody>
          </table>
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
            <span className="ts-legend-dot ts-legend-dot--incomplete-skud">Н</span>СКУД без пары
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
              {days.map(day => {
                const weekend = isWeekend(year, month, day);
                const today = isToday(year, month, day);
                let cls = '';
                if (today) cls = 'ts-th--today';
                else if (weekend) cls = 'ts-th--weekend';
                return (
                  <th key={day} className={cls}>
                    {day}<br />
                    <span style={{ fontWeight: 400 }}>{getWeekdayShort(year, month, day)}</span>
                  </th>
                );
              })}
              {showDeviationColumn && (
                <th className="ts-col-deviation-sticky" title="План минус факт. Положительное — недоработка, отрицательное — переработка.">
                  Откл.
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {employeeRows.map((row, index) => {
              const employeeIndex = index + 1;
              const displayName = formatTimesheetEmployeeName(row.employee.full_name);
              const expanded = activeExpandedEmployeeIds.has(row.employee.id);

              return (
                <Fragment key={row.employee.id}>
                  <tr>
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
                        {(row.employee.transferred_out_date
                          || row.employee.excluded_from_timesheet_date
                          || (canManageTeam && onExcludeEmployee)) && (
                          <div
                            className="ts-employee-meta-row"
                            onClick={event => event.stopPropagation()}
                          >
                            {row.employee.transferred_out_date && (
                              <span className="ts-employee-badge ts-employee-badge--transfer" title={`Переведён ${formatBadgeDate(row.employee.transferred_out_date)}`}>
                                Пер. {formatBadgeDate(row.employee.transferred_out_date)}
                              </span>
                            )}
                            {row.employee.excluded_from_timesheet_date && !row.employee.transferred_out_date && (
                              <span className="ts-employee-badge ts-employee-badge--excluded" title={`Исключён с ${formatBadgeDate(row.employee.excluded_from_timesheet_date)}`}>
                                Искл. {formatBadgeDate(row.employee.excluded_from_timesheet_date)}
                              </span>
                            )}
                            {canManageTeam && onExcludeEmployee && (
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
                            )}
                          </div>
                        )}
                      </div>
                    </td>
                    {days.map(day => {
                      const sched = getScheduleForTimesheetDay(schedules, dailySchedules, row.employee.id, year, month, day);
                      const dayOff = isScheduleDayOff(sched, calendar, year, month, day);
                      const today = isToday(year, month, day);
                      const future = isFutureDay(year, month, day);
                      const entry = row.days.get(day) || null;
                      const thresholdHours = getFullDayThresholdHoursForDay(sched, calendar, year, month, day);
                      const targeted = bulkEditMode && activeSelectedCellKeys.has(getEmployeeBulkCellKey(row.employee.id, day));
                      const inactive = isDayInactiveForEmployee(row.employee, year, month, day);
                      const inactiveCls = inactive ? ' ts-day--inactive' : '';
                      const isoDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                      const problemCls = problemDates?.red?.has(isoDate)
                        ? ' ts-day--problem-red'
                        : problemDates?.yellow?.has(isoDate)
                          ? ' ts-day--problem-yellow'
                          : '';
                      const cls = `${getDayCellClass(entry, dayOff, today, future, thresholdHours)}${inactiveCls}${problemCls}${targeted ? ' ts-day--bulk-target' : ''}${bulkEditMode && !inactive ? ' ts-day--bulk-selectable' : ''}`;
                      const text = inactive ? '' : getDayCellText(entry, dayOff);
                      const title = getDayCellTitle(entry, dayOff);
                      const bulkTitle = bulkEditMode && !inactive
                        ? [title, 'Зажмите левую кнопку мыши и протяните диапазон для массовой корректировки']
                          .filter(Boolean)
                          .join(' • ')
                        : title;

                      return (
                        <td
                          key={day}
                          className={cls}
                          title={inactive ? 'Сотрудник не в отделе на эту дату' : bulkTitle}
                          onMouseDown={bulkEditMode && !inactive ? (event) => handleBulkCellMouseDown(
                            event,
                            getEmployeeBulkRowKey(row.employee.id),
                            day,
                            splitDayKeys.has(`${row.employee.id}_${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`),
                          ) : undefined}
                          onMouseEnter={bulkEditMode && !inactive ? () => handleBulkCellMouseEnter(
                            getEmployeeBulkRowKey(row.employee.id),
                            day,
                          ) : undefined}
                          onClick={bulkEditMode || inactive ? undefined : () => onDayClick(row.employee, day, entry)}
                        >
                          {text}
                        </td>
                      );
                    })}
                    {showDeviationColumn && (() => {
                      const stat = employeeStatsMap.get(row.employee.id);
                      if (!stat) {
                        return <td className="ts-col-deviation-sticky ts-day--deviation-zero">—</td>;
                      }
                      const dev = stat.deviation_hours;
                      const cls = getDeviationCellClass(dev);
                      const tip = `План ${stat.norm_hours.toFixed(1)} ч, факт ${stat.fact_hours.toFixed(1)} ч`;
                      return (
                        <td className={`ts-col-deviation-sticky ${cls}`} title={tip}>
                          {formatDeviationHours(dev)}
                        </td>
                      );
                    })()}
                  </tr>
                  {expanded && row.hasExpandableObjects && row.objectRows.map(objectRow => (
                    <tr key={`${row.employee.id}_${objectRow.object_key}`} className="ts-object-row">
                      <td className="ts-col-sticky ts-object-cell">
                        <div className="ts-object-name" title={objectRow.object_name}>
                          ↳ {objectRow.object_name}
                        </div>
                      </td>
                      {days.map(day => {
                        const objectEntry = objectRow.days.get(day) || null;
                        const sched = getScheduleForTimesheetDay(schedules, dailySchedules, row.employee.id, year, month, day);
                        const dayOff = isScheduleDayOff(sched, calendar, year, month, day);
                        const future = isFutureDay(year, month, day);
                        const text = objectEntry ? formatCellHM(getObjectVisibleHours(objectEntry)) : '';
                        const title = getObjectCellTitle(objectEntry, objectRow.object_name);
                        const isClickable = !future && !dayOff;
                        return (
                          <td
                            key={`${objectRow.object_key}_${day}`}
                            className={`ts-day ts-day--object${objectEntry?.is_correction ? ' ts-day--corrected' : ''}`}
                            title={title}
                            onClick={isClickable ? () => onObjectDayClick(row.employee, day, {
                              object_key: objectRow.object_key,
                              object_id: objectRow.object_id,
                              object_name: objectRow.object_name,
                            }, objectEntry) : undefined}
                          >
                            {text}
                          </td>
                        );
                      })}
                      {showDeviationColumn && <td className="ts-col-deviation-sticky" />}
                    </tr>
                  ))}
                </Fragment>
              );
            })}
            {employeeRows.length === 0 && (
              <tr>
                <td colSpan={days.length + 1 + (showDeviationColumn ? 1 : 0)} className="ts-loading">
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
