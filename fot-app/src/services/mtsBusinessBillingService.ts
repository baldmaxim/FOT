import { apiClient } from '../api/client';

// Клиент вкладки «Финансы» модуля «МТС Бизнес» (баланс/начисления/неоплаченные).

export interface IMtsBusinessAccountMetrics {
  accountId: string;
  label: string;
  accountNumber: string | null;
  balance: number | null;
  creditLimit: number | null;
  unpaidAmount: number | null;
  capturedAt: string | null;
}

export interface IMtsBusinessEmployeeMetrics {
  employeeId: number | null;
  employeeFullName: string | null;
  employeeTabNumber: string | null;
  balance: number | null;
  chargesAmount: number | null;
  capturedAt: string | null;
}

export interface IMtsBusinessBillingSummary {
  accounts: IMtsBusinessAccountMetrics[];
  employees: IMtsBusinessEmployeeMetrics[];
}

export type MtsBusinessDailyMetric = 'balance' | 'credit_limit' | 'unpaid_amount' | 'charges_amount';

export interface IMtsBusinessTrendPoint {
  date: string;
  amount: number;
}

export interface IMtsBusinessRefreshResult {
  started: boolean;
  accounts: number;
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

export const mtsBusinessBillingService = {
  getSummary: async (): Promise<IMtsBusinessBillingSummary> => {
    const res = await apiClient.get<ApiResponse<IMtsBusinessBillingSummary>>('/mts-business/billing/summary');
    return res.data;
  },

  getTrend: async (metric: MtsBusinessDailyMetric, from: string, to: string, accountId?: string): Promise<IMtsBusinessTrendPoint[]> => {
    const qs = new URLSearchParams({ metric, from, to });
    if (accountId) qs.set('accountId', accountId);
    const res = await apiClient.get<ApiResponse<IMtsBusinessTrendPoint[]>>(`/mts-business/billing/trend?${qs.toString()}`);
    return res.data;
  },

  refresh: async (accountId?: string): Promise<IMtsBusinessRefreshResult> => {
    const res = await apiClient.post<ApiResponse<IMtsBusinessRefreshResult>>('/mts-business/billing/refresh', {
      accountId,
      confirmed: true,
    });
    return res.data;
  },
};
