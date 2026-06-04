import { apiClient } from '../api/client';

export interface ITimesheetReviewStatus {
  checked: boolean;
  checked_by: string | null;
  checked_by_name: string | null;
  checked_at: string | null;
}

export interface ITimesheetReviewedDepartment {
  department_id: string;
  checked_by_name: string | null;
  checked_at: string;
}

interface ApiResponse<T> {
  data: T;
  message?: string;
}

export const timesheetReviewService = {
  getStatus: async (departmentId: string, startDate: string, endDate: string) => {
    const params = new URLSearchParams({
      department_id: departmentId,
      start_date: startDate,
      end_date: endDate,
    });
    const res = await apiClient.get<ApiResponse<ITimesheetReviewStatus>>(`/timesheet-approvals/review?${params.toString()}`);
    return res.data;
  },
  setStatus: async (departmentId: string, startDate: string, endDate: string, checked: boolean) => {
    const res = await apiClient.post<ApiResponse<ITimesheetReviewStatus>>('/timesheet-approvals/review', {
      department_id: departmentId,
      start_date: startDate,
      end_date: endDate,
      checked,
    });
    return res.data;
  },
  listReviewedDepartments: async (startDate: string, endDate: string) => {
    const params = new URLSearchParams({ start_date: startDate, end_date: endDate });
    const res = await apiClient.get<ApiResponse<ITimesheetReviewedDepartment[]>>(`/timesheet-approvals/reviewed-departments?${params.toString()}`);
    return res.data;
  },
};
