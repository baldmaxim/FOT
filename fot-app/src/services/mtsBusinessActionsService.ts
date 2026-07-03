import { apiClient } from '../api/client';

// Клиент управляющих действий (Фаза 3): добавить/удалить услугу или
// добровольную блокировку, правила корп.бюджета. Асинхронно — ответ eventId,
// статус отслеживается через список заявок (getActions).

export interface IMtsBusinessBudgetRule {
  productCode: string | null;
  productVersionId: string | null;
  title: string | null;
  subTitle: string | null;
  limitValue: string | null;
  activeFrom: string | null;
  activeTo: string | null;
}

export interface IMtsBusinessAvailableBudgetRule {
  productCode: string | null;
  productName: string | null;
  title: string | null;
  subTitle: string | null;
  productVersionId: string | null;
  availableLimitValues: boolean;
}

export interface IMtsBusinessActionRow {
  eventId: string;
  accountId: string | null;
  scope: string;
  actionType: string;
  status: string;
  requestedAt: string;
  checkedAt: string | null;
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

export const mtsBusinessActionsService = {
  modifyService: async (input: {
    accountId: string; msisdn: string; externalID: string; kind: 'service' | 'block'; mode: 'add' | 'remove';
  }): Promise<{ eventId: string }> => {
    const res = await apiClient.post<ApiResponse<{ eventId: string }>>('/mts-business/catalog/services', {
      ...input,
      confirmed: true,
    });
    return res.data;
  },

  getActions: async (): Promise<IMtsBusinessActionRow[]> => {
    const res = await apiClient.get<ApiResponse<IMtsBusinessActionRow[]>>('/mts-business/actions');
    return res.data;
  },

  getRulesByMsisdn: async (accountId: string, msisdn: string): Promise<IMtsBusinessBudgetRule[]> => {
    const qs = new URLSearchParams({ accountId, msisdn });
    const res = await apiClient.get<ApiResponse<IMtsBusinessBudgetRule[]>>(`/mts-business/budget/rules?${qs.toString()}`);
    return res.data;
  },

  getAvailableRules: async (accountId: string, accountNo: string): Promise<IMtsBusinessAvailableBudgetRule[]> => {
    const qs = new URLSearchParams({ accountId, accountNo });
    const res = await apiClient.get<ApiResponse<IMtsBusinessAvailableBudgetRule[]>>(`/mts-business/budget/available-rules?${qs.toString()}`);
    return res.data;
  },

  addRule: async (input: {
    accountId: string; msisdn: string; productCode: string; productVersionId: string; limitValue?: string;
  }): Promise<{ eventId: string }> => {
    const res = await apiClient.post<ApiResponse<{ eventId: string }>>('/mts-business/budget/rules', {
      ...input,
      confirmed: true,
    });
    return res.data;
  },

  removeRule: async (input: {
    accountId: string; msisdn: string; productCode: string; productVersionId: string;
  }): Promise<{ eventId: string }> => {
    const res = await apiClient.post<ApiResponse<{ eventId: string }>>('/mts-business/budget/rules/remove', {
      ...input,
      confirmed: true,
    });
    return res.data;
  },
};
