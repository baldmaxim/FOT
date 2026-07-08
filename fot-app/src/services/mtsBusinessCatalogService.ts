import { apiClient } from '../api/client';

// Клиент каталога (тариф/услуги/остатки пакетов) — обогащение вкладки «Финансы».

export interface IMtsBusinessEmployeeCatalog {
  employeeId: number | null;
  employeeFullName: string | null;
  employeeTabNumber: string | null;
  tariffName: string | null;
  servicesCount: number;
  servicesMonthlyTotal: number;
  capturedAt: string | null;
}

export interface IMtsBusinessPackageCounter {
  unitOfMeasure: string | null;
  quota: number | null;
  remainder: number | null;
}

export interface IMtsBusinessAccountPackages {
  accountId: string;
  label: string;
  accountNumber: string | null;
  packages: IMtsBusinessPackageCounter[];
  capturedAt: string | null;
}

export interface IMtsBusinessCatalogRefreshResult {
  started: boolean;
  accounts: number;
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

export const mtsBusinessCatalogService = {
  getEmployeesCatalog: async (accountId?: string): Promise<IMtsBusinessEmployeeCatalog[]> => {
    const qs = new URLSearchParams();
    if (accountId) qs.set('accountId', accountId);
    const res = await apiClient.get<ApiResponse<IMtsBusinessEmployeeCatalog[]>>(`/mts-business/catalog/employees?${qs.toString()}`);
    return res.data;
  },

  getAccountsPackages: async (accountId?: string): Promise<IMtsBusinessAccountPackages[]> => {
    const qs = new URLSearchParams();
    if (accountId) qs.set('accountId', accountId);
    const suffix = qs.size > 0 ? `?${qs.toString()}` : '';
    const res = await apiClient.get<ApiResponse<IMtsBusinessAccountPackages[]>>(`/mts-business/catalog/accounts-packages${suffix}`);
    return res.data;
  },

  refresh: async (accountId?: string): Promise<IMtsBusinessCatalogRefreshResult> => {
    const res = await apiClient.post<ApiResponse<IMtsBusinessCatalogRefreshResult>>('/mts-business/catalog/refresh', {
      accountId,
      confirmed: true,
    });
    return res.data;
  },
};
