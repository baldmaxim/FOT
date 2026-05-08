import { type FC, Suspense, lazy, useState, useEffect, useCallback, useMemo, useRef, useDeferredValue } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, ChevronLeft, ChevronRight, ChevronDown, Download, RefreshCw, UserPlus, Mail } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { TimesheetStats } from '../../components/timesheet/TimesheetStats';
import { TimesheetGrid } from '../../components/timesheet/TimesheetGrid';
import { TimesheetCorrectionsList } from '../../components/timesheet/TimesheetCorrectionsList';
import { TimesheetTeamManagementModal } from '../../components/timesheet/TimesheetTeamManagementModal';
import { TimesheetTransfersTab } from '../../components/timesheet/TimesheetTransfersTab';
import { TimesheetExcludeEmployeeModal } from '../../components/timesheet/TimesheetExcludeEmployeeModal';
import { timesheetService } from '../../services/timesheetService';
import { ApiError } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { useAssignedEmployees } from '../../hooks/useAssignedEmployees';
import { formatTimesheetEmployeeName } from '../../utils/timesheetDisplay';
import { getMonthLabel, formatDateRu, getDaysInMonth } from '../../utils/calendarUtils';
import type {
  TimesheetEntry,
  TimesheetEmployee,
  TimesheetObjectEntry,
  TimesheetStats as ITimesheetStats,
  TimesheetStatus,
  TimesheetTeamManagementCandidate,
} from '../../types';
import type { IResolvedSchedule } from '../../types/schedule';
import { TimesheetApprovalBar } from '../../components/timesheet/TimesheetApprovalBar';
import { getScheduleForTimesheetDay, getShiftDurationForDay, getWorkHoursForDay } from '../../utils/scheduleUtils';
import { useIsMobile } from '../../hooks/useIsMobile';
import {
  getHalfRange,
  formatHalfLabel,
  getHalfFromDate,
  getCurrentHalf,
  type TimesheetHalf,
} from '../../utils/timesheetApprovalPeriod';
import { useManagedDepartments } from '../../hooks/useManagedDepartments';
import { type IFlatDepartmentOption, getTreeFlatDepartments, filterDepartmentTreeByIds } from '../../utils/departmentUtils';
import './TimesheetPage.css';

const TimesheetSidePanel = lazy(() => import('../../components/timesheet/TimesheetSidePanel').then(module => ({
  default: module.TimesheetSidePanel,
})));
const TimesheetCorrectionModal = lazy(() => import('../../components/timesheet/TimesheetCorrectionModal').then(module => ({
  default: module.TimesheetCorrectionModal,
})));
const TravelExceptionModal = lazy(() => import('../../components/timesheet/TravelExceptionModal').then(module => ({
  default: module.TravelExceptionModal,
})));

const DEFAULT_STATS: ITimesheetStats = {
  employeeCount: 0,
  workingDays: 0,
  normHours: 0,
  actualHours: 0,
  deviations: { late: 0, absent: 0, sick: 0 },
};
const EMPTY_SCHEDULES: Record<number, IResolvedSchedule> = {};
const EMPTY_DAILY_SCHEDULES: Record<number, Record<string, IResolvedSchedule>> = {};

import {
  buildObjectBulkMetaKey,
  formatFioWithInitials,
  fromMonthIndex,
  getTodayDateInputValue,
  MONTH_NAMES_RU,
  parseBulkCellKey,
  parseMonthParam,
  sanitizeDownloadName,
  toMonthIndex,
  UNASSIGNED_OBJECT_KEY,
  UNASSIGNED_OBJECT_NAME,
  type IBulkCorrectionTarget,
  type IBulkObjectCorrectionTarget,
  type IObjectModalTarget,
  type TimesheetViewMode,
} from './timesheetPage.helpers';

