import { useQuery } from '@tanstack/react-query';
import {
  timesheetApprovalService,
  type TimesheetApprovalStatus,
  type TimesheetSubmissionMode,
} from '../services/timesheetApprovalService';
import { timesheetService, type IWeekendMemoPreview } from '../services/timesheetService';

export const getTimesheetApprovalStatusQueryKey = (
  mode: TimesheetSubmissionMode,
  departmentId: string | null,
  startDate: string,
  endDate: string,
) => ['timesheet-approval', 'status', mode, departmentId, startDate, endDate] as const;

export const getTimesheetApprovalDepartmentListQueryKey = (
  mode: TimesheetSubmissionMode,
  departmentId: string | null,
  month: string,
) => ['timesheet-approval', 'department-list', mode, departmentId, month] as const;

export const getTimesheetApprovalReviewListQueryKey = (
  status: TimesheetApprovalStatus | 'submitted',
) => ['timesheet-approval', 'list', status] as const;

export const getTimesheetApprovalHistoryQueryKey = (
  approvalId: number | null,
) => ['timesheet-approval', 'history', approvalId] as const;

export const getTimesheetResponsiblesQueryKey = (
  departmentId: string | null,
) => ['timesheet-approval', 'responsibles', departmentId] as const;

export const getTimesheetResponsibleCandidatesQueryKey = (
  departmentId: string | null,
) => ['timesheet-approval', 'responsible-candidates', departmentId] as const;

/**
 * Статус согласования для конкретного диапазона.
 * mode='department' — по отделу; mode='personal' — персональная подача текущего пользователя.
 */
export const useTimesheetApprovalStatus = (
  mode: TimesheetSubmissionMode,
  departmentId: string | null,
  startDate: string,
  endDate: string,
) => useQuery({
  queryKey: getTimesheetApprovalStatusQueryKey(mode, departmentId, startDate, endDate),
  queryFn: () => timesheetApprovalService.getStatus(
    mode === 'personal' ? { mode: 'personal' } : { mode: 'department', department_id: departmentId },
    startDate,
    endDate,
  ),
  enabled: !!startDate && !!endDate && (mode === 'personal' || !!departmentId),
  staleTime: 30_000,
});

/**
 * Список согласований за месяц (для отображения блокировок).
 * mode='department' — по выбранному отделу; mode='personal' — свои персональные.
 */
export const useTimesheetDepartmentApprovals = (
  mode: TimesheetSubmissionMode,
  departmentId: string | null,
  month: string,
  enabled = true,
) => useQuery({
  queryKey: getTimesheetApprovalDepartmentListQueryKey(mode, departmentId, month),
  queryFn: () => (mode === 'personal'
    ? timesheetApprovalService.listPersonal(month)
    : timesheetApprovalService.listDepartment(departmentId as string, month)
  ),
  enabled: enabled && !!month && (mode === 'personal' || !!departmentId),
  staleTime: 30_000,
  placeholderData: previousData => previousData,
});

export const useTimesheetApprovalReviewList = (
  status: 'submitted' | 'approved' | 'rejected',
  enabled = true,
) => useQuery({
  queryKey: getTimesheetApprovalReviewListQueryKey(status),
  queryFn: () => timesheetApprovalService.getByStatus(status),
  enabled,
  staleTime: 30_000,
  placeholderData: previousData => previousData,
});

export const useTimesheetApprovalHistory = (approvalId: number | null, enabled = true) => useQuery({
  queryKey: getTimesheetApprovalHistoryQueryKey(approvalId),
  queryFn: () => timesheetApprovalService.getHistory(approvalId as number),
  enabled: enabled && !!approvalId,
  staleTime: 30_000,
  placeholderData: previousData => previousData,
});

export const getTimesheetApprovalDashboardQueryKey = (
  startDate: string,
  endDate: string,
  departmentIds: string[] | undefined,
) => ['timesheet-approval', 'dashboard', startDate, endDate, departmentIds ?? null] as const;

/**
 * HR-дашборд: сводка подачи/утверждения + карта руководителей.
 * departmentIds: undefined — без фильтра; массив (в т.ч. пустой) — фильтр отделов (весь дашборд).
 */
export const useTimesheetApprovalDashboard = (
  startDate: string,
  endDate: string,
  departmentIds?: string[],
  enabled = true,
) => useQuery({
  queryKey: getTimesheetApprovalDashboardQueryKey(startDate, endDate, departmentIds),
  queryFn: () => timesheetApprovalService.getDashboard(startDate, endDate, departmentIds),
  enabled: enabled && !!startDate && !!endDate,
  staleTime: 60_000,
  placeholderData: previousData => previousData,
});

export const getWeekendMemoPreviewQueryKey = (
  departmentId: string | null,
  startDate: string,
  endDate: string,
) => ['timesheet-approval', 'weekend-memo-preview', departmentId, startDate, endDate] as const;

/** Превью кто/за-какие-даты попадёт в служебку. Источник — корректировки в табеле. */
export const useWeekendMemoPreview = (
  departmentId: string | null,
  startDate: string,
  endDate: string,
  enabled = true,
) => useQuery<IWeekendMemoPreview>({
  queryKey: getWeekendMemoPreviewQueryKey(departmentId, startDate, endDate),
  queryFn: () => timesheetService.getWeekendMemoPreview({
    department_id: departmentId as string,
    start_date: startDate,
    end_date: endDate,
  }),
  enabled: enabled && !!departmentId && !!startDate && !!endDate,
  staleTime: 30_000,
  placeholderData: previousData => previousData,
});
