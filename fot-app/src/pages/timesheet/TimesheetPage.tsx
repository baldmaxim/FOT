import { type FC, Suspense, lazy, useState, useEffect, useCallback, useMemo, useRef, useDeferredValue } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, ChevronLeft, ChevronRight, ChevronDown, Download, RefreshCw, UserPlus, Mail } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { TimesheetGrid } from '../../components/timesheet/TimesheetGrid';
import { TimesheetCorrectionsList } from '../../components/timesheet/TimesheetCorrectionsList';
import { TimesheetTeamManagementModal } from '../../components/timesheet/TimesheetTeamManagementModal';
import { TimesheetTransfersTab } from '../../components/timesheet/TimesheetTransfersTab';
import { TimesheetExcludeEmployeeModal } from '../../components/timesheet/TimesheetExcludeEmployeeModal';
import { timesheetService } from '../../services/timesheetService';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { useAssignedEmployees } from '../../hooks/useAssignedEmployees';
import { formatTimesheetEmployeeName } from '../../utils/timesheetDisplay';
import { getMonthLabel, formatDateRu, getDaysInMonth } from '../../utils/calendarUtils';
import { useTimesheetMonthAccess } from '../../hooks/useTimesheetMonthAccess';
import type {
  TimesheetEntry,
  TimesheetEmployee,
  TimesheetObjectEntry,
  TimesheetStats as ITimesheetStats,
  TimesheetStatus,
  TimesheetTeamManagementCandidate,
} from '../../types';
import type { TimesheetResponse, ITimesheetDepartmentApprovalSummary } from '../../types/timesheet';
import type { IResolvedSchedule } from '../../types/schedule';
import { TimesheetApprovalBar } from '../../components/timesheet/TimesheetApprovalBar';
import { STATUS_COLORS, STATUS_ICONS } from '../../components/timesheet/timesheetApprovalStatus';
import type {
  ISubmitProblemEmployee,
  ISubmitProblemDay,
} from '../../components/timesheet/TimesheetSubmitConfirmModal';
import { APPROVAL_STATUS_LABELS } from '../../services/timesheetApprovalService';
import {
  useTimesheetApprovalStatus,
  useTimesheetDepartmentApprovals,
} from '../../hooks/useTimesheetApprovalData';
import { getDayStatus, STATUS_LABEL_RU } from '../../utils/dayStatus';
import {
  getFullDayThresholdHoursForDay,
  getScheduleForTimesheetDay,
  getWorkHoursForDay,
  isPreHolidayForSchedule,
  isScheduleDayOff,
} from '../../utils/scheduleUtils';
import { selectVisibleHours, selectVisibleObjectHours } from '../../utils/hoursDisplay';
import { useIsMobile } from '../../hooks/useIsMobile';
import {
  getHalfRange,
  formatHalfLabel,
  formatTimesheetRangeLabel,
  getHalfFromDate,
  getCurrentHalf,
  type TimesheetHalf,
} from '../../utils/timesheetApprovalPeriod';
import { useManagedDepartments } from '../../hooks/useManagedDepartments';
import { findDepartmentName, filterDepartmentTreeByIds } from '../../utils/departmentUtils';
import { DepartmentTreeSelect } from '../../components/staff/DepartmentTreeSelect';
import { useHeaderAddon } from '../../components/layout/HeaderAddonContext';
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
  type IBulkCorrectionTarget,
  type IBulkObjectCorrectionTarget,
  type IObjectModalTarget,
  type TimesheetViewMode,
} from './timesheetPage.helpers';

// Псевдо-id отдела для руководителя без managed-отделов (только employee_direct_reports):
// активирует timesheet-запрос без department_id; бэк сам резолвит direct_reports по токену.
const DIRECT_REPORTS_DEPT = '__direct_reports__';

