import { useQuery } from '@tanstack/react-query';
import { timesheetApprovalService, type TimesheetApprovalStatus } from '../services/timesheetApprovalService';

export const getTimesheetApprovalStatusQueryKey = (departmentId: string | null, period: string) => ['timesheet-approval', 'status', departmentId, period] as const;
export const getTimesheetApprovalReviewListQueryKey = (status: TimesheetApprovalStatus | 'submitted') => ['timesheet-approval', 'list', status] as const;

export const useTimesheetApprovalStatus = (departmentId: string | null, period: string) => useQuery({
  queryKey: getTimesheetApprovalStatusQueryKey(departmentId, period),
  queryFn: () => timesheetApprovalService.getStatus(departmentId as string, period),
  enabled: !!departmentId && !!period,
  staleTime: 30_000,
});

export const useTimesheetApprovalReviewList = (status: 'submitted' | 'approved' | 'rejected') => useQuery({
  queryKey: getTimesheetApprovalReviewListQueryKey(status),
  queryFn: () => timesheetApprovalService.getByStatus(status),
  staleTime: 30_000,
  placeholderData: previousData => previousData,
});
