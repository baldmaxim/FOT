import { apiClient } from '../api/client';

// Клиент модуля «МТС Бизнес» (детализация звонков, время разговоров).
// Мультиаккаунт: несколько API/лицевых счетов. Бэкенд отдаёт { success, data }.

export interface IMtsBusinessAccount {
  id: string;
  label: string;
  accountNumber: string | null;
  login: string;
  baseUrl: string;
  isActive: boolean;
  hasPassword: boolean;
  rateLimitPerMin: number;
  createdAt: string;
  updatedAt: string;
}

export interface IMtsBusinessFetchSyncFailedRow {
  msisdn: string;
  reason: 'MTS_FEATURE_NOT_CONNECTED' | 'MTS_ERROR';
  mtsHttp?: number;
}

export interface IMtsBusinessFetchSyncResult {
  requestedNumbers: number;
  parsed: number;
  inserted: number;
  skipped: number;
  failedNumbers: string[];
  failed?: IMtsBusinessFetchSyncFailedRow[];
}

export interface IMtsBusinessRequestRow {
  messageId: string;
  accountId: string | null;
  scope: string;
  targetCount: number;
  dateFrom: string;
  dateTo: string;
  status: string;
  requestedAt: string;
  checkedAt: string | null;
}

export interface IMtsBusinessNumberMapRow {
  msisdn: string | null;
  employeeId: number | null;
  employeeFullName: string | null;
  employeeTabNumber: string | null;
  linkedAt: string | null;
}

export interface IMtsAutoLinkConflict {
  msisdn: string;
  mtsFio: string;
  currentEmployeeId: number | null;
  currentEmployeeName: string | null;
  reason: 'ambiguous' | 'no_match';
  candidates: Array<{ id: number; fullName: string; tabNumber: string | null }>;
}

export interface IMtsAutoLinkResult {
  checked: number;
  linked: number;
  relinked: number;
  cleared: number;
  conflicts: IMtsAutoLinkConflict[];
}

export interface IMtsBusinessImportedNumberRow {
  msisdn: string | null;
  calls: number;
  totalSeconds: number;
  lastCallAt: string | null;
  mtsFio: string | null;
  mtsComment: string | null;
  pdStatus: string | null;
  employeeId: number | null;
  employeeFullName: string | null;
  employeeTabNumber: string | null;
  accountId: string | null;
}

export interface IMtsBusinessTalkTimeRow {
  employeeId: number | null;
  employeeFullName: string | null;
  employeeTabNumber: string | null;
  calls: number;
  totalSeconds: number;
  inSeconds: number;
  outSeconds: number;
}

export interface IMtsBusinessAccountSummaryRow {
  accountId: string | null;
  label: string | null;
  accountNumber: string | null;
  calls: number;
  totalSeconds: number;
  numbers: number;
}

