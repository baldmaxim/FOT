import { Fragment, type FC, type MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
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
  isPreHolidayForSchedule,
} from '../../utils/scheduleUtils';
import { formatTimesheetEmployeeName } from '../../utils/timesheetDisplay';
import { selectVisibleHours, selectVisibleObjectHours, formatHoursLabel } from '../../utils/hoursDisplay';
import { getDayStatus, STATUS_TO_GRID_CLASS, STATUS_LABEL_RU } from '../../utils/dayStatus';
import { useAuth } from '../../contexts/AuthContext';
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
  approvalStatusByDate?: Map<string, 'draft' | 'submitted' | 'approved' | 'returned' | 'rejected'>;
  problemDates?: { red?: Set<string>; yellow?: Set<string> };
  outOfPeriodDates?: Set<string>;
  highlightedCell?: { employeeId: number; date: string } | null;
  canManageTeam?: boolean;
  pendingEmployeeId?: number | null;
  departmentName?: string;
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
  totalHours: number;
}

interface IBulkCellCoord {
  rowKey: string;
  day: number;
}

const EMPTY_CELL_SELECTION = new Set<string>();

const getEmployeeBulkRowKey = (employeeId: number): string => `employee:${employeeId}`;
const getObjectBulkRowKey = (employeeId: number, objectKey: string): string => `object:${employeeId}:${encodeURIComponent(objectKey)}`;
const getEmployeeBulkCellKey = (employeeId: number, day: number): string => `${getEmployeeBulkRowKey(employeeId)}:${day}`;
const getObjectBulkCellKey = (employeeId: number, objectKey: string, day: number): string => (
  `${getObjectBulkRowKey(employeeId, objectKey)}:${day}`
);

type ParsedRowKey =
  | { kind: 'employee'; employeeId: number }
  | { kind: 'object'; employeeId: number; objectKey: string };

const parseBulkRowKey = (rowKey: string): ParsedRowKey | null => {
  const parts = rowKey.split(':');
  if (parts[0] === 'employee' && parts.length === 2) {
    const employeeId = Number.parseInt(parts[1] || '', 10);
    return Number.isFinite(employeeId) ? { kind: 'employee', employeeId } : null;
  }
  if (parts[0] === 'object' && parts.length === 3) {
    const employeeId = Number.parseInt(parts[1] || '', 10);
    const objectKey = decodeURIComponent(parts[2] || '');
    if (!Number.isFinite(employeeId) || !objectKey) return null;
    return { kind: 'object', employeeId, objectKey };
  }
  return null;
};

// Per-role «фактические vs урезанные» часы. Делегируем единому хелперу, чтобы
// весь UI был согласован. Подмена через module-level flag — TimesheetGrid
// инстанцируется единожды на дашборде, race conditions не ожидаются.
let showActualHoursFlag = false;
const getVisibleHours = (entry: TimesheetEntry | null | undefined): number | null => (
  selectVisibleHours(entry ?? null, showActualHoursFlag)
);
const getObjectVisibleHours = (entry: TimesheetObjectEntry | null | undefined): number => (
  selectVisibleObjectHours(entry ?? null, showActualHoursFlag)
);

const hasPositiveHours = (value: number | null | undefined): boolean => (
  typeof value === 'number' && value > 0.001
);

