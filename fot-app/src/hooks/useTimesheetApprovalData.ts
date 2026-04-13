import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { timesheetApprovalService, type TimesheetApprovalStatus } from '../services/timesheetApprovalService';
import { buildTimesheetApprovalPeriod } from '../utils/timesheetApprovalPeriod';

export const getTimesheetApprovalStatusQueryKey = (departmentId: string | null, period: string) => ['timesheet-approval', 'status', departmentId, period] as const;
export const getTimesheetApprovalReviewListQueryKey = (status: TimesheetApprovalStatus | 'submitted') => ['timesheet-approval', 'list', status] as const;
export const getTimesheetApprovalHistoryQueryKey = (approvalId: number | null) => ['timesheet-approval', 'history', approvalId] as const;
export const getTimesheetResponsiblesQueryKey = (departmentId: string | null) => ['timesheet-approval', 'responsibles', departmentId] as const;
export const getTimesheetResponsibleCandidatesQueryKey = (departmentId: string | null) => ['timesheet-approval', 'responsible-candidates', departmentId] as const;

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

export const useTimesheetApprovalHistory = (approvalId: number | null, enabled = true) => useQuery({
  queryKey: getTimesheetApprovalHistoryQueryKey(approvalId),
  queryFn: () => timesheetApprovalService.getHistory(approvalId as number),
  enabled: enabled && !!approvalId,
  staleTime: 30_000,
  placeholderData: previousData => previousData,
});

export const useTimesheetApprovalStatuses = (departmentId: string | null, month: string) => {
  const h1Query = useTimesheetApprovalStatus(departmentId, buildTimesheetApprovalPeriod(month, 'H1'));
  const h2Query = useTimesheetApprovalStatus(departmentId, buildTimesheetApprovalPeriod(month, 'H2'));

  const data = useMemo(() => ({
    H1: h1Query.data ?? null,
    H2: h2Query.data ?? null,
  }), [h1Query.data, h2Query.data]);

  return {
    data,
    isLoading: h1Query.isLoading || h2Query.isLoading,
  };
};