export interface IMtsBusinessUploadResult {
  parsed: number;
  inserted: number;
  skipped: number;
  mtsNames?: number;
  autoLinked?: number;
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

export const mtsBusinessService = {
  // === Аккаунты ===
  listAccounts: async (): Promise<IMtsBusinessAccount[]> => {
    const res = await apiClient.get<ApiResponse<IMtsBusinessAccount[]>>('/mts-business/accounts');
    return res.data;
  },

  createAccount: async (data: {
    label: string; accountNumber?: string; login: string; password: string; baseUrl?: string; rateLimitPerMin?: number;
  }): Promise<IMtsBusinessAccount[]> => {
    const res = await apiClient.post<ApiResponse<IMtsBusinessAccount[]>>('/mts-business/accounts', data);
    return res.data;
  },

  updateAccount: async (id: string, data: {
    label?: string; accountNumber?: string | null; login?: string; password?: string; baseUrl?: string | null; isActive?: boolean; rateLimitPerMin?: number;
  }): Promise<IMtsBusinessAccount[]> => {
    const res = await apiClient.put<ApiResponse<IMtsBusinessAccount[]>>(`/mts-business/accounts/${id}`, data);
    return res.data;
  },

  deleteAccount: async (id: string): Promise<IMtsBusinessAccount[]> => {
    const res = await apiClient.delete<ApiResponse<IMtsBusinessAccount[]>>(`/mts-business/accounts/${id}`);
    return res.data;
  },

  testAccount: async (id: string): Promise<{ ok: boolean; error?: string; mtsHttp?: number }> => {
    const res = await apiClient.post<ApiResponse<{ ok: boolean; error?: string; mtsHttp?: number }>>(
      `/mts-business/accounts/${id}/test`, {},
    );
    return res.data;
  },

  // === Заказ детализации ===
  orderDetalization: async (input: {
    accountId: string;
    scope: 'msisdn' | 'account';
    targets: string[];
    dateFrom: string;
    dateTo: string;
    deliveryAddress: string;
  }): Promise<{ messageId: string }> => {
    const res = await apiClient.post<ApiResponse<{ messageId: string }>>('/mts-business/detalization/order', {
      ...input,
      confirmed: true,
    });
    return res.data;
  },

  // Синхронный бэкафилл за произвольный период (без email/заявки, Bills API).
  fetchSyncDetalization: async (input: {
    accountId: string; msisdns: string[]; dateFrom: string; dateTo: string;
  }): Promise<IMtsBusinessFetchSyncResult> => {
    const res = await apiClient.post<ApiResponse<IMtsBusinessFetchSyncResult>>('/mts-business/detalization/fetch-sync', input);
    return res.data;
  },

  listRequests: async (): Promise<IMtsBusinessRequestRow[]> => {
    const res = await apiClient.get<ApiResponse<IMtsBusinessRequestRow[]>>('/mts-business/detalization/requests');
    return res.data;
  },

  refreshStatus: async (messageId: string): Promise<{ messageId: string; status: string }> => {
    const res = await apiClient.post<ApiResponse<{ messageId: string; status: string }>>(
      `/mts-business/detalization/requests/${encodeURIComponent(messageId)}/refresh-status`, {},
    );
    return res.data;
  },

  uploadDetalization: async (file: File, opts: { accountId?: string; sourceMessageId?: string; msisdn?: string } = {}): Promise<IMtsBusinessUploadResult> => {
    const form = new FormData();
    form.append('file', file);
    if (opts.accountId) form.append('accountId', opts.accountId);
    if (opts.sourceMessageId) form.append('sourceMessageId', opts.sourceMessageId);
    if (opts.msisdn) form.append('msisdn', opts.msisdn);
    // Файлы детализации до 300 МБ: дефолтный таймаут клиента (30с) оборвёт
    // передачу — даём 10 минут на аплоад + серверный парсинг.
    const res = await apiClient.post<ApiResponse<IMtsBusinessUploadResult>>(
      '/mts-business/detalization/upload', form, { timeoutMs: 600_000 },
    );
    return res.data;
  },

  /** Число CDR-записей, загруженных из файлов вручную (метка 'upload:%'). */
  getUploadsCount: async (): Promise<{ count: number }> => {
    const res = await apiClient.get<ApiResponse<{ count: number }>>('/mts-business/detalization/uploads/count');
    return res.data;
  },

  /** Отладочная очистка ручных загрузок XML/XLS (API-записи не задеваются). */
  clearUploads: async (): Promise<{ deleted: number }> => {
    const res = await apiClient.delete<ApiResponse<{ deleted: number }>>(
      '/mts-business/detalization/uploads', { body: JSON.stringify({ confirmed: true }) },
    );
    return res.data;
  },

  // === Привязка номеров ===
  getNumberMap: async (): Promise<IMtsBusinessNumberMapRow[]> => {
    const res = await apiClient.get<ApiResponse<IMtsBusinessNumberMapRow[]>>('/mts-business/number-map');
    return res.data;
  },

  getImportedNumbers: async (): Promise<IMtsBusinessImportedNumberRow[]> => {
    const res = await apiClient.get<ApiResponse<IMtsBusinessImportedNumberRow[]>>('/mts-business/number-map/imported');
    return res.data;
  },

  setNumberMap: async (data: { msisdn: string; employeeId: number | null }): Promise<IMtsBusinessNumberMapRow[]> => {
    const res = await apiClient.put<ApiResponse<IMtsBusinessNumberMapRow[]>>('/mts-business/number-map', data);
    return res.data;
  },

  autoLinkNumberMap: async (): Promise<IMtsAutoLinkResult> => {
    const res = await apiClient.post<ApiResponse<IMtsAutoLinkResult>>('/mts-business/number-map/auto-link', {});
    return res.data;
  },

  // === Отчёт / дашборд ===
  getTalkTimeReport: async (from: string, to: string, accountId?: string): Promise<IMtsBusinessTalkTimeRow[]> => {
    const qs = new URLSearchParams({ from, to });
    if (accountId) qs.set('accountId', accountId);
    const res = await apiClient.get<ApiResponse<IMtsBusinessTalkTimeRow[]>>(`/mts-business/report/talk-time?${qs.toString()}`);
    return res.data;
  },

  getAccountsSummary: async (from: string, to: string, accountId?: string): Promise<IMtsBusinessAccountSummaryRow[]> => {
    const qs = new URLSearchParams({ from, to });
    if (accountId) qs.set('accountId', accountId);
    const res = await apiClient.get<ApiResponse<IMtsBusinessAccountSummaryRow[]>>(`/mts-business/report/accounts-summary?${qs.toString()}`);
    return res.data;
  },
};
