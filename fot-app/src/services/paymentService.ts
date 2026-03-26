import { apiClient } from '../api/client';

export type PaymentType = 'salary' | 'advance' | 'bonus' | 'vacation_pay' | 'sick_pay' | 'other';

export interface IPayment {
  id: number;
  organization_id: string;
  employee_id: number;
  payment_date: string;
  amount: number;
  payment_type: PaymentType;
  description: string | null;
  period: string | null;
  created_by: string;
  created_at: string;
}

export const PAYMENT_TYPE_LABELS: Record<PaymentType, string> = {
  salary: 'Зарплата',
  advance: 'Аванс',
  bonus: 'Премия',
  vacation_pay: 'Отпускные',
  sick_pay: 'Больничные',
  other: 'Другое',
};

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

export const paymentService = {
  getMy: async () => {
    const res = await apiClient.get<ApiResponse<IPayment[]>>('/payments/my');
    return res.data;
  },

  getByEmployee: async (empId: number) => {
    const res = await apiClient.get<ApiResponse<IPayment[]>>(`/payments/employee/${empId}`);
    return res.data;
  },

  create: async (data: {
    employee_id: number;
    payment_date: string;
    amount: number;
    payment_type: PaymentType;
    description?: string;
    period?: string;
  }) => {
    const res = await apiClient.post<ApiResponse<IPayment>>('/payments', data);
    return res.data;
  },
};
