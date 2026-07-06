import { apiClient } from '../api/client';
import type { MtsSection } from './mtsBusinessTypes';
import type { IMtsSubServiceItem, IMtsSubForwardingRule, IMtsSubRoaming, IMtsSubDeliveryMethod, IMtsSubTariffFee } from './mtsBusinessSubscriberService';

// Вкладка «Абоненты МТС»: список/детали из БД (снапшоты полного профиля),
// точечный полный синк, живой каталог подключаемого, смена тарифа.
// Особые данные (паспорт и пр.) бэкенд НЕ отдаёт — только ФИО и статус.

export interface IMtsSubscriberRow {
  msisdn: string | null;
  accountId: string | null;
  accountLabel: string | null;
  mtsFio: string | null;
  mtsComment: string | null;
  pdStatus: string | null;
  pdSyncedAt: string | null;
  employeeId: number | null;
  employeeFullName: string | null;
  employeeTabNumber: string | null;
  calls: number;
  totalSeconds: number;
  lastCallAt: string | null;
  balance: number | null;
  chargesAmount: number | null;
  tariffName: string | null;
  servicesCount: number;
  servicesMonthlyTotal: number;
  capturedAt: string | null;
}

export interface IMtsPaymentRow {
  date: string | null;
  amount: number | null;
  method: string | null;
  currencyCode: string | null;
}

export interface IMtsPackageRow {
  unitOfMeasure: string | null;
  quota: number | null;
  remainder: number | null;
}

export interface IMtsSubscriberDetails {
  msisdn: string;
  accountId: string;
  balance: { amount: number; capturedAt: string } | null;
  charges: { amount: number; capturedAt: string } | null;
  tariff: { name: string | null; fee: IMtsSubTariffFee | null };
  services: IMtsSubServiceItem[];
  blocks: IMtsSubServiceItem[];
  forwarding: IMtsSubForwardingRule[];
  roaming: IMtsSubRoaming | null;
  deliveryMethod: IMtsSubDeliveryMethod[];
  payments: IMtsPaymentRow[];
  packages: IMtsPackageRow[];
  capturedAt: string | null;
}

export interface IMtsAvailableTariffRow {
  tariffId: string | null;
  name: string | null;
  price: number | null;
}

export interface IMtsSubscriberAvailable {
  accountId: string;
  services: MtsSection<IMtsSubServiceItem[]>;
  blocks: MtsSection<IMtsSubServiceItem[]>;
  tariffs: MtsSection<IMtsAvailableTariffRow[]>;
}

export interface IMtsSubscriberSyncResult {
  msisdn: string;
  sections: number;
  stored: number;
  unavailable: number;
  failed: number;
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

export const mtsBusinessSubscribersService = {
  list: async (): Promise<IMtsSubscriberRow[]> => {
    const res = await apiClient.get<ApiResponse<IMtsSubscriberRow[]>>('/mts-business/subscribers');
    return res.data;
  },

  details: async (msisdn: string): Promise<IMtsSubscriberDetails> => {
    const res = await apiClient.get<ApiResponse<IMtsSubscriberDetails>>(
      `/mts-business/subscribers/${encodeURIComponent(msisdn)}/details`,
    );
    return res.data;
  },

  available: async (msisdn: string): Promise<IMtsSubscriberAvailable> => {
    const res = await apiClient.get<ApiResponse<IMtsSubscriberAvailable>>(
      `/mts-business/subscribers/${encodeURIComponent(msisdn)}/available`,
    );
    return res.data;
  },

  refreshOne: async (msisdn: string): Promise<IMtsSubscriberSyncResult> => {
    const res = await apiClient.post<ApiResponse<IMtsSubscriberSyncResult>>(
      `/mts-business/subscribers/${encodeURIComponent(msisdn)}/refresh`, { confirmed: true },
    );
    return res.data;
  },

  changeTariff: async (input: { accountId?: string; msisdn: string; externalID: string }): Promise<{ eventId: string }> => {
    const res = await apiClient.post<ApiResponse<{ eventId: string }>>('/mts-business/subscribers/tariff', {
      ...input, confirmed: true,
    });
    return res.data;
  },
};