export const TimesheetPage: FC = () => {
  const { hasPermission, profile, canEditPage, canViewPage, showActualHours } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const isAdmin = profile?.is_admin === true;
  const isManagerObj = profile?.role_code === 'manager_obj';
  const showFullPeriod = profile?.timesheet_show_full_period !== false;
  const canEditTimesheet = canEditPage('/timesheet') || canEditPage('/timesheet-hr');
  const canViewManagedTimesheet = canEditTimesheet || canViewPage('/timesheet') || canViewPage('/timesheet-hr');
  const canEditTeamManagement = isAdmin || canEditPage('timesheet-team-management');
  const canManageAllDepartments = isAdmin || hasPermission('data.scope.all');
  const {
    isDepartmentScope,
    isDirectReportsOnly,
    managedDepartmentIds,
    primaryDepartmentId,
    structureQuery,
  } = useManagedDepartments();
  const monthAccess = useTimesheetMonthAccess({
    enforceWhen: isDepartmentScope && canViewManagedTimesheet,
  });
  const isTimesheetDepartmentScope = monthAccess.isWindowEnforced;
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
  const minAllowedMonthIndex = currentMonthIndex - monthAccess.monthsBack;
  const maxAllowedMonthIndex = currentMonthIndex + monthAccess.monthsForward;
  const isRestrictedManagerView = isTimesheetDepartmentScope;
  const requestedMonth = useMemo(() => parseMonthParam(queryMonth), [queryMonth]);
  const requestedMonthIndex = requestedMonth
    ? toMonthIndex(requestedMonth.year, requestedMonth.month)
    : currentMonthIndex;
  const resolvedMonthIndex = isRestrictedManagerView
    ? Math.min(maxAllowedMonthIndex, Math.max(minAllowedMonthIndex, requestedMonthIndex))
    : requestedMonthIndex;
  const { year, month } = useMemo(() => fromMonthIndex(resolvedMonthIndex), [resolvedMonthIndex]);

  const isMobile = useIsMobile(768);
  const [mobileApprovalOpen, setMobileApprovalOpen] = useState(false);
  const mobileApprovalVisible = isMobile && mobileApprovalOpen;

  // Schedule settings panel

  // Department selector
  const [selectedDeptId, setSelectedDeptId] = useState<string | null>(null);

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

  const deptTree = useMemo(() => {
    const allNodes = structureQuery.data?.departments ?? [];
    if (isDepartmentScope) {
      return filterDepartmentTreeByIds(allNodes, new Set(managedDepartmentIds));
    }
    return allNodes;
  }, [structureQuery.data, isDepartmentScope, managedDepartmentIds]);
  const effectiveSelectedDeptId = isTimesheetDepartmentScope
    ? (selectedDeptId || primaryDepartmentId || null)
    : selectedDeptId;
  const viewMode: TimesheetViewMode = queryView === 'objects'
    ? 'objects'
    : queryView === 'corrections'
      ? 'corrections'
      : (queryView === 'transfers' && isAdmin && timesheetMode !== 'assigned')
        ? 'transfers'
        : 'employees';

  // Запоминаем последний «сеточный» вид (по сотрудникам/по объектам), чтобы кнопка
  // «Корректировки» работала переключателем: повторный клик возвращает сюда (#10).
  const prevGridViewRef = useRef<'employees' | 'objects'>('employees');
  useEffect(() => {
    if (viewMode === 'employees' || viewMode === 'objects') {
      prevGridViewRef.current = viewMode;
    }
  }, [viewMode]);

  useEffect(() => {
    if (!isMultiDepartmentManager) return;
    if (effectiveSelectedDeptId && managedDepartmentIds.includes(effectiveSelectedDeptId)) return;
    setSelectedDeptId(primaryDepartmentId || managedDepartmentIds[0] || null);
  }, [effectiveSelectedDeptId, isMultiDepartmentManager, managedDepartmentIds, primaryDepartmentId]);

  useEffect(() => {
    if (timesheetMode !== 'department') return;
    if (!queryAssignedDept) return;
    if (selectedDeptId === queryAssignedDept) return;
    const hasAccess = canManageAllDepartments
      || managedDepartmentIds.includes(queryAssignedDept);
    if (hasAccess) {
      setSelectedDeptId(queryAssignedDept);
    }
  }, [queryAssignedDept, timesheetMode, canManageAllDepartments, managedDepartmentIds, selectedDeptId]);

  // Close dept/assignee/brigade dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
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
    const raw: TimesheetHalf = (() => {
      if (queryHalf === 'H1' || queryHalf === 'H2' || queryHalf === 'FULL') return queryHalf;
      if (queryFrom) return getHalfFromDate(queryFrom);
      const current = getCurrentHalf(now);
      return (current.year === year && current.month === month) ? current.half : 'H1';
    })();
    return (!showFullPeriod && raw === 'FULL') ? 'H1' : raw;
  }, [queryHalf, queryFrom, now, year, month, showFullPeriod]);
  const activeRange = useMemo(() => getHalfRange(year, month, selectedHalf), [year, month, selectedHalf]);
  const rangeStart = activeRange.startDate;
  const rangeEnd = activeRange.endDate;
  const activeGridDeptId = timesheetMode === 'assigned'
    ? assignedExpandedDeptId
    : (effectiveSelectedDeptId || (isDirectReportsOnly && !selectedDeptId ? DIRECT_REPORTS_DEPT : null));
  const isDirectReportsMarker = activeGridDeptId === DIRECT_REPORTS_DEPT;
  // Режим подачи: руководитель «по людям» подаёт персонально (своих подчинённых,
  // department_id=null); остальные — по отделу сетки.
  const approvalSubmissionMode: 'department' | 'personal' = isDirectReportsMarker ? 'personal' : 'department';
  const approvalBarDeptId = isDirectReportsMarker ? null : activeGridDeptId;
  // Объектные детали нужны в обоих режимах: «по объектам» — для группировки строк,
  // «по сотрудникам» — для per-object корректировок в дневной модалке.
  const includeObjectDetails = true;
  const timesheetQuery = useQuery({
    queryKey: ['timesheet-page', monthStr, rangeStart, rangeEnd, activeGridDeptId ?? 'none', 'with-objects'],
    queryFn: () => timesheetService.getAll({
      month: monthStr,
      department_id: (activeGridDeptId && !isDirectReportsMarker) ? activeGridDeptId : undefined,
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
  const employees = useMemo<TimesheetEmployee[]>(() => {
    const raw = timesheetQuery.data?.employees || [];
    // Группировка строк табеля: department → direct_report → self.
    // Внутри группы сохраняем порядок ответа (бэк сортирует по full_name).
    const sourceOrder: Record<NonNullable<TimesheetEmployee['source']>, number> = {
      self: 0,
      direct_report: 1,
      department: 2,
    };
    return [...raw].sort((a, b) => sourceOrder[a.source ?? 'department'] - sourceOrder[b.source ?? 'department']);
  }, [timesheetQuery.data]);
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
  const loading = (Boolean(effectiveSelectedDeptId) || isDirectReportsOnly) && timesheetQuery.isLoading;
  const deferredTeamSearch = useDeferredValue(teamSearch.trim());
  const teamSearchQuery = useQuery({
    queryKey: ['timesheet-team-search', activeGridDeptId ?? 'none', deferredTeamSearch],
    queryFn: () => timesheetService.searchTeamEmployees({
      department_id: activeGridDeptId as string,
      q: deferredTeamSearch,
    }),
    enabled: teamManagementOpen && Boolean(activeGridDeptId) && !isDirectReportsMarker && deferredTeamSearch.length >= 2,
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
  const lockedDateStatus = useMemo(() => {
    const data = timesheetQuery.data as TimesheetResponse | undefined;
    const dates = Array.isArray(data?.approval_locked_dates) ? data.approval_locked_dates : [];
    const approvals = Array.isArray(data?.approvals) ? data.approvals : [];
    const statusPriority: Record<ITimesheetDepartmentApprovalSummary['status'], number> = {
      approved: 3, submitted: 2, returned: 1, rejected: 0, draft: 0,
    };
    const map = new Map<string, ITimesheetDepartmentApprovalSummary['status']>();
    for (const date of dates) {
      let best: ITimesheetDepartmentApprovalSummary['status'] | null = null;
      for (const a of approvals) {
        if (a.start_date <= date && a.end_date >= date) {
          if (!best || statusPriority[a.status] > statusPriority[best]) best = a.status;
        }
      }
      map.set(date, best ?? 'submitted');
    }
    return map;
  }, [timesheetQuery.data]);
  const lockedDateSet = lockedDateStatus;
  const lockMessage = (status: ITimesheetDepartmentApprovalSummary['status'] | undefined): string => {
    if (status === 'approved') return 'Период согласован — редактирование закрыто';
    if (status === 'returned') return 'Период возвращён на доработку — редактирование закрыто';
    return 'Период подан — редактирование закрыто';
  };
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
  const canManageTeam = Boolean(activeGridDeptId && !isDirectReportsMarker && canEditTeamManagement);
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
  const canGoPrevMonth = !isRestrictedManagerView || resolvedMonthIndex > minAllowedMonthIndex;
  const canGoNextMonth = !isRestrictedManagerView || resolvedMonthIndex < maxAllowedMonthIndex;

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
      toast.info?.(lockMessage(lockedDateSet.get(workDate)));
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
      toast.info?.(lockMessage(lockedDateSet.get(workDate)));
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
        closeModal();
      } else {
        const created = await timesheetService.create({
          employee_id: modalEmployee.id,
          work_date: workDate,
          status,
          hours_worked: hours,
          notes,
        });
        // #1: после ДОБАВЛЕНИЯ не закрываем модалку, а подставляем созданную
        // корректировку — чтобы сразу появилась панель «Файлы» с кнопкой
        // «Прикрепить» (файл цепляется к adjustment_id, который есть только теперь).
        setModalMode('day');
        setModalObjectEntry(null);
        setModalObjectTarget(null);
        setModalEntry(created);
      }
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

  // Сохранение/удаление per-object из «День»-модалки (modalMode='day'): таргет приходит из аргументов,
  // а не из modalObjectTarget — позволяет редактировать любой объект в списке.
  const handleSaveObjectByTarget = useCallback(async (
    target: { object_key: string; object_id: string | null; object_name: string },
    hours: number,
    notes: string,
  ) => {
    if (!modalEmployee) return;
    try {
      const workDate = `${year}-${String(month).padStart(2, '0')}-${String(modalDay).padStart(2, '0')}`;
      await timesheetService.upsertObjectEntry({
        employee_id: modalEmployee.id,
        work_date: workDate,
        object_key: target.object_key,
        object_id: target.object_id,
        object_name: target.object_name,
        hours_worked: hours,
        notes,
      });
      closeModal();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['timesheet-page', monthStr, rangeStart, rangeEnd, activeGridDeptId ?? 'none'] }),
        queryClient.invalidateQueries({ queryKey: ['timesheet-corrections'] }),
      ]);
    } catch (error) {
      console.error('Save object correction (by target) error:', error);
      toast.error(error instanceof Error ? error.message : 'Не удалось сохранить корректировку по объекту');
    }
  }, [modalEmployee, year, month, modalDay, closeModal, queryClient, monthStr, rangeStart, rangeEnd, activeGridDeptId, toast]);

  const handleDeleteObjectByTarget = useCallback(async (
    target: { object_key: string; object_id: string | null; object_name: string },
  ) => {
    if (!modalEmployee) return;
    try {
      const workDate = `${year}-${String(month).padStart(2, '0')}-${String(modalDay).padStart(2, '0')}`;
      await timesheetService.deleteObjectEntry({
        employee_id: modalEmployee.id,
        work_date: workDate,
        object_key: target.object_key,
      });
      closeModal();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['timesheet-page', monthStr, rangeStart, rangeEnd, activeGridDeptId ?? 'none'] }),
        queryClient.invalidateQueries({ queryKey: ['timesheet-corrections'] }),
      ]);
    } catch (error) {
      console.error('Delete object correction (by target) error:', error);
      toast.error(error instanceof Error ? error.message : 'Не удалось снять корректировку по объекту');
    }
  }, [modalEmployee, year, month, modalDay, closeModal, queryClient, monthStr, rangeStart, rangeEnd, activeGridDeptId, toast]);

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

  const assigneeDeptName = activeGridDeptId && selectedAssigneeId
    ? assigneesQuery.data?.find(emp => emp.id === selectedAssigneeId)?.departments?.find(d => d.id === activeGridDeptId)?.name
    : undefined;
  const selectedDeptName = isDirectReportsMarker
    ? 'Мои сотрудники'
    : activeGridDeptId
      ? findDepartmentName(deptTree, activeGridDeptId)
        || assigneeDeptName
        || 'Отдел'
      : 'Все отделы';
  const teamSearchResults = teamSearchQuery.data || [];
  const openTeamManagement = useCallback(() => {
    if (!canUseTeamManagement || !activeGridDeptId || isDirectReportsMarker) return;
    setPanelOpen(false);
    setModalOpen(false);
    clearBulkState();
    setTeamSearch('');
    setTeamManagementOpen(true);
  }, [canUseTeamManagement, activeGridDeptId, isDirectReportsMarker, clearBulkState]);

  const closeTeamManagement = useCallback(() => {
    setTeamManagementOpen(false);
    setTeamSearch('');
    setTeamPendingEmployeeId(null);
  }, []);

  const handleAddEmployeeToDepartment = useCallback(async (
    candidate: TimesheetTeamManagementCandidate,
    effectiveFrom: string,
  ) => {
    if (!activeGridDeptId || isDirectReportsMarker) return;
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
  }, [rangeStart, rangeEnd, activeGridDeptId, isDirectReportsMarker, monthStr, queryClient, selectedDeptName, toast, closeTeamManagement]);

  const [excludeModalEmployee, setExcludeModalEmployee] = useState<TimesheetEmployee | null>(null);

  const handleExcludeEmployeeFromDepartment = useCallback((employee: TimesheetEmployee) => {
    if (!activeGridDeptId || isDirectReportsMarker) return;
    setExcludeModalEmployee(employee);
  }, [activeGridDeptId, isDirectReportsMarker]);

  const handleConfirmExclude = useCallback(async (effectiveDate: string) => {
    if (!excludeModalEmployee || !activeGridDeptId || isDirectReportsMarker) return;
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
  }, [excludeModalEmployee, rangeStart, rangeEnd, activeGridDeptId, isDirectReportsMarker, monthStr, panelEmployee?.id, queryClient, toast]);

  const modalDefaultHours = useMemo(() => {
    // Дефолт поля «Часы» в форме корректировки уважает per-role флаг
    // show_actual_hours: для роли с факт-часами (admin) — берём hours_worked,
    // для остальных — display_hours_worked. Иначе админ видит в табеле 14ч,
    // открывает модалку и в форме оказывается 9ч.
    if (modalMode === 'object') {
      const v = selectVisibleObjectHours(modalObjectEntry ?? null, showActualHours);
      if (v > 0) return v;
      return modalObjectEntry?.base_hours_worked ?? 0;
    }
    const v = selectVisibleHours(modalEntry ?? null, showActualHours);
    if (v != null) return v;
    if (!modalEmployee) return 8;
    const sched = getScheduleForTimesheetDay(schedules, dailySchedules, modalEmployee.id, year, month, modalDay);
    return getWorkHoursForDay(sched, year, month, modalDay);
  }, [modalMode, modalObjectEntry, modalEntry, modalEmployee, schedules, dailySchedules, year, month, modalDay, showActualHours]);

  // Корректировки могут превышать длительность смены по графику — лимит снят.
  const modalMaxHours = null;

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

  // Массовые корректировки тоже не ограничены графиком.
  const bulkMaxHours = null;

  const handleOpenBulkModal = useCallback(() => {
    if (viewMode === 'employees' && bulkTargets.length > 0 && bulkObjectTargets.length > 0) {
      toast.info('Сначала примените или сбросьте выделение одного типа: либо по сотрудникам, либо по объектам.');
      return;
    }
    if (isObjectBulkOperation) {
      if (bulkObjectTargets.length === 0) {
        toast.info('Выделите диапазон ячеек по объектам.');
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

  // Кнопка «Корректировки» — переключатель: из corrections возвращает в исходный
  // «сеточный» вид, иначе открывает corrections (#10).
  const handleCorrectionsChipClick = useCallback(() => {
    handleViewModeChange(viewMode === 'corrections' ? prevGridViewRef.current : 'corrections');
  }, [viewMode, handleViewModeChange]);

  const handleTimesheetModeChange = useCallback((nextMode: 'department' | 'assigned') => {
    clearBulkState();
    closeTeamManagement();
    setPanelOpen(false);
    setModalOpen(false);
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
    setRefreshState({ phase: 'syncing', message: 'Пересчёт табеля…' });

    const controller = new AbortController();
    const timeoutMs = 30_000;
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

    try {
      const result = await timesheetService.refresh(
        { start_date: rangeStart, end_date: rangeEnd },
        { signal: controller.signal },
      );
      setRefreshState({ phase: 'invalidating', message: 'Обновление данных табеля…' });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['timesheet-page', monthStr, rangeStart, rangeEnd, activeGridDeptId ?? 'none'] }),
        queryClient.invalidateQueries({ queryKey: ['timesheet-corrections'] }),
        queryClient.invalidateQueries({ queryKey: ['schedules'] }),
        queryClient.invalidateQueries({ queryKey: ['timesheet-approval'] }),
        queryClient.invalidateQueries({ queryKey: ['employee-timesheet'] }),
      ]);
      const parts: string[] = [];
      if (result.reapproved > 0) parts.push(`согласований: ${result.reapproved}`);
      if (result.conflicts.length > 0) parts.push(`коллизий: ${result.conflicts.length}`);
      toast.success?.(parts.length > 0 ? `Табель обновлён (${parts.join(', ')})` : 'Табель обновлён');
      setRefreshState({ phase: 'idle', message: '' });
    } catch (err) {
      const aborted = (err as { name?: string } | null)?.name === 'AbortError' || controller.signal.aborted;
      if (aborted) {
        const seconds = Math.round(timeoutMs / 1000);
        toast.error?.(`Сервер не ответил за ${seconds} секунд, повторите попытку`);
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
    <div className="ts-dept-wrap">
      {(isSingleDeptManager || isDirectReportsOnly) ? (
        <button type="button" className="ts-dept-btn" style={{ cursor: 'default', opacity: 0.8 }}>
          {selectedDeptName}
        </button>
      ) : (
        <DepartmentTreeSelect
          departments={deptTree}
          value={selectedDeptId ?? ''}
          onChange={id => {
            clearBulkState();
            closeTeamManagement();
            setSelectedDeptId(id || null);
          }}
          showAllOption={!isTimesheetDepartmentScope}
          isLoading={structureQuery.isPending}
          isError={structureQuery.isError}
          onRetry={() => { void structureQuery.refetch(); }}
        />
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

  // Проблемные сотрудники/дни для модалки подтверждения подачи.
  // Только прошлые рабочие дни по графику: incomplete_skud («СКУД без часов»)
  // и полностью незаполненные дни. Недоработки по графику и явные неявки исключены.
  const submitProblems = useMemo<ISubmitProblemEmployee[]>(() => {
    if (isAssignedMode || !activeGridDeptId || isDirectReportsMarker) return [];
    const todayIso = new Date().toISOString().slice(0, 10);
    const dates: string[] = [];
    const start = new Date(`${rangeStart}T00:00:00`);
    const end = new Date(`${rangeEnd}T00:00:00`);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (iso < todayIso) dates.push(iso);
    }
    if (dates.length === 0) return [];
    const result: ISubmitProblemEmployee[] = [];
    for (const emp of employees) {
      const a = emp.transferred_out_date ?? null;
      const b = emp.excluded_from_timesheet_date ?? null;
      const cutoff = a && b ? (a < b ? a : b) : (a || b || null);
      const days: ISubmitProblemDay[] = [];
      for (const iso of dates) {
        if (cutoff && iso >= cutoff) continue;
        const [y, m, dd] = iso.split('-').map(Number);
        const sched = getScheduleForTimesheetDay(schedules, dailySchedules, emp.id, y, m, dd);
        if (isScheduleDayOff(sched, calendar, y, m, dd)) continue;
        const entry = entryMap.get(`${emp.id}_${iso}`) ?? null;
        if (!entry) {
          days.push({ date: iso, reason: 'Не заполнен' });
          continue;
        }
        const threshold = getFullDayThresholdHoursForDay(sched, calendar, y, m, dd);
        const dayStatus = getDayStatus(entry, {
          showActualHours,
          fullDayThresholdHours: threshold,
          isScheduledDayOff: false,
        });
        if (dayStatus === 'incomplete_skud') {
          days.push({ date: iso, reason: STATUS_LABEL_RU.incomplete_skud });
        }
      }
      if (days.length > 0) {
        result.push({ employeeId: emp.id, employeeName: emp.full_name, days });
      }
    }
    return result;
  }, [
    isAssignedMode, activeGridDeptId, isDirectReportsMarker, rangeStart, rangeEnd,
    employees, schedules, dailySchedules, calendar, entryMap, showActualHours,
  ]);

  const headerApprovalDeptId = !isAssignedMode ? approvalBarDeptId : null;
  const headerApprovalMode = !isAssignedMode ? approvalSubmissionMode : 'department';
  const headerApproval = useTimesheetApprovalStatus(headerApprovalMode, headerApprovalDeptId, rangeStart, rangeEnd);
  const headerApprovalStatus = headerApproval.data?.status ?? null;
  const headerMonth = `${year}-${String(month).padStart(2, '0')}`;
  const headerMonthApprovals = useTimesheetDepartmentApprovals(headerApprovalMode, headerApprovalDeptId, headerMonth);

  const headerEmployeeCounter = useMemo(() => {
    if (isAssignedMode) return null;
    if (!effectiveSelectedDeptId) return null;
    const showCounter = Boolean(stats.employeeCount);
    const activeApproval = headerApproval.data ?? null;
    const otherApprovals = (headerMonthApprovals.data ?? []).filter(
      a => !activeApproval || a.id !== activeApproval.id,
    );
    if (!showCounter && !headerApprovalStatus && otherApprovals.length === 0) return null;
    const StatusIcon = headerApprovalStatus ? STATUS_ICONS[headerApprovalStatus] : null;
    return (
      <span className="ts-header-addon">
        {showCounter && (
          <span className="ts-header-counter">
            {stats.employeeCount} <span className="ts-header-counter-label">сотр.</span>
          </span>
        )}
        {headerApprovalStatus && StatusIcon && (
          <span
            className="ts-header-approval-chip"
            style={{ color: STATUS_COLORS[headerApprovalStatus] }}
            title="Статус согласования табеля"
          >
            <StatusIcon size={13} /> {APPROVAL_STATUS_LABELS[headerApprovalStatus]}
          </span>
        )}
        {otherApprovals.map(a => {
          const OtherIcon = STATUS_ICONS[a.status];
          return (
            <span
              key={a.id}
              className="ts-header-other-chip"
              style={{ color: STATUS_COLORS[a.status] }}
              title="Согласование другого периода месяца"
            >
              {formatTimesheetRangeLabel(a.start_date, a.end_date)}{' '}
              <OtherIcon size={13} /> {APPROVAL_STATUS_LABELS[a.status]}
            </span>
          );
        })}
      </span>
    );
  }, [
    isAssignedMode, effectiveSelectedDeptId, stats.employeeCount,
    headerApprovalStatus, headerApproval.data, headerMonthApprovals.data,
  ]);
  useHeaderAddon(headerEmployeeCounter);

  const hasActiveScope = isAssignedMode ? selectedAssigneeId : activeGridDeptId;
  const segmentControl = hasActiveScope ? (
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
      {showFullPeriod && (
        <button
          type="button"
          className={`ts-half-chip ${selectedHalf === 'FULL' ? 'ts-half-chip--active' : ''}`}
          onClick={() => handleHalfChange('FULL')}
        >
          {formatHalfLabel(year, month, 'FULL')}
        </button>
      )}
    </section>
  ) : null;

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
        onClick={handleCorrectionsChipClick}
      >
        Корректировки
      </button>
      {isAdmin && !isAssignedMode && (
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
      onClick={handleCorrectionsChipClick}
    >
      Корректировки
    </button>
  ) : null;

  const transfersChip = hasActiveScope && isAdmin && !isAssignedMode ? (
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
            {mobileApprovalVisible && !isAssignedMode && (
              <div className="ts-mobile-approval-panel">
                <TimesheetApprovalBar
                  submissionMode={approvalSubmissionMode}
                  departmentId={approvalBarDeptId}
                  startDate={rangeStart}
                  endDate={rangeEnd}
                  compact
                  allowReview={false}
                  submitProblems={submitProblems}
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
                  submissionMode={approvalSubmissionMode}
                  departmentId={approvalBarDeptId}
                  startDate={rangeStart}
                  endDate={rangeEnd}
                  allowReview={false}
                  submitProblems={submitProblems}
                />
              </div>
            </div>

            <div className="ts-header-toolbar">
              <div className="ts-header-toolbar-left">
                {viewControlPrimary}
              </div>
              <div className="ts-header-toolbar-right">
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
                  onClick={() => handleRefreshTimesheet()}
                  disabled={refreshInFlight || !rangeStart || !rangeEnd}
                  title="Пересчитать табель по текущему графику и пришедшим проходам"
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
                {activeGridDeptId && (viewMode === 'employees' || viewMode === 'objects') && (
                  <button
                    type="button"
                    className={`ts-btn ts-btn--chip ts-btn--bulk-toggle${bulkModeEnabled ? ' ts-btn--active' : ''}`}
                    onClick={handleBulkModeToggle}
                  >
                    Режим корректировок
                  </button>
                )}
                {correctionsChip}
                {transfersChip}
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
                  Зажмите левую кнопку мыши и протяните по табелю объектов нужный диапазон. {bulkSelectionSummary}
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
                {isManagerObj && (
                  <div className="ts-bulk-hint ts-bulk-hint--memo">
                    Выходные/праздничные дни со статусом «работа» автоматически попадут в служебную записку — доступна в кнопке «Подать ▾».
                  </div>
                )}
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
            approvalStatusByDate={lockedDateStatus}
            canManageTeam={canManageTeam}
            pendingEmployeeId={teamPendingEmployeeId}
            departmentName={selectedDeptName}
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
      ) : (!effectiveSelectedDeptId && !isDirectReportsOnly) ? (
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
          approvalStatusByDate={lockedDateStatus}
          canManageTeam={canManageTeam}
          pendingEmployeeId={teamPendingEmployeeId}
          departmentName={selectedDeptName}
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
                : (modalEntry?.is_correction
                    && modalEntry?.id != null
                    && !modalEntry?.has_object_adjustments)
                  // Дневную корректировку (удалёнка/отпуск/корр. табеля без объектов) можно
                  // удалить из ЛЮБОГО режима — раньше требовался modalMode==='day', поэтому
                  // при открытии из «по объектам» была только кнопка-карандаш без корзины (#4).
                  ? handleDeleteDayCorrection
                  : undefined
            }
            infoBanner={null}
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
            hideSkudTab={!canViewPage('/timesheet/events')}
            deleteLabel={modalMode === 'object' ? 'Снять корректировку' : undefined}
            timesheetEntry={modalEntry}
            maxHours={modalMaxHours}
            correctionInfo={
              modalMode === 'object' && modalObjectEntry?.adjustment_id
                ? {
                    is_correction: true,
                    corrected_at: modalEntry?.corrected_at ?? null,
                    corrected_by_name: modalEntry?.corrected_by_name ?? null,
                    approved_at: modalEntry?.approved_at ?? null,
                    approved_by_name: modalEntry?.approved_by_name ?? null,
                    adjustment_id: modalObjectEntry.adjustment_id,
                  }
                : modalEntry?.is_correction
                  ? {
                      is_correction: true,
                      corrected_at: modalEntry.corrected_at,
                      corrected_by_name: modalEntry.corrected_by_name,
                      approval_status: modalEntry.approval_status ?? null,
                      approved_at: modalEntry.approved_at,
                      approved_by_name: modalEntry.approved_by_name,
                      adjustment_id: modalEntry.id,
                    }
                  : null
            }
            preselectedObjectKey={modalMode === 'object' ? modalObjectTarget?.object_key ?? null : null}
            dayStatusContext={modalEmployee && modalDay ? (() => {
              const sched = getScheduleForTimesheetDay(schedules, dailySchedules, modalEmployee.id, year, month, modalDay);
              return {
                isScheduledDayOff: isScheduleDayOff(sched, calendar, year, month, modalDay),
                isPreHoliday: isPreHolidayForSchedule(sched, calendar, year, month, modalDay),
                fullDayThresholdHours: getFullDayThresholdHoursForDay(sched, calendar, year, month, modalDay),
                showActualHours,
              };
            })() : undefined}
            objectEntries={modalEmployee
              ? (objectEntriesByEmployeeDate.get(modalEmployee.id)?.get(modalWorkDate) ?? [])
              : undefined}
            plannedHours={modalEmployee
              ? getWorkHoursForDay(
                  getScheduleForTimesheetDay(schedules, dailySchedules, modalEmployee.id, year, month, modalDay),
                  year, month, modalDay,
                )
              : null}
            hasDayLevelCorrection={Boolean(
              modalEntry?.is_correction && modalEntry?.id != null && !modalEntry?.has_object_adjustments,
            )}
            onSaveObject={handleSaveObjectByTarget}
            onDeleteObject={handleDeleteObjectByTarget}
            onZeroOutDay={(notes) => { void handleSaveCorrection('work', 0, notes).then(() => closeModal()); }}
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
