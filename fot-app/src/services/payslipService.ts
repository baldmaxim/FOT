import { apiClient } from '../api/client';

export interface IPayslip {
  id: number;
  organization_id: string;
  employee_id: number;
  period: string;
  gross_amount: number | null;
  net_amount: number | null;
  deductions: number | null;
  details: Record<string, unknown> | null;
  document_id: number | null;
  created_by: string;
  created_at: string;
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

export const payslipService = {
  getMy: async () => {
    const res = await apiClient.get<ApiResponse<IPayslip[]>>('/payslips/my');
    return res.data;
  },

  getByEmployee: async (empId: number) => {
    const res = await apiClient.get<ApiResponse<IPayslip[]>>(`/payslips/employee/${empId}`);
    return res.data;
  },

  create: async (data: {
    employee_id: number;
    period: string;
    gross_amount?: number;
    net_amount?: number;
    deductions?: number;
  }) => {
    const res = await apiClient.post<ApiResponse<IPayslip>>('/payslips', data);
    return res.data;
  },

  importBatch: async (items: Array<{
    employee_id: number;
    period: string;
    gross_amount?: number;
    net_amount?: number;
    deductions?: number;
  }>) => {
    const res = await apiClient.post<ApiResponse<{ imported: number }>>('/payslips/import', { items });
    return res.data;
  },
};
