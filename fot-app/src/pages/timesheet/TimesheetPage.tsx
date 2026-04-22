import { type FC, Suspense, lazy, useState, useEffect, useCallback, useMemo, useRef, useDeferredValue } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, ChevronDown, Download, UserPlus, Mail } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { TimesheetStats } from '../../components/timesheet/TimesheetStats';
import { TimesheetGrid } from '../../components/timesheet/TimesheetGrid';
import { TimesheetTeamManagementModal } from '../../components/timesheet/TimesheetTeamManagementModal';
import { timesheetService } from '../../services/timesheetService';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { useAssignedEmployees } from '../../hooks/useAssignedEmployees';
import { formatTimesheetEmployeeName } from '../../utils/timesheetDisplay';
import { getMonthLabel, formatDateRu, getDaysInMonth } from '../../utils/calendarUtils';
import type {
  ManagedDepartmentTimesheetSummary,
  TimesheetEntry,
  TimesheetEmployee,
  TimesheetObjectEntry,
  TimesheetStats as ITimesheetStats,
  TimesheetStatus,
  TimesheetTeamManagementCandidate,
} from '../../types';
import type { IResolvedSchedule } from '../../types/schedule';
import { TimesheetApprovalBar } from '../../components/timesheet/TimesheetApprovalBar';
import { getScheduleForTimesheetDay, getWorkHoursForDay } from '../../utils/scheduleUtils';
import { useIsMobile } from '../../hooks/useIsMobile';
import { formatTimesheetHalfLabel, type TimesheetApprovalHalf } from '../../utils/timesheetApprovalPeriod';
import { useManagedDepartments } from '../../hooks/useManagedDepartments';
import { type IFlatDepartmentOption, getTreeFlatDepartments, filterDepartmentTreeByIds } from '../../utils/departmentUtils';
import './TimesheetPage.css';

