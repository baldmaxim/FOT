import { type FC, Suspense, lazy, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, ChevronDown, Download } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { TimesheetStats } from '../../components/timesheet/TimesheetStats';
import { TimesheetGrid } from '../../components/timesheet/TimesheetGrid';
import { timesheetService } from '../../services/timesheetService';
import { useTimesheetApprovalStatuses } from '../../hooks/useTimesheetApprovalData';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { useStructureTree } from '../../hooks/useStructure';
import { getMonthLabel, formatDateRu, getDaysInMonth } from '../../utils/calendarUtils';
import type {
  TimesheetEntry,
  TimesheetEmployee,
  TimesheetStats as ITimesheetStats,
  TimesheetStatus,
} from '../../types';
import type { IResolvedSchedule } from '../../types/schedule';
import { TimesheetApprovalBar } from '../../components/timesheet/TimesheetApprovalBar';
import { getScheduleForTimesheetDay, getWorkHoursForDay } from '../../utils/scheduleUtils';
import { getSortedDepartmentOptions } from '../../utils/departmentUtils';
import { useIsMobile } from '../../hooks/useIsMobile';
import { formatTimesheetHalfLabel, type TimesheetApprovalHalf } from '../../utils/timesheetApprovalPeriod';
import './TimesheetPage.css';

const TimesheetSidePanel = lazy(() => import('../../components/timesheet/TimesheetSidePanel').then(module => ({
  default: module.TimesheetSidePanel,
})));
const TimesheetCorrectionModal = lazy(() => import('../../components/timesheet/TimesheetCorrectionModal').then(module => ({
  default: module.TimesheetCorrectionModal,
})));

interface IDeptOption {
  id: string;
  name: string;
}

const DEFAULT_STATS: ITimesheetStats = {
  employeeCount: 0,
  workingDays: 0,
  normHours: 0,
  actualHours: 0,
  deviations: { late: 0, absent: 0, sick: 0 },
};
const EMPTY_SCHEDULES: Record<number, IResolvedSchedule> = {};
const EMPTY_DAILY_SCHEDULES: Record<number, Record<string, IResolvedSchedule>> = {};

interface IBulkCorrectionTarget {
  employee: TimesheetEmployee;
  day: number;
  workDate: string;
  entry: TimesheetEntry | null;
}

type TimesheetDisplaySegment = TimesheetApprovalHalf | 'FULL';
const getBulkCellKey = (employeeId: number, day: number): string => `${employeeId}:${day}`;

