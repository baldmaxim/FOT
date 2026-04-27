import { apiClient } from '../api/client';

export interface ICorrectionPendingItem {
  id: number;
  employee_id: number;
  employee_name: string | null;
  work_date: string;
  status: string;
  hours_override: number | null;
  notes: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
}

export interface ICorrectionDepartmentGroup {
  department_id: string;
  department_name: string;
  pending_count: number;
  employees_count: number;
  items: ICorrectionPendingItem[];
}

interface ApiResponse<T> {
  data: T;
  message?: string;
}

export const correctionApprovalService = {
  async getPendingByDepartment(startDate: string, endDate: string): Promise<ICorrectionDepartmentGroup[]> {
    const params = new URLSearchParams({ start_date: startDate, end_date: endDate });
    const res = await apiClient.get<ApiResponse<ICorrectionDepartmentGroup[]>>(
      `/correction-approvals/pending-by-department?${params.toString()}`,
    );
    return res.data ?? [];
  },

  async approve(id: number): Promise<void> {
    await apiClient.post(`/correction-approvals/${id}/approve`, {});
  },

  async reject(id: number, comment?: string): Promise<void> {
    await apiClient.post(`/correction-approvals/${id}/reject`, comment ? { comment } : {});
  },

  async bulkApprove(departmentId: string, startDate: string, endDate: string): Promise<{ approved_count: number }> {
    const res = await apiClient.post<ApiResponse<{ approved_count: number }>>(
      '/correction-approvals/bulk-approve',
      { department_id: departmentId, start_date: startDate, end_date: endDate },
    );
    return res.data ?? { approved_count: 0 };
  },
};
