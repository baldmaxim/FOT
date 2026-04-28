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

export interface IBulkResult {
  processed_count: number;
  skipped_not_pending: number;
  skipped_no_access: number;
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

  async bulkApproveByIds(ids: number[]): Promise<IBulkResult> {
    const res = await apiClient.post<ApiResponse<IBulkResult>>(
      '/correction-approvals/bulk-approve-by-ids',
      { ids },
    );
    return res.data ?? { processed_count: 0, skipped_not_pending: 0, skipped_no_access: 0 };
  },

  async bulkRejectByIds(ids: number[], comment?: string): Promise<IBulkResult> {
    const res = await apiClient.post<ApiResponse<IBulkResult>>(
      '/correction-approvals/bulk-reject-by-ids',
      comment ? { ids, comment } : { ids },
    );
    return res.data ?? { processed_count: 0, skipped_not_pending: 0, skipped_no_access: 0 };
  },
};