const parseMonthParam = (value: string | null): { year: number; month: number } | null => {
  if (!/^\d{4}-\d{2}$/.test(value || '')) return null;

  const year = Number.parseInt((value as string).slice(0, 4), 10);
  const month = Number.parseInt((value as string).slice(5, 7), 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null;

  return { year, month };
};

const toMonthIndex = (year: number, month: number): number => year * 12 + month - 1;

const fromMonthIndex = (index: number): { year: number; month: number } => ({
  year: Math.floor(index / 12),
  month: (index % 12) + 1,
});

export const TimesheetPage: FC = () => {
  const { hasPermission, profile } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const isDepartmentScope = hasPermission('data.scope.department') && !hasPermission('data.scope.all');
  const queryMonth = searchParams.get('month');
  const queryHalf = searchParams.get('half');
  const now = useMemo(() => new Date(), []);
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const currentDay = now.getDate();
  const currentMonthIndex = toMonthIndex(currentYear, currentMonth);
  const previousMonthIndex = currentMonthIndex - 1;
  const isRestrictedManagerView = isDepartmentScope;
  const requestedMonth = useMemo(() => parseMonthParam(queryMonth), [queryMonth]);
  const requestedMonthIndex = requestedMonth
    ? toMonthIndex(requestedMonth.year, requestedMonth.month)
    : currentMonthIndex;
  const resolvedMonthIndex = isRestrictedManagerView
    ? Math.min(currentMonthIndex, Math.max(previousMonthIndex, requestedMonthIndex))
    : requestedMonthIndex;
  const { year, month } = useMemo(() => fromMonthIndex(resolvedMonthIndex), [resolvedMonthIndex]);

  const isMobile = useIsMobile(768);
  const [mobileApprovalOpen, setMobileApprovalOpen] = useState(false);
  const mobileApprovalVisible = isMobile && mobileApprovalOpen;

  // Schedule settings panel

  // Department selector
  const [selectedDeptId, setSelectedDeptId] = useState<string | null>(null);
  const [deptOpen, setDeptOpen] = useState(false);
  const [deptSearch, setDeptSearch] = useState('');
  const deptRef = useRef<HTMLDivElement>(null);

  // Side panel
  const [panelEmployee, setPanelEmployee] = useState<TimesheetEmployee | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  // Modal
  const [modalOpen, setModalOpen] = useState(false);
  const [modalEmployee, setModalEmployee] = useState<TimesheetEmployee | null>(null);
  const [modalDay, setModalDay] = useState<number>(1);
  const [modalEntry, setModalEntry] = useState<TimesheetEntry | null>(null);
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [bulkSelectedEmployeeIds, setBulkSelectedEmployeeIds] = useState<Set<number>>(new Set());
  const [bulkSelectedDays, setBulkSelectedDays] = useState<Set<number>>(new Set());
  const [bulkSelectedCellKeys, setBulkSelectedCellKeys] = useState<Set<string>>(new Set());

  const structureQuery = useStructureTree();
  const deptOptions = useMemo(
    () => getSortedDepartmentOptions(structureQuery.data?.departments ?? []) as IDeptOption[],
    [structureQuery.data],
  );
  const effectiveSelectedDeptId = isDepartmentScope
    ? (selectedDeptId || profile?.department_id || null)
    : selectedDeptId;

  // Close dept dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (deptRef.current && !deptRef.current.contains(e.target as Node)) {
        setDeptOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const monthStr = useMemo(() => `${year}-${String(month).padStart(2, '0')}`, [year, month]);
  const timesheetQuery = useQuery({
    queryKey: ['timesheet-page', monthStr, effectiveSelectedDeptId ?? 'none'],
    queryFn: () => timesheetService.getAll({
      month: monthStr,
      department_id: effectiveSelectedDeptId || undefined,
    }),
    enabled: Boolean(effectiveSelectedDeptId),
    staleTime: 30_000,
    placeholderData: previousData => previousData,
  });
  const employees = useMemo<TimesheetEmployee[]>(
    () => timesheetQuery.data?.employees || [],
    [timesheetQuery.data],
  );
  const entries = useMemo<TimesheetEntry[]>(
    () => timesheetQuery.data?.entries || [],
    [timesheetQuery.data],
  );
  const stats = timesheetQuery.data?.stats || DEFAULT_STATS;
  const schedules = timesheetQuery.data?.schedules || EMPTY_SCHEDULES;
  const dailySchedules = timesheetQuery.data?.daily_schedules || EMPTY_DAILY_SCHEDULES;
  const calendar = timesheetQuery.data?.calendar || null;
  const loading = Boolean(effectiveSelectedDeptId) && timesheetQuery.isLoading;
  const { data: approvalsByHalf } = useTimesheetApprovalStatuses(effectiveSelectedDeptId, monthStr);
  const daysInMonth = useMemo(() => getDaysInMonth(year, month), [year, month]);
  const monthEnded = resolvedMonthIndex < currentMonthIndex;
  const canShowFullMonth = monthEnded
    && approvalsByHalf.H1?.status === 'approved'
    && approvalsByHalf.H2?.status === 'approved';
  const activeSegment = useMemo<TimesheetDisplaySegment>(() => {
    if (queryHalf === 'FULL' && canShowFullMonth) return 'FULL';
    if (queryHalf === 'H1' || queryHalf === 'H2') return queryHalf;
    if (canShowFullMonth) return 'FULL';
    if (resolvedMonthIndex === currentMonthIndex && currentDay > 15) return 'H2';
    return 'H1';
  }, [queryHalf, canShowFullMonth, resolvedMonthIndex, currentMonthIndex, currentDay]);
  const visibleDays = useMemo(() => {
    if (activeSegment === 'FULL') {
      return Array.from({ length: daysInMonth }, (_, index) => index + 1);
    }
    if (activeSegment === 'H1') {
      return Array.from({ length: Math.min(15, daysInMonth) }, (_, index) => index + 1);
    }
    return Array.from({ length: Math.max(0, daysInMonth - 15) }, (_, index) => index + 16);
  }, [activeSegment, daysInMonth]);
  const entryMap = useMemo(() => {
    const map = new Map<string, TimesheetEntry>();
    for (const entry of entries) {
      map.set(`${entry.employee_id}_${entry.work_date}`, entry);
    }
    return map;
  }, [entries]);
  const employeeOrder = useMemo(() => (
    new Map(employees.map((employee, index) => [employee.id, index]))
  ), [employees]);
  const employeeMap = useMemo(() => (
    new Map(employees.map(employee => [employee.id, employee]))
  ), [employees]);
  const visibleDaySet = useMemo(() => new Set(visibleDays), [visibleDays]);
  const bulkModeEnabled = bulkMode && !isMobile;
  const clearBulkState = useCallback(() => {
    setBulkMode(false);
    setBulkModalOpen(false);
    setBulkSelectedEmployeeIds(new Set());
    setBulkSelectedDays(new Set());
    setBulkSelectedCellKeys(new Set());
  }, []);

  useEffect(() => {
    if (!isRestrictedManagerView) return;
    if (queryMonth === monthStr) return;

    setSearchParams(current => {
      const next = new URLSearchParams(current);
      next.set('month', monthStr);
      return next;
    }, { replace: true });
  }, [isRestrictedManagerView, monthStr, queryMonth, setSearchParams]);

  // Month navigation
  const updateMonthParam = useCallback((nextYear: number, nextMonth: number) => {
    clearBulkState();
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      next.set('month', `${nextYear}-${String(nextMonth).padStart(2, '0')}`);
      next.delete('half');
      return next;
    });
  }, [clearBulkState, setSearchParams]);

  const prevMonth = () => {
    if (month === 1) {
      updateMonthParam(year - 1, 12);
      return;
    }
    updateMonthParam(year, month - 1);
  };

  const nextMonth = () => {
    if (month === 12) {
      updateMonthParam(year + 1, 1);
      return;
    }
    updateMonthParam(year, month + 1);
  };
  const canGoPrevMonth = !isRestrictedManagerView || resolvedMonthIndex > previousMonthIndex;
  const canGoNextMonth = !isRestrictedManagerView || resolvedMonthIndex < currentMonthIndex;

  // Employee click -> side panel
  const handleEmployeeClick = (emp: TimesheetEmployee) => {
    if (bulkModeEnabled) return;
    setPanelEmployee(emp);
    setPanelOpen(true);
  };

  // Day click -> modal
  const handleDayClick = (emp: TimesheetEmployee, day: number, entry: TimesheetEntry | null) => {
    if (bulkModeEnabled) return;
    setModalEmployee(emp);
    setModalDay(day);
    setModalEntry(entry);
    setModalOpen(true);
  };

  // Save correction
  const handleSaveCorrection = useCallback(async (status: TimesheetStatus, hours: number | null, notes: string) => {
    if (!modalEmployee) return;
    try {
      const workDate = `${year}-${String(month).padStart(2, '0')}-${String(modalDay).padStart(2, '0')}`;
      if (modalEntry?.id) {
        await timesheetService.update(modalEntry.id, { status, hours_worked: hours, notes });
      } else {
        await timesheetService.create({
          employee_id: modalEmployee.id,
          work_date: workDate,
          status,
          hours_worked: hours,
          notes,
        });
      }
      setModalOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['timesheet-page', monthStr, effectiveSelectedDeptId ?? 'none'] });
    } catch (err) {
      console.error('Save correction error:', err);
    }
  }, [modalEmployee, year, month, modalDay, modalEntry, queryClient, monthStr, effectiveSelectedDeptId]);

  // Export
  const handleExport = async () => {
    try {
      const monthStr = `${year}-${String(month).padStart(2, '0')}`;
      const blob = await timesheetService.export({
        month: monthStr,
        department_id: effectiveSelectedDeptId || undefined,
      });
      const monthNames = ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
        'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
      const filename = `${selectedDeptName}_${monthNames[month]}_${year}.xlsx`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export error:', err);
    }
  };

  // Panel entries for selected employee
  const panelEntries = useMemo(() => {
    if (!panelEmployee) return [];
    return entries.filter(e => e.employee_id === panelEmployee.id);
  }, [panelEmployee, entries]);

  // Filtered dept options
  const filteredDepts = useMemo(() => {
    if (!deptSearch) return deptOptions;
    const q = deptSearch.toLowerCase();
    return deptOptions.filter(d => d.name.toLowerCase().includes(q));
  }, [deptOptions, deptSearch]);

  const selectedDeptName = effectiveSelectedDeptId
    ? deptOptions.find(d => d.id === effectiveSelectedDeptId)?.name || 'Отдел'
    : 'Все отделы';

  const modalDefaultHours = useMemo(() => {
    if (modalEntry?.hours_worked != null) return modalEntry.hours_worked;
    if (!modalEmployee) return 8;
    const sched = getScheduleForTimesheetDay(schedules, dailySchedules, modalEmployee.id, year, month, modalDay);
    return getWorkHoursForDay(sched, year, month, modalDay);
  }, [modalEntry, modalEmployee, schedules, dailySchedules, year, month, modalDay]);

  const handleBulkModeToggle = useCallback(() => {
    if (bulkModeEnabled) {
      clearBulkState();
      return;
    }

    setPanelOpen(false);
    setModalOpen(false);
    setBulkMode(true);
  }, [bulkModeEnabled, clearBulkState]);

  const toggleBulkEmployeeSelection = useCallback((employeeId: number) => {
    setBulkSelectedEmployeeIds(prev => {
      const next = new Set(prev);
      if (next.has(employeeId)) next.delete(employeeId);
      else next.add(employeeId);
      return next;
    });
  }, []);

  const toggleBulkDaySelection = useCallback((day: number) => {
    setBulkSelectedDays(prev => {
      const next = new Set(prev);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });
  }, []);

  const toggleAllBulkEmployees = useCallback(() => {
    setBulkSelectedEmployeeIds(prev => (
      prev.size === employees.length
        ? new Set()
        : new Set(employees.map(employee => employee.id))
    ));
  }, [employees]);

  const toggleAllBulkDays = useCallback(() => {
    setBulkSelectedDays(prev => (
      prev.size === visibleDays.length
        ? new Set()
        : new Set(visibleDays)
    ));
  }, [visibleDays]);
  const toggleBulkCellSelection = useCallback((employeeId: number, day: number) => {
    setBulkSelectedCellKeys(prev => {
      const next = new Set(prev);
      const key = getBulkCellKey(employeeId, day);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const bulkTargets = useMemo<IBulkCorrectionTarget[]>(() => {
    if (!bulkModeEnabled) return [];

    const targets = new Map<string, IBulkCorrectionTarget>();
    const addTarget = (employee: TimesheetEmployee, day: number) => {
      const workDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const key = `${employee.id}_${workDate}`;
      if (targets.has(key)) return;
      targets.set(key, {
        employee,
        day,
        workDate,
        entry: entryMap.get(key) || null,
      });
    };

    if (bulkSelectedEmployeeIds.size > 0 && bulkSelectedDays.size > 0) {
      const sortedDays = [...bulkSelectedDays].sort((left, right) => left - right);
      employees
        .filter(employee => bulkSelectedEmployeeIds.has(employee.id))
        .forEach(employee => {
          sortedDays.forEach(day => addTarget(employee, day));
        });
    }

    if (bulkSelectedCellKeys.size > 0) {
      bulkSelectedCellKeys.forEach(cellKey => {
        const [employeeIdPart, dayPart] = cellKey.split(':');
        const employeeId = Number.parseInt(employeeIdPart, 10);
        const day = Number.parseInt(dayPart, 10);
        if (!Number.isFinite(employeeId) || !Number.isFinite(day) || !visibleDaySet.has(day)) return;
        const employee = employeeMap.get(employeeId);
        if (!employee) return;
        addTarget(employee, day);
      });
    }

    return [...targets.values()].sort((left, right) => {
      const employeeDiff = (employeeOrder.get(left.employee.id) ?? 0) - (employeeOrder.get(right.employee.id) ?? 0);
      return employeeDiff !== 0 ? employeeDiff : left.day - right.day;
    });
  }, [
    bulkModeEnabled,
    bulkSelectedEmployeeIds,
    bulkSelectedDays,
    bulkSelectedCellKeys,
    employees,
    year,
    month,
    entryMap,
    employeeMap,
    employeeOrder,
    visibleDaySet,
  ]);

  const bulkInitialStatus = useMemo<TimesheetStatus>(() => {
    if (bulkTargets.length === 1 && bulkTargets[0].entry?.status) {
      return bulkTargets[0].entry.status;
    }
    return 'work';
  }, [bulkTargets]);

  const bulkDefaultHours = useMemo(() => {
    if (bulkTargets.length === 0) return 8;
    const firstTarget = bulkTargets[0];
    if (firstTarget.entry?.hours_worked != null) return firstTarget.entry.hours_worked;
    const sched = getScheduleForTimesheetDay(
      schedules,
      dailySchedules,
      firstTarget.employee.id,
      year,
      month,
      firstTarget.day,
    );
    return getWorkHoursForDay(sched, year, month, firstTarget.day);
  }, [bulkTargets, schedules, dailySchedules, year, month]);

  const handleOpenBulkModal = useCallback(() => {
    if (bulkTargets.length === 0) {
      toast.info('Сначала выберите сотрудников и дни для корректировки');
      return;
    }
    setBulkModalOpen(true);
  }, [bulkTargets.length, toast]);

  const handleSaveBulkCorrection = useCallback(async (status: TimesheetStatus, hours: number | null, notes: string) => {
    if (bulkTargets.length === 0) return;
    try {
      const result = await timesheetService.bulkCorrect({
        items: bulkTargets.map(target => ({
          employee_id: target.employee.id,
          work_date: target.workDate,
        })),
        status,
        hours_worked: hours,
        notes,
      });

      clearBulkState();
      await queryClient.invalidateQueries({ queryKey: ['timesheet-page', monthStr, effectiveSelectedDeptId ?? 'none'] });
      toast.success(`Корректировка применена для ${result.processed} ячеек`);
    } catch (error) {
      console.error('Bulk save correction error:', error);
      toast.error(error instanceof Error ? error.message : 'Не удалось применить массовую корректировку');
    }
  }, [bulkTargets, clearBulkState, queryClient, monthStr, effectiveSelectedDeptId, toast]);

  const allEmployeesSelected = employees.length > 0 && bulkSelectedEmployeeIds.size === employees.length;
  const allDaysSelected = visibleDays.length > 0 && bulkSelectedDays.size === visibleDays.length;
  const bulkSelectionSummary = [
    `${bulkSelectedEmployeeIds.size} сотрудников`,
    `${bulkSelectedDays.size} дней`,
    bulkSelectedCellKeys.size > 0 ? `точечно ${bulkSelectedCellKeys.size}` : null,
    `${bulkTargets.length} ячеек`,
  ].filter(Boolean).join(' • ');

  const handleSegmentChange = useCallback((segment: TimesheetDisplaySegment) => {
    clearBulkState();
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      next.set('month', monthStr);
      next.set('half', segment);
      return next;
    });
  }, [clearBulkState, monthStr, setSearchParams]);

  const monthNavigation = (
    <div className="ts-month-nav">
      <button type="button" className="ts-month-btn" onClick={prevMonth} disabled={!canGoPrevMonth}>
        <ChevronLeft size={16} />
      </button>
      <span className="ts-month-label">{getMonthLabel(year, month)}</span>
      <button type="button" className="ts-month-btn" onClick={nextMonth} disabled={!canGoNextMonth}>
        <ChevronRight size={16} />
      </button>
    </div>
  );

  const departmentControl = (
    <div className="ts-dept-wrap" ref={deptRef}>
      {isDepartmentScope ? (
        <button type="button" className="ts-dept-btn" style={{ cursor: 'default', opacity: 0.8 }}>
          {selectedDeptName}
        </button>
      ) : (
        <>
          <button type="button" className="ts-dept-btn" onClick={() => setDeptOpen(!deptOpen)}>
            {selectedDeptName}
            <ChevronDown size={16} />
          </button>
          {deptOpen && (
            <div className="ts-dept-dropdown">
              <input
                className="ts-dept-search"
                placeholder="Поиск отдела..."
                value={deptSearch}
                onChange={e => setDeptSearch(e.target.value)}
                autoFocus
              />
              <div
                className={`ts-dept-item ${!selectedDeptId ? 'ts-dept-item--active' : ''}`}
                onClick={() => { clearBulkState(); setSelectedDeptId(null); setDeptOpen(false); }}
              >
                Все отделы
              </div>
              {filteredDepts.map(d => (
                <div
                  key={d.id}
                  className={`ts-dept-item ${selectedDeptId === d.id ? 'ts-dept-item--active' : ''}`}
                  onClick={() => { clearBulkState(); setSelectedDeptId(d.id); setDeptOpen(false); }}
                >
                  {d.name}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );

  const segmentControl = effectiveSelectedDeptId ? (
    <section className="ts-half-switch">
      {(['H1', 'H2'] as TimesheetApprovalHalf[]).map(half => (
        <button
          key={half}
          type="button"
          className={`ts-half-chip ${activeSegment === half ? ' ts-half-chip--active' : ''}`}
          onClick={() => handleSegmentChange(half)}
        >
          <span className="ts-half-chip-label">{formatTimesheetHalfLabel(half, year, month)}</span>
          <span className="ts-half-chip-subtitle">
            {half === 'H1' ? 'Первая половина' : 'Вторая половина'}
          </span>
        </button>
      ))}
      {canShowFullMonth && (
        <button
          type="button"
          className={`ts-half-chip ${activeSegment === 'FULL' ? ' ts-half-chip--active' : ''}`}
          onClick={() => handleSegmentChange('FULL')}
        >
          <span className="ts-half-chip-label">Весь месяц</span>
          <span className="ts-half-chip-subtitle">Полный табель</span>
        </button>
      )}
    </section>
  ) : null;

  return (
    <div className="ts-page">
      {isMobile ? (
        <section className="ts-top-panel ts-top-panel--mobile">
          <div className="ts-mobile-header-row">
            <h1 className="ts-title">Табель</h1>
            <div className="ts-mobile-header-actions">
              <button
                type="button"
                className={`ts-btn ts-btn--chip${mobileApprovalVisible ? ' ts-btn--active' : ''}`}
                onClick={() => setMobileApprovalOpen(open => !open)}
              >
                {mobileApprovalVisible ? 'Скрыть согласование' : 'Согласование'}
              </button>
              <button type="button" className="ts-btn ts-btn--icon" onClick={handleExport} aria-label="Экспорт табеля">
                <Download size={16} />
              </button>
            </div>
          </div>
          <div className="ts-mobile-header-row ts-mobile-header-row--controls">
            {monthNavigation}
            {departmentControl}
          </div>
          <TimesheetStats stats={stats} compact />
          {mobileApprovalVisible && (
            <div className="ts-mobile-approval-panel">
              <TimesheetApprovalBar
                departmentId={effectiveSelectedDeptId}
                month={`${year}-${String(month).padStart(2, '0')}`}
                compact
              />
            </div>
          )}
        </section>
      ) : (
        <section className="ts-top-panel">
          <div className="ts-header">
            <div className="ts-header-left">
              <h1 className="ts-title">Табель</h1>
              {monthNavigation}
              {departmentControl}
            </div>

            <TimesheetStats stats={stats} />

            <div className="ts-header-right">
              {!isMobile && effectiveSelectedDeptId && (
                <button
                  type="button"
                  className={`ts-btn ts-btn--chip ts-btn--bulk-toggle${bulkModeEnabled ? ' ts-btn--active' : ''}`}
                  onClick={handleBulkModeToggle}
                >
                  Режим корректировок
                </button>
              )}
              <TimesheetApprovalBar
                departmentId={effectiveSelectedDeptId}
                month={`${year}-${String(month).padStart(2, '0')}`}
              />
              <button type="button" className="ts-btn" onClick={handleExport}>
                <Download size={16} />
                Экспорт
              </button>
            </div>
          </div>
        </section>
      )}

      {segmentControl}

      {!isMobile && bulkModeEnabled && effectiveSelectedDeptId && (
        <section className="ts-bulk-bar">
          <div className="ts-bulk-info">
            <div className="ts-bulk-title">Массовая корректировка</div>
            <div className="ts-bulk-hint">
              Отмечайте сотрудников слева, дни сверху или нажимайте прямо на нужные ячейки. {bulkSelectionSummary}
            </div>
          </div>
          <div className="ts-bulk-actions">
            <button type="button" className="ts-btn" onClick={toggleAllBulkEmployees}>
              {allEmployeesSelected ? 'Снять сотрудников' : 'Все сотрудники'}
            </button>
            <button type="button" className="ts-btn" onClick={toggleAllBulkDays}>
              {allDaysSelected ? 'Снять дни' : 'Все дни'}
            </button>
            <button
              type="button"
              className="ts-btn"
              onClick={() => {
                setBulkSelectedEmployeeIds(new Set());
                setBulkSelectedDays(new Set());
                setBulkSelectedCellKeys(new Set());
              }}
              disabled={
                bulkSelectedEmployeeIds.size === 0
                && bulkSelectedDays.size === 0
                && bulkSelectedCellKeys.size === 0
              }
            >
              Сбросить
            </button>
            <button
              type="button"
              className="ts-btn ts-btn--primary"
              onClick={handleOpenBulkModal}
              disabled={bulkTargets.length === 0}
            >
              Внести корректировку
            </button>
          </div>
        </section>
      )}

      {/* Grid */}
      {loading ? (
        <div className="ts-table-container">
          <div className="ts-loading">Загрузка табеля...</div>
        </div>
      ) : !effectiveSelectedDeptId ? (
        <div className="ts-table-container">
          <div className="ts-loading">Выберите отдел для отображения табеля</div>
        </div>
      ) : (
        <TimesheetGrid
          employees={employees}
          entries={entries}
          year={year}
          month={month}
          schedules={schedules}
          dailySchedules={dailySchedules}
          calendar={calendar}
          compact={isMobile}
          bulkEditMode={bulkModeEnabled}
          visibleDays={visibleDays}
          selectedEmployeeIds={bulkSelectedEmployeeIds}
          selectedDays={bulkSelectedDays}
          selectedCellKeys={bulkSelectedCellKeys}
          allEmployeesSelected={allEmployeesSelected}
          onToggleEmployeeSelection={toggleBulkEmployeeSelection}
          onToggleDaySelection={toggleBulkDaySelection}
          onToggleAllEmployees={toggleAllBulkEmployees}
          onToggleCellSelection={toggleBulkCellSelection}
          onEmployeeClick={handleEmployeeClick}
          onDayClick={handleDayClick}
        />
      )}

      {/* Side Panel */}
      {panelOpen && (
        <Suspense fallback={null}>
          <TimesheetSidePanel
            open={panelOpen}
            onClose={() => setPanelOpen(false)}
            employee={panelEmployee}
            entries={panelEntries}
            year={year}
            month={month}
            schedules={schedules}
            dailySchedules={dailySchedules}
            calendar={calendar}
            visibleDays={visibleDays}
          />
        </Suspense>
      )}

      {/* Correction Modal */}
      {modalOpen && (
        <Suspense fallback={null}>
          <TimesheetCorrectionModal
            open={modalOpen}
            onClose={() => setModalOpen(false)}
            onSave={handleSaveCorrection}
            initialStatus={modalEntry?.status || 'work'}
            initialHours={modalDefaultHours}
            dayLabel={`${formatDateRu(modalDay, month)}`}
            employeeName={modalEmployee?.full_name}
            employeeId={modalEmployee?.id}
            workDate={`${year}-${String(month).padStart(2, '0')}-${String(modalDay).padStart(2, '0')}`}
            hideSkudTab
            timesheetEntry={modalEntry}
            correctionInfo={modalEntry?.is_correction ? {
              is_correction: true,
              corrected_at: modalEntry.corrected_at,
              corrected_by_name: modalEntry.corrected_by_name,
            } : null}
          />
        </Suspense>
      )}

      {bulkModeEnabled && bulkModalOpen && (
        <Suspense fallback={null}>
          <TimesheetCorrectionModal
            open={bulkModalOpen}
            onClose={() => setBulkModalOpen(false)}
            onSave={handleSaveBulkCorrection}
            initialStatus={bulkInitialStatus}
            initialHours={bulkDefaultHours}
            title="Массовая корректировка"
            subtitle={bulkSelectionSummary}
            confirmLabel="Применить"
            hideSkudTab
          />
        </Suspense>
      )}
    </div>
  );
};