const TimesheetSidePanel = lazy(() => import('../../components/timesheet/TimesheetSidePanel').then(module => ({
  default: module.TimesheetSidePanel,
})));
const TimesheetCorrectionModal = lazy(() => import('../../components/timesheet/TimesheetCorrectionModal').then(module => ({
  default: module.TimesheetCorrectionModal,
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

interface IBulkCorrectionTarget {
  employee: TimesheetEmployee;
  day: number;
  workDate: string;
  entry: TimesheetEntry | null;
}

interface IBulkObjectCorrectionTarget {
  employee: TimesheetEmployee;
  day: number;
  workDate: string;
  objectTarget: IObjectModalTarget;
  objectEntry: TimesheetObjectEntry | null;
}

interface IObjectModalTarget {
  object_key: string;
  object_id: string | null;
  object_name: string;
}

type TimesheetDisplaySegment = TimesheetApprovalHalf | 'FULL';
type TimesheetViewMode = 'employees' | 'objects';

const APPROVAL_STATUS_META: Record<'draft' | 'submitted' | 'approved' | 'rejected' | 'returned', string> = {
  draft: 'Черновик',
  submitted: 'На проверке',
  approved: 'Утверждён',
  rejected: 'Отклонён',
  returned: 'На доработке',
};

const getTodayDateInputValue = (): string => new Date().toISOString().slice(0, 10);
const UNASSIGNED_OBJECT_KEY = '__timesheet_unassigned__';
const UNASSIGNED_OBJECT_NAME = 'Не определён / без объекта';

const MONTH_NAMES_RU = ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

const formatFioWithInitials = (fullName?: string | null): string => {
  if (!fullName) return '';
  const [last, first, middle] = fullName.trim().split(/\s+/);
  if (!last) return '';
  const initials = [first, middle]
    .filter(Boolean)
    .map(part => `${part!.charAt(0).toUpperCase()}.`)
    .join('');
  return initials ? `${last} ${initials}` : last;
};

const sanitizeDownloadName = (name: string): string => name.replace(/[\\/:*?"<>|]/g, '_');

const buildObjectBulkMetaKey = (employeeId: number, objectKey: string): string => `${employeeId}:${objectKey}`;

const parseBulkCellKey = (
  key: string,
): { kind: 'employee'; employeeId: number; day: number } | { kind: 'object'; employeeId: number; objectKey: string; day: number } | null => {
  const parts = key.split(':');
  if (parts[0] === 'employee' && parts.length === 3) {
    const employeeId = Number.parseInt(parts[1] || '', 10);
    const day = Number.parseInt(parts[2] || '', 10);
    if (!Number.isFinite(employeeId) || !Number.isFinite(day)) return null;
    return { kind: 'employee', employeeId, day };
  }

  if (parts[0] === 'object' && parts.length === 4) {
    const employeeId = Number.parseInt(parts[1] || '', 10);
    const objectKey = decodeURIComponent(parts[2] || '');
    const day = Number.parseInt(parts[3] || '', 10);
    if (!Number.isFinite(employeeId) || !Number.isFinite(day) || !objectKey) return null;
    return { kind: 'object', employeeId, objectKey, day };
  }

  return null;
};

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
  const { hasPermission, profile, canEditPage, canViewPage } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const isSuperAdmin = profile?.position_type === 'super_admin';
  const canEditTimesheet = canEditPage('/timesheet') || canEditPage('/timesheet-hr');
  const canViewManagedTimesheet = canEditTimesheet || canViewPage('/timesheet') || canViewPage('/timesheet-hr');
  const canEditTeamManagement = isSuperAdmin
    || canEditPage('/timesheet/team-management')
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
  const currentDay = now.getDate();
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

  // Side panel
  const [panelEmployee, setPanelEmployee] = useState<TimesheetEmployee | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  // Modal
  const [modalOpen, setModalOpen] = useState(false);
  const [modalEmployee, setModalEmployee] = useState<TimesheetEmployee | null>(null);
  const [modalDay, setModalDay] = useState<number>(1);
  const [modalEntry, setModalEntry] = useState<TimesheetEntry | null>(null);
  const [modalMode, setModalMode] = useState<'day' | 'object' | 'split-view'>('day');
  const [modalObjectEntry, setModalObjectEntry] = useState<TimesheetObjectEntry | null>(null);
  const [modalObjectTarget, setModalObjectTarget] = useState<IObjectModalTarget | null>(null);
  const [modalSplitEntries, setModalSplitEntries] = useState<TimesheetObjectEntry[]>([]);
  const [modalSplitMessage, setModalSplitMessage] = useState<string | null>(null);
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [bulkSelectedCellKeys, setBulkSelectedCellKeys] = useState<Set<string>>(new Set());
  const [teamManagementOpen, setTeamManagementOpen] = useState(false);
  const [teamSearch, setTeamSearch] = useState('');
  const [teamPendingEmployeeId, setTeamPendingEmployeeId] = useState<number | null>(null);

  const deptOptions = useMemo<IFlatDepartmentOption[]>(() => {
    const allNodes = structureQuery.data?.departments ?? [];
    if (isDepartmentScope && managedDepartmentIds.length > 0) {
      const filtered = filterDepartmentTreeByIds(allNodes, new Set(managedDepartmentIds));
      return getTreeFlatDepartments(filtered);
    }
    return getTreeFlatDepartments(allNodes);
  }, [structureQuery.data, isDepartmentScope, managedDepartmentIds]);
  const effectiveSelectedDeptId = isTimesheetDepartmentScope
    ? (selectedDeptId || primaryDepartmentId || null)
    : selectedDeptId;
  const viewMode: TimesheetViewMode = queryView === 'objects' ? 'objects' : 'employees';

  useEffect(() => {
    if (!isMultiDepartmentManager) return;
    if (effectiveSelectedDeptId && managedDepartmentIds.includes(effectiveSelectedDeptId)) return;
    setSelectedDeptId(primaryDepartmentId || managedDepartmentIds[0] || null);
  }, [effectiveSelectedDeptId, isMultiDepartmentManager, managedDepartmentIds, primaryDepartmentId]);

  // Close dept/assignee dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (deptRef.current && !deptRef.current.contains(e.target as Node)) {
        setDeptOpen(false);
      }
      if (assigneeRef.current && !assigneeRef.current.contains(e.target as Node)) {
        setAssigneeOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const monthStr = useMemo(() => `${year}-${String(month).padStart(2, '0')}`, [year, month]);
  const daysInMonth = useMemo(() => getDaysInMonth(year, month), [year, month]);
  const isPastMonth = resolvedMonthIndex < currentMonthIndex;
  const activeSegment = useMemo<TimesheetDisplaySegment>(() => {
    if (queryHalf === 'FULL') return 'FULL';
    if (queryHalf === 'H1' || queryHalf === 'H2') return queryHalf;
    if (isPastMonth) return 'FULL';
    if (resolvedMonthIndex === currentMonthIndex && currentDay > 15) return 'H2';
    return 'H1';
  }, [queryHalf, isPastMonth, resolvedMonthIndex, currentMonthIndex, currentDay]);
  const activeGridDeptId = timesheetMode === 'assigned' ? assignedExpandedDeptId : effectiveSelectedDeptId;
  const timesheetQuery = useQuery({
    queryKey: ['timesheet-page', monthStr, activeSegment, activeGridDeptId ?? 'none'],
    queryFn: () => timesheetService.getAll({
      month: monthStr,
      department_id: activeGridDeptId || undefined,
      half: activeSegment,
    }),
    enabled: Boolean(activeGridDeptId),
    staleTime: 30_000,
    placeholderData: previousData => previousData,
  });
  const overviewQuery = useQuery({
    queryKey: ['timesheet-overview', monthStr, activeSegment],
    queryFn: () => timesheetService.getOverview({ month: monthStr, half: activeSegment }),
    enabled: timesheetMode === 'department' && isMultiDepartmentManager,
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
  const objectEntries = useMemo<TimesheetObjectEntry[]>(
    () => timesheetQuery.data?.object_entries || [],
    [timesheetQuery.data],
  );
  const stats = timesheetQuery.data?.stats || DEFAULT_STATS;
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
    staleTime: 30_000,
    placeholderData: previousData => previousData,
  });
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
  const splitDayKeys = useMemo(() => new Set(
    entries
      .filter(entry => entry.object_detail_mode === 'available' || entry.object_detail_mode === 'legacy_blocked')
      .map(entry => `${entry.employee_id}_${entry.work_date}`),
  ), [entries]);
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
    if (bulkModeEnabled && viewMode === 'employees') return;
    setPanelEmployee(emp);
    setPanelOpen(true);
  };

  const closeModal = useCallback(() => {
    setModalOpen(false);
    setModalMode('day');
    setModalObjectEntry(null);
    setModalObjectTarget(null);
    setModalSplitEntries([]);
    setModalSplitMessage(null);
  }, []);

  // Day click -> modal
  const handleDayClick = (emp: TimesheetEmployee, day: number, entry: TimesheetEntry | null) => {
    if (bulkModeEnabled && viewMode === 'employees') return;
    const workDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dayObjectEntries = objectEntriesByEmployeeDate.get(emp.id)?.get(workDate) || [];
    setModalEmployee(emp);
    setModalDay(day);
    setModalEntry(entry);
    if (entry?.object_detail_mode === 'available' && dayObjectEntries.length > 0) {
      setModalMode('split-view');
      setModalSplitEntries(dayObjectEntries);
      setModalSplitMessage(null);
      setModalObjectEntry(null);
      setModalObjectTarget(null);
      setModalOpen(true);
      return;
    }
    if (entry?.object_detail_mode === 'legacy_blocked') {
      setModalMode('split-view');
      setModalSplitEntries([]);
      setModalSplitMessage(entry.object_detail_message || 'Объектная детализация временно недоступна для этого дня.');
      setModalObjectEntry(null);
      setModalObjectTarget(null);
      setModalOpen(true);
      return;
    }
    setModalMode('day');
    setModalSplitEntries([]);
    setModalSplitMessage(null);
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
    setModalEmployee(emp);
    setModalDay(day);
    setModalEntry(entryMap.get(`${emp.id}_${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`) || null);
    setModalMode('object');
    setModalObjectEntry(objectEntry);
    setModalObjectTarget(target);
    setModalSplitEntries([]);
    setModalSplitMessage(null);
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
        queryClient.invalidateQueries({ queryKey: ['timesheet-page', monthStr, activeSegment, effectiveSelectedDeptId ?? 'none'] }),
        queryClient.invalidateQueries({ queryKey: ['timesheet-overview'] }),
      ]);
    } catch (err) {
      console.error('Save correction error:', err);
    }
  }, [modalEmployee, year, month, modalDay, modalEntry, closeModal, queryClient, monthStr, activeSegment, effectiveSelectedDeptId]);

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
        queryClient.invalidateQueries({ queryKey: ['timesheet-page', monthStr, activeSegment, effectiveSelectedDeptId ?? 'none'] }),
        queryClient.invalidateQueries({ queryKey: ['timesheet-overview'] }),
      ]);
    } catch (error) {
      console.error('Save object correction error:', error);
      toast.error(error instanceof Error ? error.message : 'Не удалось сохранить корректировку по объекту');
    }
  }, [modalEmployee, modalObjectTarget, year, month, modalDay, closeModal, queryClient, monthStr, activeSegment, effectiveSelectedDeptId, toast]);

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
        queryClient.invalidateQueries({ queryKey: ['timesheet-page', monthStr, activeSegment, effectiveSelectedDeptId ?? 'none'] }),
        queryClient.invalidateQueries({ queryKey: ['timesheet-overview'] }),
      ]);
    } catch (error) {
      console.error('Delete object correction error:', error);
      toast.error(error instanceof Error ? error.message : 'Не удалось снять корректировку по объекту');
    }
  }, [modalEmployee, modalObjectTarget, modalObjectEntry?.adjustment_id, year, month, modalDay, closeModal, queryClient, monthStr, activeSegment, effectiveSelectedDeptId, toast]);

  // Export
  const canExport = timesheetMode === 'assigned'
    ? Boolean(selectedAssigneeId)
    : Boolean(effectiveSelectedDeptId);

  const handleExport = async (presentation: 'hr' | 'manager' = 'hr') => {
    if (!canExport) {
      toast.error(timesheetMode === 'assigned' ? 'Выберите начальника участка' : 'Выберите отдел');
      return;
    }
    try {
      const monthStr = `${year}-${String(month).padStart(2, '0')}`;
      const segmentSuffix = activeSegment === 'FULL'
        ? ''
        : `_${activeSegment === 'H1' ? '1-15' : `16-${daysInMonth}`}`;
      const monthName = MONTH_NAMES_RU[month];
      const presentationSuffix = presentation === 'manager' ? '_Руководитель' : '';

      let blob: Blob;
      let filename: string;

      if (timesheetMode === 'assigned' && selectedAssigneeId) {
        blob = await timesheetService.exportAssigned({
          month: monthStr,
          half: activeSegment,
          employee_ids: [selectedAssigneeId],
          group_by: viewMode,
          presentation,
        });
        const assignee = assigneesQuery.data?.find(emp => emp.id === selectedAssigneeId);
        const assigneeName = formatFioWithInitials(assignee?.full_name) || 'Участок';
        const suffix = viewMode === 'objects' ? '_объекты' : '';
        filename = `Участок_${assigneeName}${suffix}_${monthName}_${year}${segmentSuffix}${presentationSuffix}.zip`;
      } else if (viewMode === 'objects' && effectiveSelectedDeptId) {
        blob = await timesheetService.exportMass({
          month: monthStr,
          half: activeSegment,
          department_ids: [effectiveSelectedDeptId],
          group_by: 'objects',
          presentation,
        });
        filename = `${selectedDeptName}_объекты_${monthName}_${year}${segmentSuffix}${presentationSuffix}.zip`;
      } else {
        blob = await timesheetService.export({
          month: monthStr,
          department_id: effectiveSelectedDeptId || undefined,
          half: activeSegment,
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
      || overviewQuery.data?.find((summary: ManagedDepartmentTimesheetSummary) => summary.department_id === activeGridDeptId)?.department_name
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
        queryClient.invalidateQueries({ queryKey: ['timesheet-page', monthStr, activeSegment, activeGridDeptId ?? 'none'] }),
        queryClient.invalidateQueries({ queryKey: ['timesheet-overview'] }),
        queryClient.invalidateQueries({ queryKey: ['timesheet-team-search'] }),
      ]);
      setTeamSearch('');
    } catch (error) {
      console.error('Add employee to department error:', error);
      toast.error(error instanceof Error ? error.message : 'Не удалось добавить сотрудника в отдел');
    } finally {
      setTeamPendingEmployeeId(null);
    }
  }, [activeSegment, activeGridDeptId, monthStr, queryClient, selectedDeptName, toast]);

  const handleExcludeEmployeeFromDepartment = useCallback(async (employee: TimesheetEmployee) => {
    if (!activeGridDeptId) return;
    if (!window.confirm(
      `Исключить ${employee.full_name} из табеля?\n\nСотрудник пропадёт из таблицы, но останется активным в системе. Вернуть его можно через «Перевести сотрудника».`,
    )) {
      return;
    }
    setTeamPendingEmployeeId(employee.id);
    try {
      await timesheetService.excludeEmployeeFromDepartment({
        employee_id: employee.id,
        department_id: activeGridDeptId,
      });
      if (panelEmployee?.id === employee.id) {
        setPanelOpen(false);
        setPanelEmployee(null);
      }
      toast.success(`Сотрудник ${employee.full_name} исключён из табеля`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['timesheet-page', monthStr, activeSegment, activeGridDeptId ?? 'none'] }),
        queryClient.invalidateQueries({ queryKey: ['timesheet-overview'] }),
        queryClient.invalidateQueries({ queryKey: ['timesheet-team-search'] }),
      ]);
    } catch (error) {
      console.error('Exclude employee from department error:', error);
      toast.error(error instanceof Error ? error.message : 'Не удалось исключить сотрудника из табеля');
    } finally {
      setTeamPendingEmployeeId(null);
    }
  }, [activeSegment, activeGridDeptId, monthStr, panelEmployee?.id, queryClient, toast]);

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
    const plannedHours = getWorkHoursForDay(sched, year, month, modalDay);
    if (modalMode !== 'object' || !modalObjectTarget) {
      return plannedHours;
    }

    const workDate = `${year}-${String(month).padStart(2, '0')}-${String(modalDay).padStart(2, '0')}`;
    const dayObjectEntries = objectEntriesByEmployeeDate.get(modalEmployee.id)?.get(workDate) || [];
    const otherHours = dayObjectEntries.reduce((sum, item) => {
      if (item.object_key === modalObjectTarget.object_key) {
        return sum;
      }
      return sum + (item.display_hours_worked ?? item.hours_worked ?? 0);
    }, 0);
    return Math.max(0, plannedHours - otherHours);
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
    if (!bulkModeEnabled || viewMode !== 'objects') return [];

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
    viewMode,
    bulkSelectedCellKeys,
    bulkObjectRowMetaMap,
    year,
    month,
    objectEntriesByEmployeeDate,
    employeeOrder,
  ]);

  const bulkInitialStatus = useMemo<TimesheetStatus>(() => {
    if (viewMode === 'objects') {
      return 'manual';
    }
    if (bulkTargets.length === 1 && bulkTargets[0].entry?.status) {
      return bulkTargets[0].entry.status;
    }
    return 'work';
  }, [bulkTargets, viewMode]);

  const bulkDefaultHours = useMemo(() => {
    if (viewMode === 'objects') {
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
  }, [viewMode, bulkObjectTargets, bulkTargets, schedules, dailySchedules, year, month]);

  const bulkMaxHours = useMemo(() => {
    if (!isTimesheetDepartmentScope) return null;
    if (viewMode === 'objects') {
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
        const plannedHours = getWorkHoursForDay(sched, year, month, target.day);
        const dayObjectEntries = objectEntriesByEmployeeDate.get(target.employee.id)?.get(target.workDate) || [];
        const otherHours = dayObjectEntries.reduce((sum, item) => {
          if (item.object_key === target.objectTarget.object_key) {
            return sum;
          }
          return sum + (item.display_hours_worked ?? item.hours_worked ?? 0);
        }, 0);
        const allowedHours = Math.max(0, plannedHours - otherHours);
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
    return getWorkHoursForDay(sched, year, month, firstTarget.day);
  }, [
    isTimesheetDepartmentScope,
    viewMode,
    bulkObjectTargets,
    bulkTargets,
    schedules,
    dailySchedules,
    year,
    month,
    objectEntriesByEmployeeDate,
  ]);

  const handleOpenBulkModal = useCallback(() => {
    if (viewMode === 'objects') {
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
  }, [viewMode, bulkObjectTargets.length, bulkTargets.length, toast]);

  const handleSaveBulkCorrection = useCallback(async (status: TimesheetStatus, hours: number | null, notes: string) => {
    if (viewMode === 'objects') {
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
          queryClient.invalidateQueries({ queryKey: ['timesheet-page', monthStr, activeSegment, activeGridDeptId ?? 'none'] }),
          queryClient.invalidateQueries({ queryKey: ['timesheet-overview'] }),
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
        queryClient.invalidateQueries({ queryKey: ['timesheet-page', monthStr, activeSegment, activeGridDeptId ?? 'none'] }),
        queryClient.invalidateQueries({ queryKey: ['timesheet-overview'] }),
      ]);
      toast.success(`Корректировка применена для ${result.processed} ячеек`);
    } catch (error) {
      console.error('Bulk save correction error:', error);
      toast.error(error instanceof Error ? error.message : 'Не удалось применить массовую корректировку');
    }
  }, [
    viewMode,
    bulkObjectTargets,
    bulkTargets,
    clearBulkState,
    queryClient,
    monthStr,
    activeSegment,
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
    if (viewMode === 'objects') {
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
    viewMode,
    bulkSelectedObjectRowsCount,
    bulkSelectedDaysCount,
    bulkObjectTargets.length,
    bulkSelectedEmployeesCount,
    bulkTargets.length,
  ]);

  const handleSegmentChange = useCallback((segment: TimesheetDisplaySegment) => {
    clearBulkState();
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      next.set('month', monthStr);
      next.set('half', segment);
      return next;
    });
  }, [clearBulkState, monthStr, setSearchParams]);

  const handleViewModeChange = useCallback((nextViewMode: TimesheetViewMode) => {
    clearBulkState();
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      if (nextViewMode === 'objects') {
        next.set('view', 'objects');
      } else {
        next.delete('view');
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

  const handleAssignedDeptToggle = useCallback((departmentId: string) => {
    clearBulkState();
    closeTeamManagement();
    setPanelOpen(false);
    setModalOpen(false);
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      if (next.get('dept') === departmentId) {
        next.delete('dept');
      } else {
        next.set('dept', departmentId);
      }
      return next;
    });
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

  // Auto-expand the only department when assignee has exactly one
  useEffect(() => {
    if (timesheetMode !== 'assigned') return;
    if (!selectedAssignee) return;
    if (assignedExpandedDeptId) return;
    const depts = selectedAssignee.departments || [];
    if (depts.length === 1) {
      const only = depts[0];
      setSearchParams(current => {
        const next = new URLSearchParams(current);
        next.set('dept', only.id);
        return next;
      }, { replace: true });
    }
  }, [timesheetMode, selectedAssignee, assignedExpandedDeptId, setSearchParams]);

  const assigneeButtonLabel = selectedAssignee
    ? formatTimesheetEmployeeName(selectedAssignee.full_name)
    : 'Выберите сотрудника';

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
      {isTimesheetDepartmentScope ? (
        <button type="button" className="ts-dept-btn" style={{ cursor: 'default', opacity: 0.8 }}>
          {isMultiDepartmentManager ? 'Мои бригады' : selectedDeptName}
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
                onClick={() => { clearBulkState(); closeTeamManagement(); setSelectedDeptId(null); setDeptOpen(false); }}
              >
                Все отделы
              </div>
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
                    onClick={() => { clearBulkState(); closeTeamManagement(); setSelectedDeptId(d.id); setDeptOpen(false); }}
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
      <button
        type="button"
        className={`ts-half-chip ${activeSegment === 'FULL' ? ' ts-half-chip--active' : ''}`}
        onClick={() => handleSegmentChange('FULL')}
      >
        <span className="ts-half-chip-label">Весь месяц</span>
        <span className="ts-half-chip-subtitle">Полный табель</span>
      </button>
    </section>
  ) : null;
  const viewControl = (isAssignedMode ? selectedAssigneeId : effectiveSelectedDeptId) ? (
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

  const modalWorkDate = `${year}-${String(month).padStart(2, '0')}-${String(modalDay).padStart(2, '0')}`;
  const splitDayContent = modalMode === 'split-view' ? (
    <div className="ts-split-day-view">
      {modalSplitMessage && (
        <div className="ts-split-day-message">{modalSplitMessage}</div>
      )}
      {modalSplitEntries.length > 0 ? (
        <div className="ts-split-day-list">
          {modalSplitEntries.map(objectEntry => (
            <button
              key={objectEntry.object_key}
              type="button"
              className="ts-split-day-item"
              onClick={() => {
                if (!modalEmployee) return;
                handleObjectDayClick(modalEmployee, modalDay, {
                  object_key: objectEntry.object_key,
                  object_id: objectEntry.object_id,
                  object_name: objectEntry.object_name,
                }, objectEntry);
              }}
            >
              <span className="ts-split-day-item-name">{objectEntry.object_name}</span>
              <span className="ts-split-day-item-hours">
                {(objectEntry.display_hours_worked ?? objectEntry.hours_worked).toFixed(2)} ч
              </span>
            </button>
          ))}
        </div>
      ) : (
        !modalSplitMessage && <div className="ts-split-day-message">Для этого дня нет доступной объектной детализации.</div>
      )}
    </div>
  ) : null;

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
                  onClick={() => handleExport('hr')}
                  disabled={!canExport}
                  aria-label="Экспорт: факт"
                  title="Выгрузить факт"
                >
                  <Download size={16} />
                </button>
                <button
                  type="button"
                  className="ts-btn ts-btn--icon"
                  onClick={() => handleExport('manager')}
                  disabled={!canExport}
                  aria-label="Экспорт: руководитель"
                  title="Выгрузить для руководителя (урезано по графику)"
                >
                  <Download size={16} />
                  <span style={{ fontSize: 10, marginLeft: 2 }}>Р</span>
                </button>
              </div>
            </div>
            <div className="ts-mobile-header-row ts-mobile-header-row--controls">
              {monthNavigation}
              {selectorControl}
            </div>
            {modeControl}
            {!isAssignedMode && <TimesheetStats stats={stats} compact />}
            {mobileApprovalVisible && !isMultiDepartmentManager && !isAssignedMode && (
              <div className="ts-mobile-approval-panel">
                <TimesheetApprovalBar
                  departmentId={effectiveSelectedDeptId}
                  month={`${year}-${String(month).padStart(2, '0')}`}
                  compact
                  allowReview={false}
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
                {selectorControl}
                {modeControl}
              </div>
              {!isMultiDepartmentManager && (
                <div className="ts-header-right">
                  <TimesheetApprovalBar
                    departmentId={effectiveSelectedDeptId}
                    month={`${year}-${String(month).padStart(2, '0')}`}
                    allowReview={false}
                  />
                </div>
              )}
            </div>
          </section>
        )}

        {!isMobile && (
          <div className="ts-toolbar">
            <div className="ts-toolbar-left">
              <TimesheetStats stats={stats} />
              <button type="button" className="ts-btn" onClick={() => handleExport('hr')} disabled={!canExport}>
                <Download size={16} />
                Факт
              </button>
              <button
                type="button"
                className="ts-btn"
                onClick={() => handleExport('manager')}
                disabled={!canExport}
                title="Табель урезан по графику работы"
              >
                <Download size={16} />
                Руководитель
              </button>
            </div>
            <div className="ts-toolbar-right">
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
        )}

        {segmentControl}
        {viewControl}
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
                <div className="ts-bulk-title">Массовая корректировка</div>
                <div className="ts-bulk-hint">
                  Зажмите левую кнопку мыши и протяните по таблице нужный диапазон. Новая протяжка добавит дни к уже выбранным. {bulkSelectionSummary}
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
                  disabled={bulkTargets.length === 0}
                >
                  Внести корректировку
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {isAssignedMode ? (
        !selectedAssigneeId ? (
          <div className="ts-table-container">
            <div className="ts-loading">Выберите назначенного сотрудника</div>
          </div>
        ) : !selectedAssignee ? (
          <div className="ts-table-container">
            <div className="ts-loading">Загрузка...</div>
          </div>
        ) : (selectedAssignee.departments?.length ?? 0) === 0 ? (
          <div className="ts-table-container">
            <div className="ts-loading">У сотрудника нет доступных отделов</div>
          </div>
        ) : (
          <section className="ts-accordion">
            {(selectedAssignee.departments || []).map(dept => {
              const expanded = assignedExpandedDeptId === dept.id;
              return (
                <article key={dept.id} className={`ts-accordion-item${expanded ? ' ts-accordion-item--expanded' : ''}`}>
                  <button
                    type="button"
                    className="ts-accordion-summary"
                    onClick={() => handleAssignedDeptToggle(dept.id)}
                  >
                    <div className="ts-accordion-main">
                      <div className="ts-accordion-name">{dept.name}</div>
                    </div>
                  </button>

                  {expanded && (
                    <div className="ts-accordion-detail">
                      {!isMobile && (
                        <div className="ts-accordion-detail-bar">
                          <TimesheetApprovalBar
                            departmentId={dept.id}
                            month={`${year}-${String(month).padStart(2, '0')}`}
                            allowReview={false}
                          />
                        </div>
                      )}
                      {timesheetQuery.isLoading ? (
                        <div className="ts-table-container">
                          <div className="ts-loading">Загрузка табеля...</div>
                        </div>
                      ) : (
                        <TimesheetGrid
                          employees={employees}
                          entries={entries}
                          objectEntries={objectEntries}
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
                    </div>
                  )}
                </article>
              );
            })}
          </section>
        )
      ) : (
      <>
      {/* Grid */}
      {isMultiDepartmentManager ? (
        <section className="ts-accordion">
          {(overviewQuery.isLoading && !overviewQuery.data) ? (
            <div className="ts-table-container">
              <div className="ts-loading">Загрузка обзора табелей...</div>
            </div>
          ) : (overviewQuery.data || []).map(summary => {
            const expanded = summary.department_id === effectiveSelectedDeptId;
            const approvalValues: Array<{ key: 'H1' | 'H2' | 'FULL'; label: string }> = [
              { key: 'H1', label: 'H1' },
              { key: 'H2', label: 'H2' },
              { key: 'FULL', label: 'Месяц' },
            ];

            return (
              <article key={summary.department_id} className={`ts-accordion-item${expanded ? ' ts-accordion-item--expanded' : ''}`}>
                <button
                  type="button"
                  className="ts-accordion-summary"
                  onClick={() => {
                    clearBulkState();
                    closeTeamManagement();
                    setSelectedDeptId(summary.department_id);
                  }}
                >
                  <div className="ts-accordion-main">
                    <div className="ts-accordion-name">{summary.department_name}</div>
                    <div className="ts-accordion-meta">
                      <span>{summary.employee_count} чел.</span>
                      <span>{summary.norm_hours.toFixed(1)} норма</span>
                      <span>{summary.actual_hours.toFixed(1)} факт</span>
                      <span>Опозданий: {summary.deviations.late}</span>
                      <span>Неявок: {summary.deviations.absent}</span>
                      <span>Больничных: {summary.deviations.sick}</span>
                    </div>
                  </div>
                  <div className="ts-accordion-statuses">
                    {approvalValues.map(item => {
                      const status = summary.approval_by_half[item.key];
                      return (
                        <span key={item.key} className={`ts-accordion-status ts-accordion-status--${status || 'draft'}`}>
                          {item.label}: {status ? APPROVAL_STATUS_META[status] : 'Нет'}
                        </span>
                      );
                    })}
                  </div>
                </button>

                {expanded && (
                  <div className="ts-accordion-detail">
                    {!isMobile && (
                      <div className="ts-accordion-detail-bar">
                        <TimesheetApprovalBar
                          departmentId={effectiveSelectedDeptId}
                          month={`${year}-${String(month).padStart(2, '0')}`}
                          allowReview={false}
                        />
                      </div>
                    )}
                    {loading ? (
                      <div className="ts-table-container">
                        <div className="ts-loading">Загрузка табеля...</div>
                      </div>
                    ) : (
                      <TimesheetGrid
                        employees={employees}
                        entries={entries}
                        objectEntries={objectEntries}
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
                  </div>
                )}
              </article>
            );
          })}
        </section>
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

      </>
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
            onSave={modalMode === 'object' ? handleSaveObjectCorrection : handleSaveCorrection}
            onDelete={modalMode === 'object' && modalObjectEntry?.adjustment_id ? handleDeleteObjectCorrection : undefined}
            initialStatus={modalMode === 'object' ? 'manual' : (modalEntry?.status || 'work')}
            initialHours={modalDefaultHours}
            initialNotes={modalMode === 'object' ? (modalObjectEntry?.notes ?? '') : ''}
            dayLabel={`${formatDateRu(modalDay, month)}`}
            title={modalMode === 'object' ? modalObjectTarget?.object_name : undefined}
            subtitle={modalMode === 'object' ? `${modalEmployee?.full_name || ''} • ${formatDateRu(modalDay, month)}` : undefined}
            employeeName={modalMode === 'object' ? undefined : modalEmployee?.full_name}
            employeeId={modalEmployee?.id}
            workDate={modalWorkDate}
            hideSkudTab={modalMode !== 'day'}
            allowAccessPointMap={canViewPage('/skud-settings')}
            hideCorrectionTab={modalMode === 'split-view'}
            allowedStatuses={modalMode === 'object' ? ['manual'] : undefined}
            confirmLabel={modalMode === 'object' ? 'Сохранить по объекту' : undefined}
            deleteLabel={modalMode === 'object' ? 'Снять корректировку' : undefined}
            customContent={splitDayContent}
            timesheetEntry={modalEntry}
            maxHours={modalMode === 'split-view' ? null : modalMaxHours}
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
            title={viewMode === 'objects' ? 'Массовая корректировка по объектам' : 'Массовая корректировка'}
            subtitle={bulkSelectionSummary}
            confirmLabel={viewMode === 'objects' ? 'Применить по объектам' : 'Применить'}
            hideSkudTab
            maxHours={bulkMaxHours}
            allowedStatuses={viewMode === 'objects' ? ['manual'] : undefined}
          />
        </Suspense>
      )}
    </div>
  );
};