const formatDeviationHours = (value: number): string => {
  const totalMinutes = Math.round(Math.abs(value) * 60);
  if (totalMinutes === 0) return '0м';
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}м`;
  if (m === 0) return `${h}ч`;
  return `${h}ч ${m}м`;
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
  const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  // Верхняя граница: дни после перевода/исключения.
  const cutoff = getInactiveFromDate(employee);
  if (cutoff && dateStr >= cutoff) return true;
  // Нижняя граница: дни до прихода в отдел (бэк проставляет joined_date только для настоящих переводов/уволенных).
  const joined = employee.joined_date ?? null;
  if (joined && dateStr < joined) return true;
  return false;
};

const getDeviationCellClass = (deviation: number): string => {
  if (deviation > 0.05) return 'ts-day--deviation-undertime';
  if (deviation < -0.05) return 'ts-day--deviation-overtime';
  return 'ts-day--deviation-zero';
};

const formatCellHM = (decimal: number): string => String(Math.round(decimal));

const getSectionLabel = (
  source: NonNullable<TimesheetEmployee['source']>,
  departmentName?: string,
): string | null => {
  if (source === 'supervisor') return 'Начальник участка';
  if (source === 'self') return 'Руководитель';
  if (source === 'direct_report') return 'Мои сотрудники';
  if (source === 'skud_presence') return 'ЛИНИЯ-Общестрой';
  return departmentName ?? 'Сотрудники отдела';
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
  sick_worked: 'РБ',
  manual: '',
};

const getDayCellClass = (
  entry: TimesheetEntry | null,
  weekend: boolean,
  today: boolean,
  future: boolean,
  thresholdHours = 8,
  periodApprovalStatus?: string,
  // markCorrection=false для объектных ячеек: метку (оранжевый треугольник) там
  // задаёт ТОЛЬКО objectEntry.is_correction, а не дневная запись. Иначе day-level
  // корректировка течёт на все объекты дня (фантомы на «чужих» объектах, #3).
  markCorrection = true,
): string => {
  const classes = ['ts-day'];
  if (today) classes.push('ts-day--today');

  const status = getDayStatus(entry, {
    showActualHours: showActualHoursFlag,
    fullDayThresholdHours: thresholdHours,
    isScheduledDayOff: weekend,
    isFuture: future,
  });
  classes.push(STATUS_TO_GRID_CLASS[status]);

  if (markCorrection && entry?.is_correction) classes.push('ts-day--corrected');
  if (entry?.approval_status === 'pending') classes.push('ts-day--approval-pending');
  else if (entry?.approval_status === 'approved') classes.push('ts-day--approval-approved');
  else if (entry?.approval_status === 'rejected') classes.push('ts-day--approval-rejected');
  if (entry && ((entry.travel_problematic_segments || 0) > 0 || (entry.travel_delay_minutes || 0) > 0)) {
    classes.push('ts-day--travel-issue');
  }
  if (periodApprovalStatus === 'submitted') classes.push('ts-day--in-submitted-period');
  else if (periodApprovalStatus === 'approved') classes.push('ts-day--in-approved-period');
  return classes.join(' ');
};

// Корректировка, обнуляющая день («Корректировка табеля»/«Обнулить день»/«Неявка» с 0 ч),
// в табеле = прочерк «—», а не «Н»/«0». Реальный прогул (status absent без корректировки)
// и буквенные статусы (От/Б/В/С/У) не затрагиваются.
const isZeroingCorrection = (entry: TimesheetEntry, visibleHours: number | null): boolean =>
  Boolean(entry.is_correction)
  && (visibleHours == null || visibleHours <= 0)
  && (entry.status === 'manual' || entry.status === 'absent');

const getDayCellText = (entry: TimesheetEntry | null, weekend: boolean): string => {
  const visibleHours = getVisibleHours(entry);
  if (weekend && !entry) return '—';
  if (!entry) return '';
  if (isZeroingCorrection(entry, visibleHours)) return '—';
  const special = STATUS_CELL_TEXT[entry.status];
  if (special) return special;
  if (visibleHours != null) return formatCellHM(visibleHours);
  return '';
};

// Числовой вклад дневной ячейки в сумму по строке. ЗЕРКАЛИТ getDayCellText:
// возвращает то самое округлённое число, что видно в ячейке, иначе 0
// (прочерк/пусто/обнуляющая корректировка/буквенный статус). Держать в синхроне
// с getDayCellText, чтобы итог совпадал с суммой видимых цифр.
const getDayCellHours = (entry: TimesheetEntry | null): number => {
  const visibleHours = getVisibleHours(entry);
  if (!entry) return 0;
  if (isZeroingCorrection(entry, visibleHours)) return 0;
  if (STATUS_CELL_TEXT[entry.status]) return 0;
  if (visibleHours != null) return Math.round(visibleHours);
  return 0;
};

const getDayCellTextMobile = (entry: TimesheetEntry | null, weekend: boolean): string => {
  const visibleHours = getVisibleHours(entry);
  if (weekend && !entry) return '—';
  if (!entry) return '';
  if (isZeroingCorrection(entry, visibleHours)) return '—';
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
    parts.push(`Часы: ${formatHoursLabel(Math.round(visibleHours))}`);
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
    parts.push(`Превышение лимита передвижения: ${formatHoursLabel((entry.travel_delay_minutes || 0) / 60)}`);
  }
  if ((entry.travel_problematic_segments || 0) > 0) {
    parts.push(`Есть передвижения без привязки объекта: ${entry.travel_problematic_segments}`);
  }
  if (entry.is_correction) {
    parts.push('Есть корректировка');
  }
  if (entry.approval_status === 'pending') {
    parts.push('На согласовании администратора');
  } else if (entry.approval_status === 'approved') {
    parts.push('Согласовано администратором');
  } else if (entry.approval_status === 'rejected') {
    parts.push('Корректировка отклонена');
  }

  return parts.length > 0 ? parts.join(' • ') : undefined;
};

const getObjectCellTitle = (entry: TimesheetObjectEntry | null, objectName?: string): string | undefined => {
  if (!entry && !objectName) return undefined;
  const parts = [`Объект: ${objectName || entry?.object_name || 'не указан'}`];
  if (entry) {
    parts.push(`Часы: ${formatHoursLabel(Math.round(getObjectVisibleHours(entry)))}`);
    if (entry.is_correction) {
      parts.push('Есть корректировка по объекту');
    }
  }
  return parts.join(' • ');
};

// Цвет ячейки в табеле по объектам определяется СУММАРНЫМ статусом дня сотрудника
// (work/sick/vacation/...), а не часами конкретного объекта. Это нужно, чтобы все
// строки одного сотрудника за один день были одного цвета — даже если он был на
// нескольких объектах. dailyEntry приходит из row.dailyEntries — единая дневная
// запись с агрегированными часами по сотруднику.
const getObjectCellText = (
  dailyEntry: TimesheetEntry | null,
  objectEntry: TimesheetObjectEntry | null,
  dayOff: boolean,
): string => {
  if (dailyEntry) {
    if (isZeroingCorrection(dailyEntry, getVisibleHours(dailyEntry))) return '—';
    const special = STATUS_CELL_TEXT[dailyEntry.status];
    if (special) return special;
  }
  if (objectEntry) return formatCellHM(getObjectVisibleHours(objectEntry));
  if (dayOff) return '—';
  return '';
};

// Числовой вклад объектной ячейки в сумму. ЗЕРКАЛИТ getObjectCellText: 0 при
// обнуляющей корректировке/буквенном статусе дня, иначе округлённые часы объекта.
const getObjectCellHours = (
  dailyEntry: TimesheetEntry | null,
  objectEntry: TimesheetObjectEntry | null,
): number => {
  if (dailyEntry) {
    if (isZeroingCorrection(dailyEntry, getVisibleHours(dailyEntry))) return 0;
    if (STATUS_CELL_TEXT[dailyEntry.status]) return 0;
  }
  if (objectEntry) return Math.round(getObjectVisibleHours(objectEntry));
  return 0;
};

const getObjectCellTitleWithStatus = (
  dailyEntry: TimesheetEntry | null,
  objectEntry: TimesheetObjectEntry | null,
  objectName: string | undefined,
  dayOff: boolean,
  threshold: number,
  future: boolean,
): string | undefined => {
  const baseTitle = getObjectCellTitle(objectEntry, objectName);
  const status = getDayStatus(dailyEntry, {
    showActualHours: showActualHoursFlag,
    fullDayThresholdHours: threshold,
    isScheduledDayOff: dayOff,
    isFuture: future,
  });
  const label = STATUS_LABEL_RU[status];
  return [label, baseTitle].filter(Boolean).join(' • ') || undefined;
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
  approvalStatusByDate,
  problemDates,
  outOfPeriodDates,
  highlightedCell = null,
  canManageTeam = false,
  pendingEmployeeId = null,
  departmentName,
  onBulkSelectionChange,
  onBulkBlockedSelectionAttempt,
  onEmployeeClick,
  onExcludeEmployee,
  onDayClick,
  onObjectDayClick,
}) => {
  const { showActualHours } = useAuth();
  // Синхронизируем module-level flag, к которому обращаются helper-функции
  // верхнего уровня (getVisibleHours/getObjectVisibleHours и зависящие от них
  // getDayCellClass/Text/Title). Flag намеренно живёт вне компонента, чтобы
  // pure-helper функции из этого же файла могли его читать без пропов.
  if (showActualHoursFlag !== showActualHours) {
    // eslint-disable-next-line react-hooks/globals -- module-level flag читается helper'ами вне компонента
    showActualHoursFlag = showActualHours;
  }
  const daysCount = getDaysInMonth(year, month);
  const days = visibleDays || Array.from({ length: daysCount }, (_, i) => i + 1);
  const compactInlineExclude = days.length > 16;
  const employeeStatsMap = useMemo(() => {
    const map = new Map<number, IEmployeeStats>();
    for (const stat of employeeStats) {
      map.set(stat.employee_id, stat);
    }
    return map;
  }, [employeeStats]);
  const showDeviationColumn = viewMode === 'employees';
  const showSumColumn = viewMode === 'employees';
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
        totalHours: 0,
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

    for (const objectEntry of objectEntries) {
      if (!visibleDateSet.has(objectEntry.work_date)) continue;
      const employee = employeeById.get(objectEntry.employee_id);
      if (!employee) continue;
      const normalizedName = objectEntry.object_name?.trim();
      // Записи без привязки к объекту не показываем в режиме «по объектам» —
      // они должны быть либо day-level (виден в «по сотрудникам»), либо
      // мигрированы в конкретный объект.
      if (!normalizedName) continue;

      const group = ensureGroup(
        objectEntry.object_key,
        objectEntry.object_id,
        normalizedName,
        false,
      );
      const row = ensureRow(group, employee, false);
      const day = Number.parseInt(objectEntry.work_date.slice(-2), 10);
      row.days.set(day, {
        ...objectEntry,
        object_name: normalizedName,
      });
    }

    return [...groups.values()]
      .map(group => {
        const rows = [...group.rows].sort((left, right) => compareEmployeeNames(left.employee, right.employee));
        let totalHours = 0;
        for (const row of rows) {
          for (const day of days) {
            if (isDayInactiveForEmployee(row.employee, year, month, day)) continue;
            totalHours += getObjectCellHours(row.dailyEntries.get(day) || null, row.days.get(day) || null);
          }
        }
        return { ...group, rows, totalHours };
      })
      .sort((left, right) => left.object_name.localeCompare(right.object_name, 'ru'));
    // showActualHours влияет на getObjectVisibleHours внутри getObjectCellHours.
  }, [days, employees, employeeRows, objectEntries, year, month, showActualHours]);

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
  const expandedObjectRowsByEmployee = useMemo(() => {
    const map = new Map<number, { rowKey: string; objectKey: string }[]>();
    for (const row of employeeRows) {
      if (!activeExpandedEmployeeIds.has(row.employee.id)) continue;
      if (!row.hasExpandableObjects) continue;
      map.set(
        row.employee.id,
        row.objectRows.map(objectRow => ({
          rowKey: getObjectBulkRowKey(row.employee.id, objectRow.object_key),
          objectKey: objectRow.object_key,
        })),
      );
    }
    return map;
  }, [employeeRows, activeExpandedEmployeeIds]);
  const dayIndexByValue = useMemo(() => (
    new Map(days.map((day, index) => [day, index]))
  ), [days]);
  const activeSelectedCellKeys = bulkDragPreviewKeys ?? selectedCellKeys;

  // Виртуализация строк desktop-табеля: рендерим только видимые строки, иначе
  // большой отдел (сотни сотрудников × дни) фризит main-thread при смене отдела.
  // measureElement на <tbody> учитывает реальную высоту группы (вкл. раскрытые объекты).
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLTableSectionElement>({
    count: employeeRows.length,
    getScrollElement: () => tableScrollRef.current,
    estimateSize: () => 34,
    overscan: 12,
  });

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

  const buildBulkRangeSelection = useCallback((anchor: IBulkCellCoord, current: IBulkCellCoord): Set<string> | null => {
    const anchorDayIndex = dayIndexByValue.get(anchor.day);
    const currentDayIndex = dayIndexByValue.get(current.day);

    if (anchorDayIndex == null || currentDayIndex == null) {
      return null;
    }

    const startDayIndex = Math.min(anchorDayIndex, currentDayIndex);
    const endDayIndex = Math.max(anchorDayIndex, currentDayIndex);
    const nextSelection = new Set<string>();

    if (viewMode === 'objects') {
      const anchorRowIndex = objectRowIndexByKey.get(anchor.rowKey);
      const currentRowIndex = objectRowIndexByKey.get(current.rowKey);
      if (anchorRowIndex == null || currentRowIndex == null) {
        return null;
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

    const anchorParsed = parseBulkRowKey(anchor.rowKey);
    const currentParsed = parseBulkRowKey(current.rowKey);
    if (!anchorParsed || !currentParsed) return null;

    if (anchorParsed.kind === 'object') {
      if (currentParsed.kind !== 'object' || currentParsed.employeeId !== anchorParsed.employeeId) {
        return null;
      }
      const list = expandedObjectRowsByEmployee.get(anchorParsed.employeeId);
      if (!list) return null;
      const anchorIdx = list.findIndex(item => item.rowKey === anchor.rowKey);
      const currentIdx = list.findIndex(item => item.rowKey === current.rowKey);
      if (anchorIdx < 0 || currentIdx < 0) return null;

      const startRowIdx = Math.min(anchorIdx, currentIdx);
      const endRowIdx = Math.max(anchorIdx, currentIdx);
      for (let rowIdx = startRowIdx; rowIdx <= endRowIdx; rowIdx += 1) {
        const item = list[rowIdx];
        if (!item) continue;
        for (let dayIndex = startDayIndex; dayIndex <= endDayIndex; dayIndex += 1) {
          const day = days[dayIndex];
          if (day == null) continue;
          nextSelection.add(getObjectBulkCellKey(anchorParsed.employeeId, item.objectKey, day));
        }
      }
      return nextSelection;
    }

    if (currentParsed.kind !== 'employee') return null;

    const anchorRowIndex = employeeRowIndexByKey.get(anchor.rowKey);
    const currentRowIndex = employeeRowIndexByKey.get(current.rowKey);
    if (anchorRowIndex == null || currentRowIndex == null) {
      return null;
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
    expandedObjectRowsByEmployee,
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
    const anchorRange = buildBulkRangeSelection(anchor, anchor) ?? new Set<string>();
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
    const range = buildBulkRangeSelection(bulkDragAnchor, { rowKey, day });
    if (range == null) return;
    setBulkDragPreviewKeys(
      mergeBulkSelections(
        bulkDragBaseKeys,
        range,
        bulkDragMode,
      ),
    );
  }, [buildBulkRangeSelection, bulkDragAnchor, bulkDragBaseKeys, bulkDragMode, bulkEditMode, mergeBulkSelections]);

  // Единая легенда для табелей по сотрудникам и по объектам — раскраска ячеек
  // одинаковая (см. getDayCellClass + dayStatus.ts), поэтому и легенда общая.
  const tableLegend = (
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
        <span className="ts-legend-dot ts-legend-dot--educational">У</span>Учебный отпуск
      </div>
      <div className="ts-legend-item">
        <span className="ts-legend-dot ts-legend-dot--remote">УУ</span>Удалёнка
      </div>
      <div className="ts-legend-item">
        <span className="ts-legend-dot ts-legend-dot--sick-worked">РБ</span>Работал на больничном
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
        <span className="ts-legend-dot ts-legend-dot--approval-pending" />На согласовании
      </div>
      <div className="ts-legend-item">
        <span className="ts-legend-dot ts-legend-dot--approval-approved" />Согласовано
      </div>
      <div className="ts-legend-item">
        <span className="ts-legend-dot ts-legend-dot--approval-rejected" />Отклонено
      </div>
      <div className="ts-legend-item">
        <span className="ts-legend-dot ts-legend-dot--travel-issue">!</span>Превышение лимита или проблема объекта
      </div>
    </div>
  );

  if (compact && viewMode === 'objects') {
    const firstDay = days[0] ?? 1;
    const jsDow = new Date(year, month - 1, firstDay).getDay();
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
                        const dailyEntry = row.days.get(day) || null;
                        const sched = getScheduleForTimesheetDay(schedules, dailySchedules, row.employee.id, year, month, day);
                        const dayOff = isScheduleDayOff(sched, calendar, year, month, day);
                        const today = isToday(year, month, day);
                        const future = isFutureDay(year, month, day);
                        const threshold = getFullDayThresholdHoursForDay(sched, calendar, year, month, day);
                        const clickEntry = topEntry || bottomEntry;
                        const clickObj = topEntry ? topObj : bottomObj;
                        const isoDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                        // markCorrection=false: метку даёт только корректировка самого объекта,
                        // а не дневная запись — иначе течёт на «чужие» объекты (#3).
                        const baseCls = getDayCellClass(dailyEntry, dayOff, today, future, threshold, approvalStatusByDate?.get(isoDate), false);
                        const objCorrected = Boolean(topEntry?.is_correction || bottomEntry?.is_correction);
                        const classes = [baseCls, 'ts-mobile-day-btn', 'ts-mobile-day-btn--dual'];
                        if (objCorrected) classes.push('ts-day--corrected');

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
            const currentSource = row.employee.source ?? 'department';
            const prevSource = index > 0
              ? (employeeRows[index - 1].employee.source ?? 'department')
              : null;
            const sectionLabel = currentSource !== prevSource ? getSectionLabel(currentSource, departmentName) : null;

            return (
              <Fragment key={row.employee.id}>
                {sectionLabel && (
                  <div className="ts-section-divider-mobile">{sectionLabel}</div>
                )}
              <article
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
                    {stat && (() => {
                      const normR = Math.round(stat.norm_hours);
                      const factR = Math.round(stat.fact_hours);
                      const devR = normR - factR;
                      return (
                        <span
                          className={`ts-mobile-deviation ${getDeviationCellClass(devR)}`}
                          title={`План ${formatHoursLabel(normR)}, факт ${formatHoursLabel(factR)}`}
                        >
                          {formatDeviationHours(devR)}
                        </span>
                      );
                    })()}
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
                  const firstDay = days[0] ?? 1;
                  const jsDow = new Date(year, month - 1, firstDay).getDay();
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
                        const preHoliday = isPreHolidayForSchedule(sched, calendar, year, month, day);
                        const today = isToday(year, month, day);
                        const future = isFutureDay(year, month, day);
                        const entry = row.days.get(day) || null;
                        const thresholdHours = getFullDayThresholdHoursForDay(sched, calendar, year, month, day);
                        const inactive = isDayInactiveForEmployee(row.employee, year, month, day);
                        const isoDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                        const baseCls = getDayCellClass(entry, dayOff, today, future, thresholdHours, approvalStatusByDate?.get(isoDate));
                        const text = getDayCellTextMobile(entry, dayOff);
                        const baseTitle = getDayCellTitle(entry, dayOff);
                        const title = preHoliday
                          ? [baseTitle, 'Предпраздничный день (−1ч)'].filter(Boolean).join(' • ')
                          : baseTitle;
                        const inactiveCls = inactive ? ' ts-day--inactive' : '';
                        const preHolidayCls = preHoliday ? ' ts-day--pre-holiday' : '';
                        const cellKey = `${row.employee.id}_${isoDate}`;
                        const problemCls = (problemDates?.red?.has(cellKey) || problemDates?.red?.has(isoDate))
                          ? ' ts-day--problem-red'
                          : (problemDates?.yellow?.has(cellKey) || problemDates?.yellow?.has(isoDate))
                            ? ' ts-day--problem-yellow'
                            : '';
                        const outCls = outOfPeriodDates?.has(isoDate) ? ' ts-day--out-of-period' : '';

                        return (
                          <button
                            key={day}
                            type="button"
                            className={`${baseCls}${inactiveCls}${preHolidayCls}${problemCls}${outCls} ts-mobile-day-btn`}
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
              </Fragment>
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
          {tableLegend}
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
                <th className="ts-col-sum-sticky" title="Сумма показываемых часов по сотруднику на объекте">
                  Часы
                </th>
              </tr>
            </thead>
            <tbody>
              {objectViewGroups.map(group => (
                <Fragment key={group.object_key}>
                  <tr className="ts-object-group-row">
                    <td className="ts-col-sticky ts-object-group-cell" colSpan={days.length + 2}>
                      <span className="ts-object-group-name">{group.object_name}</span>
                      <span className="ts-object-group-meta">
                        {group.rows.length} чел.{group.totalHours > 0 ? ` (${Math.round(group.totalHours)} ч.)` : ''}
                      </span>
                    </td>
                  </tr>
                  {group.rows.map(row => {
                    const objRowSum = days.reduce((acc, day) => (
                      isDayInactiveForEmployee(row.employee, year, month, day)
                        ? acc
                        : acc + getObjectCellHours(row.dailyEntries.get(day) || null, row.days.get(day) || null)
                    ), 0);
                    return (
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
                        const dailyEntry = row.dailyEntries.get(day) || null;
                        const sched = getScheduleForTimesheetDay(schedules, dailySchedules, row.employee.id, year, month, day);
                        const dayOff = isScheduleDayOff(sched, calendar, year, month, day);
                        const future = isFutureDay(year, month, day);
                        const today = isToday(year, month, day);
                        const threshold = getFullDayThresholdHoursForDay(sched, calendar, year, month, day);
                        const text = getObjectCellText(dailyEntry, objectEntry, dayOff);
                        const targeted = bulkEditMode && activeSelectedCellKeys.has(getObjectBulkCellKey(row.employee.id, row.object_key, day));
                        const baseTitle = getObjectCellTitleWithStatus(dailyEntry, objectEntry, row.object_name, dayOff, threshold, future);
                        const title = bulkEditMode
                          ? [baseTitle, 'Зажмите левую кнопку мыши и протяните диапазон для массовой корректировки по объектам']
                            .filter(Boolean)
                            .join(' • ')
                          : baseTitle;
                        // Дни вне периода работы сотрудника в отделе (до прихода / после перевода/исключения).
                        const inactive = isDayInactiveForEmployee(row.employee, year, month, day);
                        // Bulk-выделение разрешено и в выходные — как в виде «по сотрудникам», но не для inactive-дней.
                        const isBulkClickable = !inactive;
                        const isBlocked = row.isSynthetic || inactive;
                        const isoDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                        const baseCls = getDayCellClass(dailyEntry, dayOff, today, future, threshold, approvalStatusByDate?.get(isoDate), false);
                        const inactiveCls = inactive ? ' ts-day--inactive' : '';
                        const objectApprovalCls = objectEntry?.approval_status === 'pending' ? ' ts-day--approval-pending'
                          : objectEntry?.approval_status === 'approved' ? ' ts-day--approval-approved'
                          : objectEntry?.approval_status === 'rejected' ? ' ts-day--approval-rejected' : '';
                        return (
                          <td
                            key={`${group.object_key}_${row.employee.id}_${day}`}
                            className={`${baseCls}${inactiveCls}${objectEntry?.is_correction ? ' ts-day--corrected' : ''}${objectApprovalCls}${targeted ? ' ts-day--bulk-target' : ''}${bulkEditMode && !isBlocked ? ' ts-day--bulk-selectable' : ''}`}
                            title={title}
                            onMouseDown={bulkEditMode && isBulkClickable ? (event) => handleBulkCellMouseDown(
                              event,
                              getObjectBulkRowKey(row.employee.id, row.object_key),
                              day,
                              isBlocked,
                            ) : undefined}
                            onMouseEnter={bulkEditMode && isBulkClickable ? () => handleBulkCellMouseEnter(
                              getObjectBulkRowKey(row.employee.id, row.object_key),
                              day,
                            ) : undefined}
                            onClick={!bulkEditMode && !inactive ? () => {
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
                            {inactive ? '' : text}
                          </td>
                        );
                      })}
                      <td className="ts-col-sum-sticky">
                        {objRowSum > 0 ? formatHoursLabel(objRowSum) : '—'}
                      </td>
                    </tr>
                    );
                  })}
                </Fragment>
              ))}
              {objectViewGroups.length === 0 && (
                <tr>
                  <td colSpan={days.length + 2} className="ts-loading">
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

  const desktopColSpan = days.length + 1 + (showSumColumn ? 1 : 0) + (showDeviationColumn ? 1 : 0);
  const virtualItems = rowVirtualizer.getVirtualItems();

  return (
    <div className="ts-table-container">
      <div className="ts-table-header-bar">
        <h3 className="ts-table-title">Табель учёта рабочего времени</h3>
        {tableLegend}
      </div>

      <div className="ts-table-scroll" ref={tableScrollRef}>
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
              {showSumColumn && (
                <th className="ts-col-sum-sticky" title="Сумма показываемых часов за месяц">
                  Часы
                </th>
              )}
              {showDeviationColumn && (
                <th className="ts-col-deviation-sticky" title="План минус факт. Положительное — недоработка, отрицательное — переработка.">
                  Откл.
                </th>
              )}
            </tr>
          </thead>
          {employeeRows.length === 0 ? (
            <tbody>
              <tr>
                <td colSpan={desktopColSpan} className="ts-loading">
                  Нет сотрудников для отображения
                </td>
              </tr>
            </tbody>
          ) : (
            <>
              {virtualItems[0] && virtualItems[0].start > 0 && (
                <tbody aria-hidden="true">
                  <tr><td colSpan={desktopColSpan} style={{ height: virtualItems[0].start, padding: 0, border: 'none' }} /></tr>
                </tbody>
              )}
              {virtualItems.map(virtualRow => {
              const index = virtualRow.index;
              const row = employeeRows[index];
              const employeeIndex = index + 1;
              const displayName = formatTimesheetEmployeeName(row.employee.full_name);
              const expanded = activeExpandedEmployeeIds.has(row.employee.id);
              const currentSource = row.employee.source ?? 'department';
              const prevSource = index > 0
                ? (employeeRows[index - 1].employee.source ?? 'department')
                : null;
              const sectionLabel = currentSource !== prevSource ? getSectionLabel(currentSource, departmentName) : null;
              // Сумма показываемых часов по строке — повтор логики ячейки, см. getDayCellHours.
              const rowSum = showSumColumn
                ? days.reduce((acc, day) => (
                  isDayInactiveForEmployee(row.employee, year, month, day)
                    ? acc
                    : acc + getDayCellHours(row.days.get(day) || null)
                ), 0)
                : 0;

              return (
                <tbody key={row.employee.id} data-index={index} ref={rowVirtualizer.measureElement}>
                  {sectionLabel && (
                    <tr className="ts-section-divider-row">
                      <td
                        className="ts-col-sticky ts-section-divider-cell"
                        colSpan={days.length + 1 + (showSumColumn ? 1 : 0) + (showDeviationColumn ? 1 : 0)}
                      >
                        {sectionLabel}
                      </td>
                    </tr>
                  )}
                  <tr>
                    <td
                      className={`ts-col-sticky ts-employee-cell${bulkEditMode ? ' ts-employee-cell--bulk' : ''}`}
                      onClick={bulkEditMode ? undefined : () => onEmployeeClick(row.employee)}
                    >
                      <div className="ts-employee-cell-content">
                        {row.hasExpandableObjects ? (
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
                        ) : (
                          <span className="ts-expand-placeholder" aria-hidden="true" />
                        )}
                        <span className="ts-employee-index">{employeeIndex}.</span>
                        <div className="ts-employee-name" title={row.employee.full_name}>
                          {displayName}
                        </div>
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
                            className={`ts-employee-inline-btn${compactInlineExclude ? ' ts-employee-inline-btn--icon' : ''}`}
                            title="Исключить сотрудника"
                            aria-label="Исключить сотрудника"
                            onClick={(event) => {
                              event.stopPropagation();
                              onExcludeEmployee(row.employee);
                            }}
                            disabled={pendingEmployeeId === row.employee.id}
                          >
                            <UserMinus size={12} />
                            {!compactInlineExclude && (pendingEmployeeId === row.employee.id ? '...' : 'Искл.')}
                          </button>
                        )}
                      </div>
                    </td>
                    {days.map(day => {
                      const sched = getScheduleForTimesheetDay(schedules, dailySchedules, row.employee.id, year, month, day);
                      const dayOff = isScheduleDayOff(sched, calendar, year, month, day);
                      const preHoliday = isPreHolidayForSchedule(sched, calendar, year, month, day);
                      const today = isToday(year, month, day);
                      const future = isFutureDay(year, month, day);
                      const entry = row.days.get(day) || null;
                      const thresholdHours = getFullDayThresholdHoursForDay(sched, calendar, year, month, day);
                      const targeted = bulkEditMode && activeSelectedCellKeys.has(getEmployeeBulkCellKey(row.employee.id, day));
                      const inactive = isDayInactiveForEmployee(row.employee, year, month, day);
                      const inactiveCls = inactive ? ' ts-day--inactive' : '';
                      const preHolidayCls = preHoliday ? ' ts-day--pre-holiday' : '';
                      const isoDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                      const cellKey = `${row.employee.id}_${isoDate}`;
                      const problemCls = (problemDates?.red?.has(cellKey) || problemDates?.red?.has(isoDate))
                        ? ' ts-day--problem-red'
                        : (problemDates?.yellow?.has(cellKey) || problemDates?.yellow?.has(isoDate))
                          ? ' ts-day--problem-yellow'
                          : '';
                      const outCls = outOfPeriodDates?.has(isoDate) ? ' ts-day--out-of-period' : '';
                      const flashCls = highlightedCell
                        && highlightedCell.employeeId === row.employee.id
                        && highlightedCell.date === isoDate
                        ? ' ts-day--flash'
                        : '';
                      const cls = `${getDayCellClass(entry, dayOff, today, future, thresholdHours, approvalStatusByDate?.get(isoDate))}${inactiveCls}${preHolidayCls}${problemCls}${outCls}${flashCls}${targeted ? ' ts-day--bulk-target' : ''}${bulkEditMode && !inactive ? ' ts-day--bulk-selectable' : ''}`;
                      const text = inactive ? '' : getDayCellText(entry, dayOff);
                      const baseTitle = getDayCellTitle(entry, dayOff);
                      const title = preHoliday
                        ? [baseTitle, 'Предпраздничный день (−1ч)'].filter(Boolean).join(' • ')
                        : baseTitle;
                      const bulkTitle = bulkEditMode && !inactive
                        ? [title, 'Зажмите левую кнопку мыши и протяните диапазон для массовой корректировки']
                          .filter(Boolean)
                          .join(' • ')
                        : title;

                      return (
                        <td
                          key={day}
                          className={cls}
                          data-employee={row.employee.id}
                          data-date={isoDate}
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
                    {showSumColumn && (
                      <td className="ts-col-sum-sticky" title="Сумма показываемых часов за месяц">
                        {rowSum > 0 ? formatHoursLabel(rowSum) : '—'}
                      </td>
                    )}
                    {showDeviationColumn && (() => {
                      const stat = employeeStatsMap.get(row.employee.id);
                      if (!stat) {
                        return <td className="ts-col-deviation-sticky ts-day--deviation-zero">—</td>;
                      }
                      const normR = Math.round(stat.norm_hours);
                      const factR = Math.round(stat.fact_hours);
                      const devR = normR - factR;
                      const cls = getDeviationCellClass(devR);
                      const tip = `План ${formatHoursLabel(normR)}, факт ${formatHoursLabel(factR)}`;
                      return (
                        <td className={`ts-col-deviation-sticky ${cls}`} title={tip}>
                          {formatDeviationHours(devR)}
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
                        const dailyEntry = row.days.get(day) || null;
                        const sched = getScheduleForTimesheetDay(schedules, dailySchedules, row.employee.id, year, month, day);
                        const dayOff = isScheduleDayOff(sched, calendar, year, month, day);
                        const future = isFutureDay(year, month, day);
                        const today = isToday(year, month, day);
                        const threshold = getFullDayThresholdHoursForDay(sched, calendar, year, month, day);
                        const text = getObjectCellText(dailyEntry, objectEntry, dayOff);
                        const targeted = bulkEditMode && activeSelectedCellKeys.has(getObjectBulkCellKey(row.employee.id, objectRow.object_key, day));
                        const baseTitle = getObjectCellTitleWithStatus(dailyEntry, objectEntry, objectRow.object_name, dayOff, threshold, future);
                        const title = bulkEditMode
                          ? [baseTitle, 'Зажмите левую кнопку мыши и протяните диапазон для массовой корректировки по объектам']
                            .filter(Boolean)
                            .join(' • ')
                          : baseTitle;
                        // Bulk-выделение разрешено и в выходные — как в виде «по сотрудникам».
                        const isBulkClickable = true;
                        const isoDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                        const baseCls = getDayCellClass(dailyEntry, dayOff, today, future, threshold, approvalStatusByDate?.get(isoDate), false);
                        const objectApprovalCls = objectEntry?.approval_status === 'pending' ? ' ts-day--approval-pending'
                          : objectEntry?.approval_status === 'approved' ? ' ts-day--approval-approved'
                          : objectEntry?.approval_status === 'rejected' ? ' ts-day--approval-rejected' : '';
                        return (
                          <td
                            key={`${objectRow.object_key}_${day}`}
                            className={`${baseCls}${objectEntry?.is_correction ? ' ts-day--corrected' : ''}${objectApprovalCls}${targeted ? ' ts-day--bulk-target' : ''}${bulkEditMode ? ' ts-day--bulk-selectable' : ''}`}
                            title={title}
                            onMouseDown={bulkEditMode && isBulkClickable ? (event) => handleBulkCellMouseDown(
                              event,
                              getObjectBulkRowKey(row.employee.id, objectRow.object_key),
                              day,
                              false,
                            ) : undefined}
                            onMouseEnter={bulkEditMode && isBulkClickable ? () => handleBulkCellMouseEnter(
                              getObjectBulkRowKey(row.employee.id, objectRow.object_key),
                              day,
                            ) : undefined}
                            onClick={!bulkEditMode ? () => onObjectDayClick(row.employee, day, {
                              object_key: objectRow.object_key,
                              object_id: objectRow.object_id,
                              object_name: objectRow.object_name,
                            }, objectEntry) : undefined}
                          >
                            {text}
                          </td>
                        );
                      })}
                      {showSumColumn && <td className="ts-col-sum-sticky" />}
                      {showDeviationColumn && <td className="ts-col-deviation-sticky" />}
                    </tr>
                  ))}
                </tbody>
              );
              })}
              {(() => {
                const last = virtualItems[virtualItems.length - 1];
                const remaining = last ? rowVirtualizer.getTotalSize() - last.end : 0;
                return remaining > 0 ? (
                  <tbody aria-hidden="true">
                    <tr><td colSpan={desktopColSpan} style={{ height: remaining, padding: 0, border: 'none' }} /></tr>
                  </tbody>
                ) : null;
              })()}
            </>
          )}
        </table>
      </div>
    </div>
  );
};
