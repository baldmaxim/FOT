import { useQuery } from '@tanstack/react-query';
import { documentService } from '../services/documentService';
import { leaveRequestService, type LeaveRequestStatus } from '../services/leaveRequestService';
import { paymentService } from '../services/paymentService';
import { payslipService } from '../services/payslipService';
import { employeeService } from '../services/employeeService';
import { dailyTaskService } from '../services/dailyTaskService';

export const getMyPayslipsQueryKey = () => ['my-payslips'] as const;
export const getMyPaymentsQueryKey = () => ['my-payments'] as const;
export const getMyDocumentsQueryKey = () => ['my-documents'] as const;
export const getMyLeaveRequestsQueryKey = () => ['my-leave-requests'] as const;
export const getLeaveRequestsManageQueryKey = (scope: 'department' | 'all', filter: 'pending' | 'all') => ['leave-requests-manage', scope, filter] as const;
export const getEmployeeHistoryQueryKey = (employeeId: number | null) => ['employee-history', employeeId] as const;
export const getMyDailyTasksQueryKey = () => ['my-daily-tasks'] as const;
export const getTodayDailyTaskQueryKey = () => ['today-daily-task'] as const;

export const useMyPayslips = () => useQuery({
  queryKey: getMyPayslipsQueryKey(),
  queryFn: () => payslipService.getMy(),
  staleTime: 5 * 60_000,
});

export const useMyPayments = () => useQuery({
  queryKey: getMyPaymentsQueryKey(),
  queryFn: () => paymentService.getMy(),
  staleTime: 5 * 60_000,
});

export const useMyDocuments = () => useQuery({
  queryKey: getMyDocumentsQueryKey(),
  queryFn: () => documentService.getMy(),
  staleTime: 60_000,
});

export const useMyLeaveRequests = () => useQuery({
  queryKey: getMyLeaveRequestsQueryKey(),
  queryFn: () => leaveRequestService.getMy(),
  staleTime: 30_000,
});

export const useLeaveRequestsManage = (
  scope: 'department' | 'all',
  filter: 'pending' | 'all',
) => useQuery({
  queryKey: getLeaveRequestsManageQueryKey(scope, filter),
  queryFn: () => (
    scope === 'department'
      ? leaveRequestService.getDepartment()
      : leaveRequestService.getAll(filter === 'pending' ? 'pending' : undefined)
  ),
  staleTime: 30_000,
  placeholderData: previousData => previousData,
});

export const useMyDailyTasks = () => useQuery({
  queryKey: getMyDailyTasksQueryKey(),
  queryFn: () => dailyTaskService.getMy(),
  staleTime: 30_000,
});

export const useTodayDailyTask = () => useQuery({
  queryKey: getTodayDailyTaskQueryKey(),
  queryFn: () => dailyTaskService.getToday(),
  staleTime: 30_000,
});

export const useEmployeeHistory = (employeeId: number | null, enabled = true) => useQuery({
  queryKey: getEmployeeHistoryQueryKey(employeeId),
  queryFn: () => employeeService.getHistory(employeeId as number),
  enabled: enabled && !!employeeId,
  staleTime: 5 * 60_000,
});

export const invalidateLeaveRequestsManageQueryKey = (
  scope: 'department' | 'all',
  filter: 'pending' | 'all',
) => getLeaveRequestsManageQueryKey(scope, filter);

export const getLeaveRequestListStatus = (filter: 'pending' | 'all'): LeaveRequestStatus | undefined => (
  filter === 'pending' ? 'pending' : undefined
);