export const TimesheetPage: FC = () => {
  const { hasPermission, profile, canEditPage, canViewPage } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const isSuperAdmin = profile?.is_admin === true;
  const canEditTimesheet = canEditPage('/timesheet') || canEditPage('/timesheet-hr');
  const canViewManagedTimesheet = canEditTimesheet || canViewPage('/timesheet') || canViewPage('/timesheet-hr');
  const canEditTeamManagement = isSuperAdmin
    || canEditPage('timesheet-team-management')
    || canEditPage('/timesheet')
    || canEditPage('/timesheet-hr');
  const canManageAllDepartments = isSuperAdmin || hasPermission('data.scope.all');
  const {
    isDepartmentScope,
    managedDepartmentIds,
    primaryDepartmentId,
    structureQuery,
  } = useManagedDepartments();
  const isTimesheetDepartmentScope = !canManageAllDepartments && isDepartmentScope && canViewManagedTimesheet;
  const isMultiDepartmentManager = isTimesheetDepartmentScope && managedDepartmentIds.length > 1;
  const queryMonth = searchParams.get('month');
  const queryFrom = searchParams.get('from');
  const queryHalf = searchParams.get('half');
  const queryView = searchParams.get('view');
  const queryMode = searchParams.get('mode');
  const queryAssignee = searchParams.get('assignee');
  const queryAssignedDept = searchParams.get('dept');
  const canUseAssignedMode = !isTimesheetDepartmentScope && (hasPermission('timesheet.workflow.monitor') || hasPermission('timesheet.workflow.review'));
  const timesheetMode: 'department' | 'assigned' = (queryMode === 'assigned' && canUseAssignedMode) ? 'assigned' : 'department';
  const selectedAssigneeId = useMemo(() => {
    if (timesheetMode !== 'assigned') return null;
    const parsed = Number.parseInt(queryAssignee || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }, [timesheetMode, queryAssignee]);
  const assignedExpandedDeptId = timesheetMode === 'assigned' ? queryAssignedDept : null;
  const now = useMemo(() => new Date(), []);
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const currentMonthIndex = toMonthIndex(currentYear, currentMonth);
  const previousMonthIndex = currentMonthIndex - 1;
  const isRestrictedManagerView = isTimesheetDepartmentScope;
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

  // Assignee selector (assigned-mode)
  const [assigneeOpen, setAssigneeOpen] = useState(false);
  const [assigneeSearch, setAssigneeSearch] = useState('');
  const assigneeRef = useRef<HTMLDivElement>(null);
  const assigneesQuery = useAssignedEmployees(canUseAssignedMode && timesheetMode === 'assigned');

  // Brigade selector (assigned-mode, multi-brigade assignee)
  const [brigadeOpen, setBrigadeOpen] = useState(false);
  const [brigadeSearch, setBrigadeSearch] = useState('');
  const brigadeRef = useRef<HTMLDivElement>(null);

  // Side panel
  const [panelEmployee, setPanelEmployee] = useState<TimesheetEmployee | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  // Modal
  const [modalOpen, setModalOpen] = useState(false);
  const [modalEmployee, setModalEmployee] = useState<TimesheetEmployee | null>(null);
  const [modalDay, setModalDay] = useState<number>(1);
  const [modalEntry, setModalEntry] = useState<TimesheetEntry | null>(null);
  const [modalMode, setModalMode] = useState<'day' | 'object'>('day');
  const [modalObjectEntry, setModalObjectEntry] = useState<TimesheetObjectEntry | null>(null);
  const [modalObjectTarget, setModalObjectTarget] = useState<IObjectModalTarget | null>(null);
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [bulkSelectedCellKeys, setBulkSelectedCellKeys] = useState<Set<string>>(new Set());
  const [teamManagementOpen, setTeamManagementOpen] = useState(false);
  const [teamSearch, setTeamSearch] = useState('');
  const [teamPendingEmployeeId, setTeamPendingEmployeeId] = useState<number | null>(null);
  const [travelExceptionTarget, setTravelExceptionTarget] = useState<{
    employeeId: number;
    employeeName: string;
    workDate: string;
  } | null>(null);
  const [refreshState, setRefreshState] = useState<{
    phase: 'idle' | 'syncing' | 'invalidating' | 'error';
    message: string;
  }>({ phase: 'idle', message: '' });
  const refreshInFlight = refreshState.phase === 'syncing' || refreshState.phase === 'invalidating';

  const deptOptions = useMemo<IFlatDepartmentOption[]>(() => {
    const allNodes = structureQuery.data?.departments ?? [];
    if (isDepartmentScope) {
      const filtered = filterDepartmentTreeByIds(allNodes, new Set(managedDepartmentIds));
      return getTreeFlatDepartments(filtered);
    }
    return getTreeFlatDepartments(allNodes);
  }, [structureQuery.data, isDepartmentScope, managedDepartmentIds]);
  const effectiveSelectedDeptId = isTimesheetDepartmentScope
    ? (selectedDeptId || primaryDepartmentId || null)
    : selectedDeptId;
  const viewMode: TimesheetViewMode = queryView === 'objects'
    ? 'objects'
    : queryView === 'corrections'
      ? 'corrections'
      : (queryView === 'transfers' && isSuperAdmin && timesheetMode !== 'assigned')
        ? 'transfers'
        : 'employees';

  useEffect(() => {
    if (!isMultiDepartmentManager) return;
    if (effectiveSelectedDeptId && managedDepartmentIds.includes(effectiveSelectedDeptId)) return;
    setSelectedDeptId(primaryDepartmentId || managedDepartmentIds[0] || null);
  }, [effectiveSelectedDeptId, isMultiDepartmentManager, managedDepartmentIds, primaryDepartmentId]);

  // Close dept/assignee/brigade dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (deptRef.current && !deptRef.current.contains(e.target as Node)) {
        setDeptOpen(false);
      }
      if (assigneeRef.current && !assigneeRef.current.contains(e.target as Node)) {
        setAssigneeOpen(false);
      }
      if (brigadeRef.current && !brigadeRef.current.contains(e.target as Node)) {
        setBrigadeOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const monthStr = useMemo(() => `${year}-${String(month).padStart(2, '0')}`, [year, month]);
  const daysInMonth = useMemo(() => getDaysInMonth(year, month), [year, month]);
  const selectedHalf = useMemo<TimesheetHalf>(() => {
    if (queryHalf === 'H1' || queryHalf === 'H2' || queryHalf === 'FULL') return queryHalf;
    if (queryFrom) return getHalfFromDate(queryFrom);
    const current = getCurrentHalf(now);
    return (current.year === year && current.month === month) ? current.half : 'H1';
  }, [queryHalf, queryFrom, now, year, month]);
  const activeRange = useMemo(() => getHalfRange(year, month, selectedHalf), [year, month, selectedHalf]);
  const rangeStart = activeRange.startDate;
  const rangeEnd = activeRange.endDate;
  const activeGridDeptId = timesheetMode === 'assigned' ? assignedExpandedDeptId : effectiveSelectedDeptId;
  const includeObjectDetails = viewMode === 'objects';
  const timesheetQuery = useQuery({
    queryKey: ['timesheet-page', monthStr, rangeStart, rangeEnd, activeGridDeptId ?? 'none', includeObjectDetails ? 'objects' : 'employees'],
    queryFn: () => timesheetService.getAll({
      month: monthStr,
      department_id: activeGridDeptId || undefined,
      from: rangeStart,
      to: rangeEnd,
      include_objects: includeObjectDetails,
      schedule_payload: 'compact',
    }),
    enabled: Boolean(activeGridDeptId),
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
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
  const objectEntries = useMemo<TimesheetObjectEntry[]>(
    () => timesheetQuery.data?.object_entries || [],
    [timesheetQuery.data],
  );
  const stats = timesheetQuery.data?.stats || DEFAULT_STATS;
  const employeeStats = timesheetQuery.data?.employee_stats || [];
  const schedules = timesheetQuery.data?.schedules || EMPTY_SCHEDULES;
  const dailySchedules = timesheetQuery.data?.daily_schedules || EMPTY_DAILY_SCHEDULES;
  const calendar = timesheetQuery.data?.calendar || null;
  const loading = Boolean(effectiveSelectedDeptId) && timesheetQuery.isLoading;
  const deferredTeamSearch = useDeferredValue(teamSearch.trim());
  const teamSearchQuery = useQuery({
    queryKey: ['timesheet-team-search', activeGridDeptId ?? 'none', deferredTeamSearch],
    queryFn: () => timesheetService.searchTeamEmployees({
      department_id: activeGridDeptId as string,
      q: deferredTeamSearch,
    }),
    enabled: teamManagementOpen && Boolean(activeGridDeptId) && deferredTeamSearch.length >= 2,
    staleTime: 2 * 60_000,
    placeholderData: previousData => previousData,
  });
  const visibleDays = useMemo(() => {
    const start = Number.parseInt(rangeStart.slice(-2), 10);
    const end = Number.parseInt(rangeEnd.slice(-2), 10);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      return [];
    }
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  }, [rangeStart, rangeEnd]);
  const lockedDateSet = useMemo(() => {
    const raw = (timesheetQuery.data as { approval_locked_dates?: string[] } | undefined)?.approval_locked_dates;
    return new Set<string>(Array.isArray(raw) ? raw : []);
  }, [timesheetQuery.data]);
  const entryMap = useMemo(() => {
    const map = new Map<string, TimesheetEntry>();
    for (const entry of entries) {
      map.set(`${entry.employee_id}_${entry.work_date}`, entry);
    }
    return map;
  }, [entries]);
  const objectEntriesByEmployeeDate = useMemo(() => {
    const map = new Map<number, Map<string, TimesheetObjectEntry[]>>();
    for (const entry of objectEntries) {
      if (!map.has(entry.employee_id)) {
        map.set(entry.employee_id, new Map());
      }
      const byDate = map.get(entry.employee_id)!;
      const items = byDate.get(entry.work_date) || [];
      items.push(entry);
      byDate.set(entry.work_date, items);
    }
    return map;
  }, [objectEntries]);
  // splitDayKeys раньше исключал дни с object_detail_mode='available' из обычного и bulk-клика,
  // чтобы заставить выбрать объект через split-view. UX убран — корректировка теперь применяется
  // к дню целиком, и bulk-edit работает по таким ячейкам как и по обычным.
  const splitDayKeys = useMemo(() => new Set<string>(), []);
  const employeeOrder = useMemo(() => (
    new Map(employees.map((employee, index) => [employee.id, index]))
  ), [employees]);
  const employeeMap = useMemo(() => (
    new Map(employees.map(employee => [employee.id, employee]))
  ), [employees]);
  const canManageTeam = Boolean(activeGridDeptId && canEditTeamManagement);
  const canUseTeamManagement = Boolean(canEditTeamManagement);
  const bulkModeEnabled = bulkMode && !isMobile;
  const clearBulkState = useCallback(() => {
    setBulkMode(false);
    setBulkModalOpen(false);
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
    setTeamManagementOpen(false);
    setTeamSearch('');
    setTeamPendingEmployeeId(null);
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      next.set('month', `${nextYear}-${String(nextMonth).padStart(2, '0')}`);
      next.delete('from');
      next.delete('to');
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
    if (bulkModeEnabled && viewMode === 'employees') return;
    setPanelEmployee(emp);
    setPanelOpen(true);
  };

  const closeModal = useCallback(() => {
    setModalOpen(false);
    setModalMode('day');
    setModalObjectEntry(null);
    setModalObjectTarget(null);
  }, []);

  // Day click -> modal
  const handleDayClick = (emp: TimesheetEmployee, day: number, entry: TimesheetEntry | null) => {
    if (bulkModeEnabled && viewMode === 'employees') return;
    const workDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    // Если в дне есть нерешённое превышение лимита передвижения или непривязанная точка —
    // приоритетно открываем модалку approve/reject (а не общую корректировку дня).
    if (entry && (entry.travel_problematic_segments || 0) > 0) {
      setTravelExceptionTarget({
        employeeId: emp.id,
        employeeName: emp.full_name,
        workDate,
      });
      return;
    }
    if (isTimesheetDepartmentScope && lockedDateSet.has(workDate)) {
      toast.info?.('Период согласован — редактирование закрыто');
      return;
    }
    setModalEmployee(emp);
    setModalDay(day);
    setModalEntry(entry);
    // Раньше при object_detail_mode='available' открывалась split-view со списком объектов;
    // выбор объекта вёл к per-object модалке, в которой всё равно показывались все события СКУД.
    // По решению — убираем выбор объекта: всегда открываем общую дневную модалку
    // (все события СКУД + одна корректировка на день).
    setModalMode('day');
    setModalObjectEntry(null);
    setModalObjectTarget(null);
    setModalOpen(true);
  };

  const handleObjectDayClick = useCallback((
    emp: TimesheetEmployee,
    day: number,
    target: IObjectModalTarget,
    objectEntry: TimesheetObjectEntry | null,
  ) => {
    const workDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (isTimesheetDepartmentScope && lockedDateSet.has(workDate)) {
      toast.info?.('Период согласован — редактирование закрыто');
      return;
    }
    setModalEmployee(emp);
    setModalDay(day);
    setModalEntry(entryMap.get(`${emp.id}_${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`) || null);
    setModalMode('object');
    setModalObjectEntry(objectEntry);
    setModalObjectTarget(target);
    setModalOpen(true);
  }, [entryMap, year, month]);

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
      closeModal();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['timesheet-page', monthStr, rangeStart, rangeEnd, activeGridDeptId ?? 'none'] }),
        queryClient.invalidateQueries({ queryKey: ['timesheet-corrections'] }),
      ]);
    } catch (err) {
      console.error('Save correction error:', err);
      toast.error?.(err instanceof Error ? err.message : 'Не удалось сохранить корректировку');
    }
  }, [modalEmployee, year, month, modalDay, modalEntry, closeModal, queryClient, monthStr, rangeStart, rangeEnd, activeGridDeptId, toast]);

  const handleSaveObjectCorrection = useCallback(async (_status: TimesheetStatus, hours: number | null, notes: string) => {
    if (!modalEmployee || !modalObjectTarget || hours == null) return;
    try {
      const workDate = `${year}-${String(month).padStart(2, '0')}-${String(modalDay).padStart(2, '0')}`;
      await timesheetService.upsertObjectEntry({
        employee_id: modalEmployee.id,
        work_date: workDate,
        object_key: modalObjectTarget.object_key,
        object_id: modalObjectTarget.object_id,
        object_name: modalObjectTarget.object_name,
        hours_worked: hours,
        notes,
      });
      closeModal();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['timesheet-page', monthStr, rangeStart, rangeEnd, activeGridDeptId ?? 'none'] }),
        queryClient.invalidateQueries({ queryKey: ['timesheet-corrections'] }),
      ]);
    } catch (error) {
      console.error('Save object correction error:', error);
      toast.error(error instanceof Error ? error.message : 'Не удалось сохранить корректировку по объекту');
    }
  }, [modalEmployee, modalObjectTarget, year, month, modalDay, closeModal, queryClient, monthStr, rangeStart, rangeEnd, activeGridDeptId, toast]);

  const handleSaveModalCorrection = useCallback(
    (status: TimesheetStatus, hours: number | null, notes: string) => {
      if (modalMode === 'object' && (status === 'work' || status === 'manual')) {
        return handleSaveObjectCorrection(status, hours, notes);
      }
      return handleSaveCorrection(status, hours, notes);
    },
    [modalMode, handleSaveCorrection, handleSaveObjectCorrection],
  );

  const handleDeleteDayCorrection = useCallback(async () => {
    if (!modalEntry?.id) return;
    try {
      await timesheetService.delete(modalEntry.id);
      closeModal();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['timesheet-page', monthStr, rangeStart, rangeEnd, activeGridDeptId ?? 'none'] }),
        queryClient.invalidateQueries({ queryKey: ['timesheet-corrections'] }),
      ]);
    } catch (error) {
      console.error('Delete day correction error:', error);
      toast.error(error instanceof Error ? error.message : 'Не удалось снять корректировку');
    }
  }, [modalEntry?.id, closeModal, queryClient, monthStr, rangeStart, rangeEnd, activeGridDeptId, toast]);

  const handleDeleteObjectCorrection = useCallback(async () => {
    if (!modalEmployee || !modalObjectTarget || !modalObjectEntry?.adjustment_id) return;
    try {
      const workDate = `${year}-${String(month).padStart(2, '0')}-${String(modalDay).padStart(2, '0')}`;
      await timesheetService.deleteObjectEntry({
        employee_id: modalEmployee.id,
        work_date: workDate,
        object_key: modalObjectTarget.object_key,
      });
      closeModal();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['timesheet-page', monthStr, rangeStart, rangeEnd, activeGridDeptId ?? 'none'] }),
        queryClient.invalidateQueries({ queryKey: ['timesheet-corrections'] }),
      ]);
    } catch (error) {
      console.error('Delete object correction error:', error);
      toast.error(error instanceof Error ? error.message : 'Не удалось снять корректировку по объекту');
    }
  }, [modalEmployee, modalObjectTarget, modalObjectEntry?.adjustment_id, year, month, modalDay, closeModal, queryClient, monthStr, rangeStart, rangeEnd, activeGridDeptId, toast]);

  // Export
  const canExport = timesheetMode === 'assigned'
    ? Boolean(selectedAssigneeId)
    : Boolean(effectiveSelectedDeptId);
  const exportPresentation: 'hr' | 'manager' = isTimesheetDepartmentScope ? 'manager' : 'hr';

  const handleExport = async (presentation: 'hr' | 'manager' = 'hr') => {
    if (!canExport) {
      toast.error(timesheetMode === 'assigned' ? 'Выберите начальника участка' : 'Выберите отдел');
      return;
    }
    try {
      const monthStr = `${year}-${String(month).padStart(2, '0')}`;
      const startDay = Number.parseInt(rangeStart.slice(-2), 10);
      const endDay = Number.parseInt(rangeEnd.slice(-2), 10);
      const isFullMonth = startDay === 1 && endDay === daysInMonth;
      const segmentSuffix = isFullMonth ? '' : `_${startDay}-${endDay}`;
      const monthName = MONTH_NAMES_RU[month];
      const presentationSuffix = presentation === 'manager' ? '_Руководитель' : '';
      const exportGrouping = viewMode === 'objects' ? 'objects' : 'employees';

      let blob: Blob;
      let filename: string;

      if (timesheetMode === 'assigned' && selectedAssigneeId) {
        blob = await timesheetService.exportAssigned({
          month: monthStr,
          from: rangeStart,
          to: rangeEnd,
          employee_ids: [selectedAssigneeId],
          group_by: exportGrouping,
          presentation,
        });
        const assignee = assigneesQuery.data?.find(emp => emp.id === selectedAssigneeId);
        const assigneeName = formatFioWithInitials(assignee?.full_name) || 'Участок';
        const suffix = exportGrouping === 'objects' ? '_объекты' : '';
        filename = `Участок_${assigneeName}${suffix}_${monthName}_${year}${segmentSuffix}${presentationSuffix}.zip`;
      } else if (viewMode === 'objects' && effectiveSelectedDeptId) {
        blob = await timesheetService.exportMass({
          month: monthStr,
          from: rangeStart,
          to: rangeEnd,
          department_ids: [effectiveSelectedDeptId],
          group_by: 'objects',
          presentation,
        });
        filename = `${selectedDeptName}_объекты_${monthName}_${year}${segmentSuffix}${presentationSuffix}.zip`;
      } else {
        blob = await timesheetService.export({
          month: monthStr,
          department_id: effectiveSelectedDeptId || undefined,
          from: rangeStart,
          to: rangeEnd,
          presentation,
        });
        filename = `${selectedDeptName}_${monthName}_${year}${segmentSuffix}${presentationSuffix}.xlsx`;
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = sanitizeDownloadName(filename);
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export error:', err);
      toast.error(err instanceof Error ? err.message : 'Ошибка экспорта');
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

  const assigneeDeptName = activeGridDeptId && selectedAssigneeId
    ? assigneesQuery.data?.find(emp => emp.id === selectedAssigneeId)?.departments?.find(d => d.id === activeGridDeptId)?.name
    : undefined;
  const selectedDeptName = activeGridDeptId
    ? deptOptions.find(d => d.id === activeGridDeptId)?.name
      || assigneeDeptName
      || 'Отдел'
    : 'Все отделы';
  const teamSearchResults = teamSearchQuery.data || [];
  const openTeamManagement = useCallback(() => {
    if (!canUseTeamManagement || !activeGridDeptId) return;
    setPanelOpen(false);
    setModalOpen(false);
    clearBulkState();
    setTeamSearch('');
    setTeamManagementOpen(true);
  }, [canUseTeamManagement, activeGridDeptId, clearBulkState]);

  const closeTeamManagement = useCallback(() => {
    setTeamManagementOpen(false);
    setTeamSearch('');
    setTeamPendingEmployeeId(null);
  }, []);

  const handleAddEmployeeToDepartment = useCallback(async (
    candidate: TimesheetTeamManagementCandidate,
    effectiveFrom: string,
  ) => {
    if (!activeGridDeptId) return;
    setTeamPendingEmployeeId(candidate.id);
    try {
      await timesheetService.addEmployeeToDepartment({
        employee_id: candidate.id,
        department_id: activeGridDeptId,
        effective_from: effectiveFrom,
      });
      toast.success(`Сотрудник ${candidate.full_name} переведён в отдел ${selectedDeptName} с ${effectiveFrom}`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['timesheet-page', monthStr, rangeStart, rangeEnd, activeGridDeptId ?? 'none'] }),
        queryClient.invalidateQueries({ queryKey: ['timesheet-corrections'] }),
        queryClient.invalidateQueries({ queryKey: ['timesheet-team-search'] }),
      ]);
      closeTeamManagement();
    } catch (error) {
      console.error('Add employee to department error:', error);
      toast.error(error instanceof Error ? error.message : 'Не удалось добавить сотрудника в отдел');
    } finally {
      setTeamPendingEmployeeId(null);
    }
  }, [rangeStart, rangeEnd, activeGridDeptId, monthStr, queryClient, selectedDeptName, toast, closeTeamManagement]);

  const [excludeModalEmployee, setExcludeModalEmployee] = useState<TimesheetEmployee | null>(null);

  const handleExcludeEmployeeFromDepartment = useCallback((employee: TimesheetEmployee) => {
    if (!activeGridDeptId) return;
    setExcludeModalEmployee(employee);
  }, [activeGridDeptId]);

  const handleConfirmExclude = useCallback(async (effectiveDate: string) => {
    if (!excludeModalEmployee || !activeGridDeptId) return;
    const employee = excludeModalEmployee;
    setTeamPendingEmployeeId(employee.id);
    try {
      await timesheetService.excludeEmployeeFromDepartment({
        employee_id: employee.id,
        department_id: activeGridDeptId,
        effective_date: effectiveDate,
      });
      if (panelEmployee?.id === employee.id) {
        setPanelOpen(false);
        setPanelEmployee(null);
      }
      toast.success(`Сотрудник ${employee.full_name} исключён из табеля с ${effectiveDate}`);
      setExcludeModalEmployee(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['timesheet-page', monthStr, rangeStart, rangeEnd, activeGridDeptId ?? 'none'] }),
        queryClient.invalidateQueries({ queryKey: ['timesheet-corrections'] }),
        queryClient.invalidateQueries({ queryKey: ['timesheet-team-search'] }),
      ]);
    } catch (error) {
      console.error('Exclude employee from department error:', error);
      toast.error(error instanceof Error ? error.message : 'Не удалось исключить сотрудника из табеля');
    } finally {
      setTeamPendingEmployeeId(null);
    }
  }, [excludeModalEmployee, rangeStart, rangeEnd, activeGridDeptId, monthStr, panelEmployee?.id, queryClient, toast]);

  const modalDefaultHours = useMemo(() => {
    if (modalMode === 'object') {
      return modalObjectEntry?.display_hours_worked ?? modalObjectEntry?.hours_worked ?? modalObjectEntry?.base_hours_worked ?? 0;
    }
    if (modalEntry?.display_hours_worked != null) return modalEntry.display_hours_worked;
    if (modalEntry?.hours_worked != null) return modalEntry.hours_worked;
    if (!modalEmployee) return 8;
    const sched = getScheduleForTimesheetDay(schedules, dailySchedules, modalEmployee.id, year, month, modalDay);
    return getWorkHoursForDay(sched, year, month, modalDay);
  }, [modalMode, modalObjectEntry, modalEntry, modalEmployee, schedules, dailySchedules, year, month, modalDay]);

  const modalMaxHours = useMemo(() => {
    if (!isTimesheetDepartmentScope || !modalEmployee) return null;
    const sched = getScheduleForTimesheetDay(schedules, dailySchedules, modalEmployee.id, year, month, modalDay);
    const shiftDuration = getShiftDurationForDay(sched, year, month, modalDay);
    if (modalMode !== 'object' || !modalObjectTarget) {
      return shiftDuration;
    }

    const workDate = `${year}-${String(month).padStart(2, '0')}-${String(modalDay).padStart(2, '0')}`;
    const dayObjectEntries = objectEntriesByEmployeeDate.get(modalEmployee.id)?.get(workDate) || [];
    const otherHours = dayObjectEntries.reduce((sum, item) => {
      if (item.object_key === modalObjectTarget.object_key) {
        return sum;
      }
      return sum + (item.display_hours_worked ?? item.hours_worked ?? 0);
    }, 0);
    return Math.max(0, shiftDuration - otherHours);
  }, [
    isTimesheetDepartmentScope,
    modalEmployee,
    schedules,
    dailySchedules,
    year,
    month,
    modalDay,
    modalMode,
    modalObjectTarget,
    objectEntriesByEmployeeDate,
  ]);

  const handleBulkModeToggle = useCallback(() => {
    if (bulkModeEnabled) {
      clearBulkState();
      return;
    }

    setPanelOpen(false);
    setModalOpen(false);
    setBulkMode(true);
  }, [bulkModeEnabled, clearBulkState]);

  const handleBulkSelectionChange = useCallback((cellKeys: Set<string>) => {
    setBulkSelectedCellKeys(new Set(cellKeys));
  }, []);

  const handleBulkBlockedSelectionAttempt = useCallback(() => {
    toast.info('Некоторые ячейки нельзя включить в массовую корректировку. Для них используйте точечное редактирование.');
  }, [toast]);

  const bulkTargets = useMemo<IBulkCorrectionTarget[]>(() => {
    if (!bulkModeEnabled || viewMode !== 'employees') return [];

    const targets = new Map<string, IBulkCorrectionTarget>();
    bulkSelectedCellKeys.forEach(cellKey => {
      const parsedKey = parseBulkCellKey(cellKey);
      if (!parsedKey || parsedKey.kind !== 'employee') return;
      const { employeeId, day } = parsedKey;

      const employee = employeeMap.get(employeeId);
      if (!employee) return;

      const workDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const key = `${employee.id}_${workDate}`;
      if (splitDayKeys.has(key) || targets.has(key)) return;

      targets.set(key, {
        employee,
        day,
        workDate,
        entry: entryMap.get(key) || null,
      });
    });

    return [...targets.values()].sort((left, right) => {
      const employeeDiff = (employeeOrder.get(left.employee.id) ?? 0) - (employeeOrder.get(right.employee.id) ?? 0);
      return employeeDiff !== 0 ? employeeDiff : left.day - right.day;
    });
  }, [
    bulkModeEnabled,
    bulkSelectedCellKeys,
    year,
    month,
    entryMap,
    employeeMap,
    employeeOrder,
    splitDayKeys,
    viewMode,
  ]);

  const bulkObjectRowMetaMap = useMemo(() => {
    const metaMap = new Map<string, {
      employee: TimesheetEmployee;
      objectTarget: IObjectModalTarget;
      isSynthetic: boolean;
    }>();

    for (const objectEntry of objectEntries) {
      const employee = employeeMap.get(objectEntry.employee_id);
      if (!employee) continue;

      metaMap.set(buildObjectBulkMetaKey(employee.id, objectEntry.object_key), {
        employee,
        objectTarget: {
          object_key: objectEntry.object_key,
          object_id: objectEntry.object_id,
          object_name: objectEntry.object_name,
        },
        isSynthetic: false,
      });
    }

    for (const employee of employees) {
      for (const day of visibleDays) {
        const workDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const dayEntry = entryMap.get(`${employee.id}_${workDate}`) || null;
        const visibleHours = dayEntry?.display_hours_worked ?? dayEntry?.hours_worked ?? 0;
        if (visibleHours <= 0.001) continue;

        const dayObjectEntries = objectEntriesByEmployeeDate.get(employee.id)?.get(workDate) || [];
        const allocatedHours = dayObjectEntries.reduce((sum, item) => (
          sum + (item.display_hours_worked ?? item.hours_worked ?? 0)
        ), 0);
        if (visibleHours - allocatedHours <= 0.001) continue;

        metaMap.set(buildObjectBulkMetaKey(employee.id, UNASSIGNED_OBJECT_KEY), {
          employee,
          objectTarget: {
            object_key: UNASSIGNED_OBJECT_KEY,
            object_id: null,
            object_name: UNASSIGNED_OBJECT_NAME,
          },
          isSynthetic: true,
        });
      }
    }

    return metaMap;
  }, [
    objectEntries,
    employeeMap,
    employees,
    visibleDays,
    year,
    month,
    entryMap,
    objectEntriesByEmployeeDate,
  ]);

  const bulkObjectTargets = useMemo<IBulkObjectCorrectionTarget[]>(() => {
    if (!bulkModeEnabled) return [];

    const targets = new Map<string, IBulkObjectCorrectionTarget>();
    bulkSelectedCellKeys.forEach(cellKey => {
      const parsedKey = parseBulkCellKey(cellKey);
      if (!parsedKey || parsedKey.kind !== 'object') return;

      const { employeeId, objectKey, day } = parsedKey;
      const meta = bulkObjectRowMetaMap.get(buildObjectBulkMetaKey(employeeId, objectKey));
      if (!meta || meta.isSynthetic) return;

      const workDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const objectEntry = objectEntriesByEmployeeDate
        .get(employeeId)
        ?.get(workDate)
        ?.find(item => item.object_key === objectKey) || null;

      targets.set(cellKey, {
        employee: meta.employee,
        day,
        workDate,
        objectTarget: meta.objectTarget,
        objectEntry,
      });
    });

    return [...targets.values()].sort((left, right) => {
      const objectDiff = left.objectTarget.object_name.localeCompare(right.objectTarget.object_name, 'ru');
      if (objectDiff !== 0) return objectDiff;
      const employeeDiff = (employeeOrder.get(left.employee.id) ?? 0) - (employeeOrder.get(right.employee.id) ?? 0);
      return employeeDiff !== 0 ? employeeDiff : left.day - right.day;
    });
  }, [
    bulkModeEnabled,
    bulkSelectedCellKeys,
    bulkObjectRowMetaMap,
    year,
    month,
    objectEntriesByEmployeeDate,
    employeeOrder,
  ]);

  const isObjectBulkOperation = (
    viewMode === 'objects'
    || (viewMode === 'employees' && bulkObjectTargets.length > 0 && bulkTargets.length === 0)
  );

  const bulkInitialStatus = useMemo<TimesheetStatus>(() => {
    if (isObjectBulkOperation) {
      return 'manual';
    }
    if (bulkTargets.length === 1 && bulkTargets[0].entry?.status) {
      return bulkTargets[0].entry.status;
    }
    return 'work';
  }, [bulkTargets, isObjectBulkOperation]);

  const bulkDefaultHours = useMemo(() => {
    if (isObjectBulkOperation) {
      if (bulkObjectTargets.length === 0) return 0;
      const firstTarget = bulkObjectTargets[0];
      return firstTarget.objectEntry?.display_hours_worked
        ?? firstTarget.objectEntry?.hours_worked
        ?? firstTarget.objectEntry?.base_hours_worked
        ?? 0;
    }
    if (bulkTargets.length === 0) return 8;
    const firstTarget = bulkTargets[0];
    if (firstTarget.entry?.display_hours_worked != null) return firstTarget.entry.display_hours_worked;
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
  }, [isObjectBulkOperation, bulkObjectTargets, bulkTargets, schedules, dailySchedules, year, month]);

  const bulkMaxHours = useMemo(() => {
    if (!isTimesheetDepartmentScope) return null;
    if (isObjectBulkOperation) {
      if (bulkObjectTargets.length === 0) return null;
      return bulkObjectTargets.reduce<number | null>((minValue, target) => {
        const sched = getScheduleForTimesheetDay(
          schedules,
          dailySchedules,
          target.employee.id,
          year,
          month,
          target.day,
        );
        const shiftDuration = getShiftDurationForDay(sched, year, month, target.day);
        const dayObjectEntries = objectEntriesByEmployeeDate.get(target.employee.id)?.get(target.workDate) || [];
        const otherHours = dayObjectEntries.reduce((sum, item) => {
          if (item.object_key === target.objectTarget.object_key) {
            return sum;
          }
          return sum + (item.display_hours_worked ?? item.hours_worked ?? 0);
        }, 0);
        const allowedHours = Math.max(0, shiftDuration - otherHours);
        return minValue == null ? allowedHours : Math.min(minValue, allowedHours);
      }, null);
    }
    if (bulkTargets.length === 0) return null;
    const firstTarget = bulkTargets[0];
    const sched = getScheduleForTimesheetDay(
      schedules,
      dailySchedules,
      firstTarget.employee.id,
      year,
      month,
      firstTarget.day,
    );
    return getShiftDurationForDay(sched, year, month, firstTarget.day);
  }, [
    isTimesheetDepartmentScope,
    isObjectBulkOperation,
    bulkObjectTargets,
    bulkTargets,
    schedules,
    dailySchedules,
    year,
    month,
    objectEntriesByEmployeeDate,
  ]);

  const handleOpenBulkModal = useCallback(() => {
    if (viewMode === 'employees' && bulkTargets.length > 0 && bulkObjectTargets.length > 0) {
      toast.info('Сначала примените или сбросьте выделение одного типа: либо по сотрудникам, либо по объектам.');
      return;
    }
    if (isObjectBulkOperation) {
      if (bulkObjectTargets.length === 0) {
        toast.info('Выделите диапазон ячеек по объектам. Строка "Не определён / без объекта" корректируется только точечно.');
        return;
      }
      setBulkModalOpen(true);
      return;
    }
    if (bulkTargets.length === 0) {
      toast.info('Зажмите левую кнопку мыши и выделите диапазон ячеек без объектной разбивки');
      return;
    }
    setBulkModalOpen(true);
  }, [viewMode, isObjectBulkOperation, bulkObjectTargets.length, bulkTargets.length, toast]);

  const handleSaveBulkCorrection = useCallback(async (status: TimesheetStatus, hours: number | null, notes: string) => {
    if (isObjectBulkOperation) {
      if (bulkObjectTargets.length === 0) return;
      try {
        await Promise.all(bulkObjectTargets.map(target => timesheetService.upsertObjectEntry({
          employee_id: target.employee.id,
          work_date: target.workDate,
          object_key: target.objectTarget.object_key,
          object_id: target.objectTarget.object_id,
          object_name: target.objectTarget.object_name,
          hours_worked: hours ?? 0,
          notes,
        })));

        clearBulkState();
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['timesheet-page', monthStr, rangeStart, rangeEnd, activeGridDeptId ?? 'none'] }),
        queryClient.invalidateQueries({ queryKey: ['timesheet-corrections'] }),
        ]);
        toast.success(`Корректировка по объектам применена для ${bulkObjectTargets.length} ячеек`);
      } catch (error) {
        console.error('Bulk object save correction error:', error);
        toast.error(error instanceof Error ? error.message : 'Не удалось применить массовую корректировку по объектам');
      }
      return;
    }
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
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['timesheet-page', monthStr, rangeStart, rangeEnd, activeGridDeptId ?? 'none'] }),
        queryClient.invalidateQueries({ queryKey: ['timesheet-corrections'] }),
      ]);
      toast.success(`Корректировка применена для ${result.processed} ячеек`);
    } catch (error) {
      console.error('Bulk save correction error:', error);
      toast.error(error instanceof Error ? error.message : 'Не удалось применить массовую корректировку');
    }
  }, [
    isObjectBulkOperation,
    bulkObjectTargets,
    bulkTargets,
    clearBulkState,
    queryClient,
    monthStr,
    rangeStart,
    rangeEnd,
    activeGridDeptId,
    toast,
  ]);

  const bulkSelectedEmployeesCount = useMemo(() => (
    new Set(
      [...bulkSelectedCellKeys]
        .map(parseBulkCellKey)
        .filter((item): item is NonNullable<ReturnType<typeof parseBulkCellKey>> => Boolean(item))
        .map(item => item.employeeId),
    ).size
  ), [bulkSelectedCellKeys]);
  const bulkSelectedDaysCount = useMemo(() => (
    new Set(
      [...bulkSelectedCellKeys]
        .map(parseBulkCellKey)
        .filter((item): item is NonNullable<ReturnType<typeof parseBulkCellKey>> => Boolean(item))
        .map(item => item.day),
    ).size
  ), [bulkSelectedCellKeys]);
  const bulkSelectedObjectRowsCount = useMemo(() => (
    new Set(
      [...bulkSelectedCellKeys]
        .map(parseBulkCellKey)
        .filter((item): item is Extract<NonNullable<ReturnType<typeof parseBulkCellKey>>, { kind: 'object' }> => item?.kind === 'object')
        .map(item => buildObjectBulkMetaKey(item.employeeId, item.objectKey)),
    ).size
  ), [bulkSelectedCellKeys]);
  const bulkSelectionSummary = useMemo(() => {
    if (isObjectBulkOperation) {
      return [
        `${bulkSelectedObjectRowsCount} строк объектов`,
        `${bulkSelectedDaysCount} дней`,
        `${bulkObjectTargets.length} ячеек`,
      ].join(' • ');
    }

    return [
      `${bulkSelectedEmployeesCount} сотрудников`,
      `${bulkSelectedDaysCount} дней`,
      `${bulkTargets.length} ячеек`,
    ].join(' • ');
  }, [
    isObjectBulkOperation,
    bulkSelectedObjectRowsCount,
    bulkSelectedDaysCount,
    bulkObjectTargets.length,
    bulkSelectedEmployeesCount,
    bulkTargets.length,
  ]);

  const handleHalfChange = useCallback((nextHalf: TimesheetHalf) => {
    if (nextHalf === selectedHalf) return;
    clearBulkState();
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      next.set('half', nextHalf);
      next.delete('from');
      next.delete('to');
      return next;
    });
  }, [selectedHalf, clearBulkState, setSearchParams]);

  const handleViewModeChange = useCallback((nextViewMode: TimesheetViewMode) => {
    clearBulkState();
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      if (nextViewMode === 'employees') {
        next.delete('view');
      } else {
        next.set('view', nextViewMode);
      }
      return next;
    });
  }, [clearBulkState, setSearchParams]);

  const handleTimesheetModeChange = useCallback((nextMode: 'department' | 'assigned') => {
    clearBulkState();
    closeTeamManagement();
    setPanelOpen(false);
    setModalOpen(false);
    setDeptOpen(false);
    setAssigneeOpen(false);
    setAssigneeSearch('');
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      if (nextMode === 'assigned') {
        next.set('mode', 'assigned');
      } else {
        next.delete('mode');
        next.delete('assignee');
        next.delete('dept');
      }
      return next;
    });
  }, [clearBulkState, closeTeamManagement, setSearchParams]);

  const handleSelectAssignee = useCallback((employeeId: number | null) => {
    setAssigneeOpen(false);
    setAssigneeSearch('');
    clearBulkState();
    closeTeamManagement();
    setPanelOpen(false);
    setModalOpen(false);
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      next.set('mode', 'assigned');
      if (employeeId) {
        next.set('assignee', String(employeeId));
      } else {
        next.delete('assignee');
      }
      next.delete('dept');
      return next;
    });
  }, [clearBulkState, closeTeamManagement, setSearchParams]);

  const handleRefreshTimesheet = useCallback(async () => {
    if (!rangeStart || !rangeEnd || refreshInFlight) return;
    setRefreshState({ phase: 'syncing', message: 'Синхронизация СКУД…' });

    const controller = new AbortController();
    const timeoutMs = 90_000;
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

    try {
      const result = await timesheetService.refresh(
        { start_date: rangeStart, end_date: rangeEnd },
        { signal: controller.signal, sync_mode: 'full' },
      );
      setRefreshState({ phase: 'invalidating', message: 'Обновление данных табеля…' });
      // Полное обновление: данные табеля + резолв расписаний + согласования.
      // Без инвалидации schedules покраска полного дня (full_day_threshold) останется
      // по старым значениям шаблона, если он был отредактирован в другой вкладке.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['timesheet-page', monthStr, rangeStart, rangeEnd, activeGridDeptId ?? 'none'] }),
        queryClient.invalidateQueries({ queryKey: ['timesheet-corrections'] }),
        queryClient.invalidateQueries({ queryKey: ['schedules'] }),
        queryClient.invalidateQueries({ queryKey: ['timesheet-approval'] }),
        queryClient.invalidateQueries({ queryKey: ['employee-timesheet'] }),
      ]);
      const parts: string[] = [];
      if (result.sync) {
        parts.push(`события: ${result.sync.imported ?? 0}/${result.sync.sigurTotal ?? 0}`);
      }
      if (result.conflicts.length > 0) {
        parts.push(`коллизий: ${result.conflicts.length}`);
      }
      if (result.timed_out) {
        toast.error?.('Синхронизация СКУД не успела завершиться, фоновая выгрузка продолжается');
      } else {
        toast.success?.(parts.length > 0 ? `Обновлено (${parts.join(', ')})` : 'Табель обновлён');
      }
      setRefreshState({ phase: 'idle', message: '' });
    } catch (err) {
      const aborted = (err as { name?: string } | null)?.name === 'AbortError' || controller.signal.aborted;
      const apiError = err instanceof ApiError ? err : null;
      if (apiError?.code === 'SYNC_IN_PROGRESS') {
        toast.error?.('Синхронизация уже идёт фоном, попробуйте через минуту');
        setRefreshState({ phase: 'idle', message: '' });
      } else if (aborted) {
        toast.error?.('Сервер не ответил за 90 секунд, повторите попытку');
        setRefreshState({ phase: 'error', message: 'Таймаут' });
        setTimeout(() => setRefreshState({ phase: 'idle', message: '' }), 3000);
      } else {
        const message = err instanceof Error ? err.message : 'Ошибка обновления табеля';
        toast.error?.(message);
        setRefreshState({ phase: 'error', message: 'Ошибка обновления' });
        setTimeout(() => setRefreshState({ phase: 'idle', message: '' }), 3000);
      }
    } finally {
      window.clearTimeout(timeoutId);
    }
  }, [rangeStart, rangeEnd, refreshInFlight, queryClient, monthStr, activeGridDeptId, toast]);

  const handleSelectBrigade = useCallback((departmentId: string) => {
    clearBulkState();
    closeTeamManagement();
    setPanelOpen(false);
    setModalOpen(false);
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      next.set('dept', departmentId);
      return next;
    });
    setBrigadeOpen(false);
  }, [clearBulkState, closeTeamManagement, setSearchParams]);

  const assignedEmployees = useMemo(() => assigneesQuery.data || [], [assigneesQuery.data]);
  const filteredAssignees = useMemo(() => {
    const q = assigneeSearch.trim().toLowerCase();
    if (!q) return assignedEmployees;
    return assignedEmployees.filter(emp => emp.full_name.toLowerCase().includes(q));
  }, [assignedEmployees, assigneeSearch]);

  const selectedAssignee = useMemo(() => {
    if (!selectedAssigneeId) return null;
    return assignedEmployees.find(emp => emp.id === selectedAssigneeId) || null;
  }, [selectedAssigneeId, assignedEmployees]);

  // Auto-select the first brigade of the selected assignee
  useEffect(() => {
    if (timesheetMode !== 'assigned') return;
    if (!selectedAssignee) return;
    if (assignedExpandedDeptId) return;
    const depts = selectedAssignee.departments || [];
    if (depts.length >= 1) {
      const first = depts[0];
      setSearchParams(current => {
        const next = new URLSearchParams(current);
        next.set('dept', first.id);
        return next;
      }, { replace: true });
    }
  }, [timesheetMode, selectedAssignee, assignedExpandedDeptId, setSearchParams]);

  const assigneeButtonLabel = selectedAssignee
    ? formatTimesheetEmployeeName(selectedAssignee.full_name)
    : 'Выберите сотрудника';

  const assigneeBrigades = useMemo(
    () => selectedAssignee?.departments || [],
    [selectedAssignee],
  );
  const filteredBrigades = useMemo(() => {
    const q = brigadeSearch.trim().toLowerCase();
    if (!q) return assigneeBrigades;
    return assigneeBrigades.filter(d => d.name.toLowerCase().includes(q));
  }, [assigneeBrigades, brigadeSearch]);
  const selectedBrigadeName = assignedExpandedDeptId
    ? assigneeBrigades.find(d => d.id === assignedExpandedDeptId)?.name || 'Бригада'
    : 'Выберите бригаду';
  const showBrigadeSelector = timesheetMode === 'assigned' && assigneeBrigades.length > 1;

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

  const isSingleDeptManager = isTimesheetDepartmentScope && managedDepartmentIds.length === 1;

  const departmentControl = (
    <div className="ts-dept-wrap" ref={deptRef}>
      {isSingleDeptManager ? (
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
              {!isTimesheetDepartmentScope && (
                <div
                  className={`ts-dept-item ${!selectedDeptId ? 'ts-dept-item--active' : ''}`}
                  onClick={() => { clearBulkState(); closeTeamManagement(); setSelectedDeptId(null); setDeptOpen(false); setDeptSearch(''); }}
                >
                  Все отделы
                </div>
              )}
              {filteredDepts.map(d =>
                d.hasChildren ? (
                  <div key={d.id} className="ts-dept-item ts-dept-item--header">
                    {d.name}
                  </div>
                ) : (
                  <div
                    key={d.id}
                    className={`ts-dept-item ${selectedDeptId === d.id ? 'ts-dept-item--active' : ''}`}
                    style={{ paddingLeft: `${10 + d.level * 12}px` }}
                    onClick={() => { clearBulkState(); closeTeamManagement(); setSelectedDeptId(d.id); setDeptOpen(false); setDeptSearch(''); }}
                  >
                    {d.name}
                  </div>
                )
              )}
            </div>
          )}
        </>
      )}
    </div>
  );

  const assigneeControl = (
    <div className="ts-dept-wrap" ref={assigneeRef}>
      <button type="button" className="ts-dept-btn" onClick={() => setAssigneeOpen(!assigneeOpen)}>
        {assigneeButtonLabel}
        <ChevronDown size={16} />
      </button>
      {assigneeOpen && (
        <div className="ts-dept-dropdown ts-assignee-dropdown">
          <input
            className="ts-dept-search"
            placeholder="Поиск по ФИО..."
            value={assigneeSearch}
            onChange={e => setAssigneeSearch(e.target.value)}
            autoFocus
          />
          {assigneesQuery.isLoading ? (
            <div className="ts-dept-item ts-dept-item--muted">Загрузка...</div>
          ) : assigneesQuery.isError ? (
            <div className="ts-dept-item ts-dept-item--muted">Ошибка загрузки</div>
          ) : filteredAssignees.length === 0 ? (
            <div className="ts-dept-item ts-dept-item--muted">
              {assignedEmployees.length === 0 ? 'Назначенных нет' : 'Никого не найдено'}
            </div>
          ) : filteredAssignees.map(emp => (
            <div
              key={emp.id}
              className={`ts-dept-item ts-assignee-item ${selectedAssigneeId === emp.id ? 'ts-dept-item--active' : ''}`}
              onClick={() => handleSelectAssignee(emp.id)}
            >
              <span className="ts-assignee-name">{formatTimesheetEmployeeName(emp.full_name)}</span>
              {emp.email && (
                <span className="ts-assignee-email-dot" title={emp.email}>
                  <Mail size={12} />
                </span>
              )}
              <span className="ts-assignee-badge">{emp.department_count} отд.</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const brigadeControl = showBrigadeSelector ? (
    <div className="ts-dept-wrap" ref={brigadeRef}>
      <button type="button" className="ts-dept-btn" onClick={() => setBrigadeOpen(!brigadeOpen)}>
        {selectedBrigadeName}
        <ChevronDown size={16} />
      </button>
      {brigadeOpen && (
        <div className="ts-dept-dropdown">
          <input
            className="ts-dept-search"
            placeholder="Поиск бригады..."
            value={brigadeSearch}
            onChange={e => setBrigadeSearch(e.target.value)}
            autoFocus
          />
          {filteredBrigades.map(d => (
            <div
              key={d.id}
              className={`ts-dept-item ${assignedExpandedDeptId === d.id ? 'ts-dept-item--active' : ''}`}
              onClick={() => handleSelectBrigade(d.id)}
            >
              {d.name}
            </div>
          ))}
        </div>
      )}
    </div>
  ) : null;

  const modeControl = canUseAssignedMode ? (
    <section className="ts-mode-switch">
      <button
        type="button"
        className={`ts-mode-chip ${timesheetMode === 'department' ? 'ts-mode-chip--active' : ''}`}
        onClick={() => handleTimesheetModeChange('department')}
      >
        По отделу
      </button>
      <button
        type="button"
        className={`ts-mode-chip ${timesheetMode === 'assigned' ? 'ts-mode-chip--active' : ''}`}
        onClick={() => handleTimesheetModeChange('assigned')}
      >
        По участкам
      </button>
    </section>
  ) : null;

  const selectorControl = timesheetMode === 'assigned' ? assigneeControl : departmentControl;
  const isAssignedMode = timesheetMode === 'assigned';

  const segmentControl = (isAssignedMode ? selectedAssigneeId : effectiveSelectedDeptId) ? (
    <section className="ts-half-toggle" aria-label="Период табеля">
      <button
        type="button"
        className={`ts-half-chip ${selectedHalf === 'H1' ? 'ts-half-chip--active' : ''}`}
        onClick={() => handleHalfChange('H1')}
      >
        {formatHalfLabel(year, month, 'H1')}
      </button>
      <button
        type="button"
        className={`ts-half-chip ${selectedHalf === 'H2' ? 'ts-half-chip--active' : ''}`}
        onClick={() => handleHalfChange('H2')}
      >
        {formatHalfLabel(year, month, 'H2')}
      </button>
      <button
        type="button"
        className={`ts-half-chip ${selectedHalf === 'FULL' ? 'ts-half-chip--active' : ''}`}
        onClick={() => handleHalfChange('FULL')}
      >
        {formatHalfLabel(year, month, 'FULL')}
      </button>
    </section>
  ) : null;
  const hasActiveScope = (isAssignedMode ? selectedAssigneeId : effectiveSelectedDeptId);

  const viewControl = hasActiveScope ? (
    <section className="ts-view-switch">
      <button
        type="button"
        className={`ts-view-chip ${viewMode === 'employees' ? ' ts-view-chip--active' : ''}`}
        onClick={() => handleViewModeChange('employees')}
      >
        По сотрудникам
      </button>
      <button
        type="button"
        className={`ts-view-chip ${viewMode === 'objects' ? ' ts-view-chip--active' : ''}`}
        onClick={() => handleViewModeChange('objects')}
      >
        По объектам
      </button>
      <button
        type="button"
        className={`ts-view-chip ${viewMode === 'corrections' ? ' ts-view-chip--active' : ''}`}
        onClick={() => handleViewModeChange('corrections')}
      >
        Корректировки
      </button>
      {isSuperAdmin && !isAssignedMode && (
        <button
          type="button"
          className={`ts-view-chip ${viewMode === 'transfers' ? ' ts-view-chip--active' : ''}`}
          onClick={() => handleViewModeChange('transfers')}
        >
          <ArrowRightLeft size={14} /> Переводы
        </button>
      )}
    </section>
  ) : null;

  const viewControlPrimary = hasActiveScope ? (
    <section className="ts-view-switch">
      <button
        type="button"
        className={`ts-view-chip ${viewMode === 'employees' ? ' ts-view-chip--active' : ''}`}
        onClick={() => handleViewModeChange('employees')}
      >
        По сотрудникам
      </button>
      <button
        type="button"
        className={`ts-view-chip ${viewMode === 'objects' ? ' ts-view-chip--active' : ''}`}
        onClick={() => handleViewModeChange('objects')}
      >
        По объектам
      </button>
    </section>
  ) : null;

  const correctionsChip = hasActiveScope ? (
    <button
      type="button"
      className={`ts-view-chip ${viewMode === 'corrections' ? ' ts-view-chip--active' : ''}`}
      onClick={() => handleViewModeChange('corrections')}
    >
      Корректировки
    </button>
  ) : null;

  const transfersChip = hasActiveScope && isSuperAdmin && !isAssignedMode ? (
    <button
      type="button"
      className={`ts-view-chip ${viewMode === 'transfers' ? ' ts-view-chip--active' : ''}`}
      onClick={() => handleViewModeChange('transfers')}
    >
      <ArrowRightLeft size={14} /> Переводы
    </button>
  ) : null;

  const modalWorkDate = `${year}-${String(month).padStart(2, '0')}-${String(modalDay).padStart(2, '0')}`;

  return (
    <div className="ts-page">
      <div className="ts-page-header">
        {isMobile ? (
          <section className="ts-top-panel ts-top-panel--mobile">
            <div className="ts-mobile-header-row">
              <h1 className="ts-title">Табель</h1>
              <div className="ts-mobile-header-actions">
                {!isAssignedMode && canUseTeamManagement && (
                  <button
                    type="button"
                    className="ts-btn ts-btn--chip"
                    onClick={openTeamManagement}
                    disabled={!effectiveSelectedDeptId}
                    title={!effectiveSelectedDeptId ? 'Сначала выберите отдел' : undefined}
                  >
                    <UserPlus size={16} />
                    Добавить сотрудника
                  </button>
                )}
                {!isAssignedMode && (
                  <button
                    type="button"
                    className={`ts-btn ts-btn--chip${mobileApprovalVisible ? ' ts-btn--active' : ''}`}
                    onClick={() => setMobileApprovalOpen(open => !open)}
                  >
                    {mobileApprovalVisible ? 'Скрыть согласование' : 'Согласование'}
                  </button>
                )}
                <button
                  type="button"
                  className="ts-btn ts-btn--icon"
                  onClick={() => handleExport(exportPresentation)}
                  disabled={!canExport}
                  aria-label="Экспорт табеля"
                  title={exportPresentation === 'manager' ? 'Экспорт (урезано по графику)' : 'Экспорт'}
                >
                  <Download size={16} />
                </button>
              </div>
            </div>
            <div className="ts-mobile-header-row ts-mobile-header-row--controls">
              {monthNavigation}
              {selectorControl}
              {isAssignedMode && brigadeControl}
            </div>
            {modeControl}
            {!isAssignedMode && <TimesheetStats stats={stats} compact />}
            {mobileApprovalVisible && !isAssignedMode && (
              <div className="ts-mobile-approval-panel">
                <TimesheetApprovalBar
                  departmentId={effectiveSelectedDeptId}
                  month={`${year}-${String(month).padStart(2, '0')}`}
                  startDate={rangeStart}
                  endDate={rangeEnd}
                  compact
                  allowReview={false}
                />
              </div>
            )}
          </section>
        ) : (
          <section className="ts-top-panel">
            <div className="ts-header-grid">
              <div className="ts-header-cell ts-header-cell--left">
                {modeControl}
                {selectorControl}
                {isAssignedMode && brigadeControl}
              </div>
              <div className="ts-header-cell ts-header-cell--center">
                {monthNavigation}
                {segmentControl}
              </div>
              <div className="ts-header-cell ts-header-cell--right">
                <TimesheetApprovalBar
                  departmentId={activeGridDeptId}
                  month={`${year}-${String(month).padStart(2, '0')}`}
                  startDate={rangeStart}
                  endDate={rangeEnd}
                  allowReview={false}
                />
              </div>
            </div>

            <div className="ts-header-toolbar">
              <div className="ts-header-toolbar-left">
                {viewControlPrimary}
              </div>
              <div className="ts-header-toolbar-right">
                <TimesheetStats stats={stats} />
                {correctionsChip}
                {transfersChip}
                <button
                  type="button"
                  className="ts-btn"
                  onClick={() => handleExport(exportPresentation)}
                  disabled={!canExport}
                  title={exportPresentation === 'manager' ? 'Табель урезан по графику работы' : undefined}
                >
                  <Download size={16} />
                  Экспорт
                </button>
                <button
                  type="button"
                  className="ts-btn"
                  onClick={handleRefreshTimesheet}
                  disabled={refreshInFlight || !rangeStart || !rangeEnd}
                  title="Пересинхронизировать события СКУД и обновить табель"
                >
                  <RefreshCw size={16} className={refreshInFlight ? 'ts-refresh-spinning' : undefined} />
                  Обновить
                </button>
                {refreshState.phase !== 'idle' && (
                  <span
                    className={`ts-refresh-status${refreshState.phase === 'error' ? ' ts-refresh-status--error' : ''}`}
                    role="status"
                    aria-live="polite"
                  >
                    {refreshState.message}
                  </span>
                )}
                {canUseTeamManagement && (
                  <button
                    type="button"
                    className="ts-btn ts-btn--primary"
                    onClick={openTeamManagement}
                    disabled={!activeGridDeptId}
                    title={!activeGridDeptId ? 'Сначала выберите отдел' : undefined}
                  >
                    <UserPlus size={16} />
                    Добавить сотрудника
                  </button>
                )}
                {activeGridDeptId && (
                  <button
                    type="button"
                    className={`ts-btn ts-btn--chip ts-btn--bulk-toggle${bulkModeEnabled ? ' ts-btn--active' : ''}`}
                    onClick={handleBulkModeToggle}
                  >
                    Режим корректировок
                  </button>
                )}
              </div>
            </div>
          </section>
        )}

        {isMobile && segmentControl}
        {isMobile && viewControl}
      </div>

      {!isMobile && bulkModeEnabled && activeGridDeptId && (
        <section className="ts-bulk-bar">
          {viewMode === 'objects' ? (
            <>
              <div className="ts-bulk-info">
                <div className="ts-bulk-title">Массовая корректировка по объектам</div>
                <div className="ts-bulk-hint">
                  Зажмите левую кнопку мыши и протяните по табелю объектов нужный диапазон. Для строк
                  {' '}
                  `Не определён / без объекта`
                  {' '}
                  оставлена точечная корректировка. {bulkSelectionSummary}
                </div>
              </div>
              <div className="ts-bulk-actions">
                <button
                  type="button"
                  className="ts-btn"
                  onClick={() => setBulkSelectedCellKeys(new Set())}
                  disabled={bulkSelectedCellKeys.size === 0}
                >
                  Сбросить
                </button>
                <button
                  type="button"
                  className="ts-btn ts-btn--primary"
                  onClick={handleOpenBulkModal}
                  disabled={bulkObjectTargets.length === 0}
                >
                  Внести корректировку
                </button>
                <button
                  type="button"
                  className="ts-btn"
                  onClick={clearBulkState}
                >
                  Выйти из режима
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="ts-bulk-info">
                <div className="ts-bulk-title">
                  {isObjectBulkOperation ? 'Массовая корректировка по объектам' : 'Массовая корректировка'}
                </div>
                <div className="ts-bulk-hint">
                  Зажмите левую кнопку мыши и протяните по таблице нужный диапазон. Новая протяжка добавит дни к уже выбранным. Раскройте объекты у сотрудника с несколькими объектами, чтобы массово править часы по конкретному объекту. {bulkSelectionSummary}
                </div>
              </div>
              <div className="ts-bulk-actions">
                <button
                  type="button"
                  className="ts-btn"
                  onClick={() => setBulkSelectedCellKeys(new Set())}
                  disabled={bulkSelectedCellKeys.size === 0}
                >
                  Сбросить
                </button>
                <button
                  type="button"
                  className="ts-btn ts-btn--primary"
                  onClick={handleOpenBulkModal}
                  disabled={bulkTargets.length === 0 && bulkObjectTargets.length === 0}
                >
                  Внести корректировку
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {viewMode === 'transfers' ? (
        <div className="ts-table-container">
          <TimesheetTransfersTab
            key={effectiveSelectedDeptId ?? activeGridDeptId ?? 'none'}
            departmentId={effectiveSelectedDeptId ?? activeGridDeptId ?? null}
            departmentName={selectedDeptName}
          />
        </div>
      ) : viewMode === 'corrections' ? (
        <div className="ts-table-container">
          <TimesheetCorrectionsList
            startDate={rangeStart}
            endDate={rangeEnd}
            departmentId={effectiveSelectedDeptId ?? null}
            employees={employees}
          />
        </div>
      ) : isAssignedMode ? (
        !selectedAssigneeId ? (
          <div className="ts-table-container">
            <div className="ts-loading">Выберите назначенного сотрудника</div>
          </div>
        ) : !selectedAssignee ? (
          <div className="ts-table-container">
            <div className="ts-loading">Загрузка...</div>
          </div>
        ) : assigneeBrigades.length === 0 ? (
          <div className="ts-table-container">
            <div className="ts-loading">У сотрудника нет доступных отделов</div>
          </div>
        ) : !assignedExpandedDeptId ? (
          <div className="ts-table-container">
            <div className="ts-loading">Выберите бригаду</div>
          </div>
        ) : timesheetQuery.isLoading ? (
          <div className="ts-table-container">
            <div className="ts-loading">Загрузка табеля...</div>
          </div>
        ) : (
          <TimesheetGrid
            employees={employees}
            entries={entries}
            objectEntries={objectEntries}
            employeeStats={employeeStats}
            year={year}
            month={month}
            viewMode={viewMode}
            schedules={schedules}
            dailySchedules={dailySchedules}
            calendar={calendar}
            compact={isMobile}
            bulkEditMode={bulkModeEnabled}
            visibleDays={visibleDays}
            selectedCellKeys={bulkSelectedCellKeys}
            splitDayKeys={splitDayKeys}
            canManageTeam={canManageTeam}
            pendingEmployeeId={teamPendingEmployeeId}
            onBulkSelectionChange={handleBulkSelectionChange}
            onBulkBlockedSelectionAttempt={handleBulkBlockedSelectionAttempt}
            onEmployeeClick={handleEmployeeClick}
            onExcludeEmployee={handleExcludeEmployeeFromDepartment}
            onDayClick={handleDayClick}
            onObjectDayClick={handleObjectDayClick}
          />
        )
      ) : loading ? (
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
          objectEntries={objectEntries}
          employeeStats={employeeStats}
          year={year}
          month={month}
          viewMode={viewMode}
          schedules={schedules}
          dailySchedules={dailySchedules}
          calendar={calendar}
          compact={isMobile}
          bulkEditMode={bulkModeEnabled}
          visibleDays={visibleDays}
          selectedCellKeys={bulkSelectedCellKeys}
          splitDayKeys={splitDayKeys}
          canManageTeam={canManageTeam}
          pendingEmployeeId={teamPendingEmployeeId}
          onBulkSelectionChange={handleBulkSelectionChange}
          onBulkBlockedSelectionAttempt={handleBulkBlockedSelectionAttempt}
          onEmployeeClick={handleEmployeeClick}
          onExcludeEmployee={handleExcludeEmployeeFromDepartment}
          onDayClick={handleDayClick}
          onObjectDayClick={handleObjectDayClick}
        />
      )}

      {teamManagementOpen && (
        <TimesheetTeamManagementModal
          open={teamManagementOpen}
          onClose={closeTeamManagement}
          departmentName={selectedDeptName}
          defaultEffectiveFrom={getTodayDateInputValue()}
          searchQuery={teamSearch}
          searchLoading={teamSearchQuery.isFetching}
          searchResults={teamSearchResults}
          pendingEmployeeId={teamPendingEmployeeId}
          onSearchQueryChange={setTeamSearch}
          onAddEmployee={handleAddEmployeeToDepartment}
        />
      )}

      <TimesheetExcludeEmployeeModal
        open={!!excludeModalEmployee}
        employee={excludeModalEmployee}
        pending={teamPendingEmployeeId === excludeModalEmployee?.id}
        onClose={() => setExcludeModalEmployee(null)}
        onConfirm={handleConfirmExclude}
      />

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

      {modalOpen && (
        <Suspense fallback={null}>
          <TimesheetCorrectionModal
            open={modalOpen}
            onClose={closeModal}
            onSave={handleSaveModalCorrection}
            onDelete={
              modalMode === 'object' && modalObjectEntry?.adjustment_id
                ? handleDeleteObjectCorrection
                : (modalMode === 'day' && modalEntry?.is_correction && modalEntry?.id)
                  ? handleDeleteDayCorrection
                  : undefined
            }
            initialStatus={
              modalMode === 'object' && modalObjectEntry?.adjustment_id
                ? 'manual'
                : (modalEntry?.status || 'work')
            }
            initialHours={modalDefaultHours}
            initialNotes={modalMode === 'object' ? (modalObjectEntry?.notes ?? '') : (modalEntry?.notes ?? '')}
            dayLabel={`${formatDateRu(modalDay, month)}`}
            title={modalMode === 'object' ? modalObjectTarget?.object_name : undefined}
            subtitle={modalMode === 'object' ? `${modalEmployee?.full_name || ''} • ${formatDateRu(modalDay, month)}` : undefined}
            employeeName={modalMode === 'object' ? undefined : modalEmployee?.full_name}
            employeeId={modalEmployee?.id}
            workDate={modalWorkDate}
            allowAccessPointMap={canViewPage('/skud-settings')}
            deleteLabel={modalMode === 'object' ? 'Снять корректировку' : undefined}
            timesheetEntry={modalEntry}
            maxHours={modalMaxHours}
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
            title={isObjectBulkOperation ? 'Массовая корректировка по объектам' : 'Массовая корректировка'}
            subtitle={bulkSelectionSummary}
            confirmLabel={isObjectBulkOperation ? 'Применить по объектам' : 'Применить'}
            hideSkudTab
            maxHours={bulkMaxHours}
            allowedStatuses={isObjectBulkOperation ? ['manual'] : undefined}
          />
        </Suspense>
      )}

      {travelExceptionTarget && (
        <Suspense fallback={null}>
          <TravelExceptionModal
            open={!!travelExceptionTarget}
            onClose={() => setTravelExceptionTarget(null)}
            employeeId={travelExceptionTarget.employeeId}
            employeeName={travelExceptionTarget.employeeName}
            workDate={travelExceptionTarget.workDate}
          />
        </Suspense>
      )}
    </div>
  );
};
