import { useQuery } from '@tanstack/react-query';
import { timesheetApprovalService, type TimesheetApprovalStatus } from '../services/timesheetApprovalService';
import { timesheetService, type IWeekendMemoPreview } from '../services/timesheetService';

export const getTimesheetApprovalStatusQueryKey = (
  departmentId: string | null,
  startDate: string,
  endDate: string,
) => ['timesheet-approval', 'status', departmentId, startDate, endDate] as const;

export const getTimesheetApprovalDepartmentListQueryKey = (
  departmentId: string | null,
  month: string,
) => ['timesheet-approval', 'department-list', departmentId, month] as const;

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

/** Статус согласования отдела для конкретного диапазона (точное совпадение). */
export const useTimesheetApprovalStatus = (
  departmentId: string | null,
  startDate: string,
  endDate: string,
) => useQuery({
  queryKey: getTimesheetApprovalStatusQueryKey(departmentId, startDate, endDate),
  queryFn: () => timesheetApprovalService.getStatus(departmentId as string, startDate, endDate),
  enabled: !!departmentId && !!startDate && !!endDate,
  staleTime: 30_000,
});

/** Список всех согласований отдела, пересекающихся с месяцем (для отображения блокировок). */
export const useTimesheetDepartmentApprovals = (
  departmentId: string | null,
  month: string,
  enabled = true,
) => useQuery({
  queryKey: getTimesheetApprovalDepartmentListQueryKey(departmentId, month),
  queryFn: () => timesheetApprovalService.listDepartment(departmentId as string, month),
  enabled: enabled && !!departmentId && !!month,
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
