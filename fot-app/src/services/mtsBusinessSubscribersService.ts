import { apiClient } from '../api/client';
import type { MtsSection } from './mtsBusinessTypes';
import type { IMtsSubServiceItem, IMtsSubForwardingRule, IMtsSubRoaming, IMtsSubDeliveryMethod, IMtsSubTariffFee } from './mtsBusinessSubscriberService';

// Вкладка «Абоненты МТС»: список/детали из БД (снапшоты полного профиля),
// точечный полный синк, живой каталог подключаемого, смена тарифа.
// Полный профиль ПДн (ФИО/ДР/паспорт) приходит в details.personalData —
// расшифровка pd_data_enc из кэша (без живого вызова); в списке его нет.

/** Документ пользователя номера (из identifiedBy[] PersonalDataInfo). */
export interface IMtsPdDocument {
  documentType: string | null;
  documentSeries: string | null;
  documentNo: string | null;
  issuedBy: string | null;
  issuedDate: string | null;
  issuingCountry: string | null;
}

/** Полный профиль ПДн абонента для карточки (адреса в ответе МТС нет). */
export interface IMtsPersonalDataFull {
  fullName: string | null;
  birthDate: string | null;
  confirmationStatus: string | null;
  documents: IMtsPdDocument[];
}

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
  departmentId: string | null;
  departmentName: string | null;
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
  charges: { amount: number; capturedAt: string | null } | null; // сумма за текущий месяц МСК
  tariff: { name: string | null; fee: IMtsSubTariffFee | null };
  services: IMtsSubServiceItem[];
  blocks: IMtsSubServiceItem[];
  forwarding: IMtsSubForwardingRule[];
  roaming: IMtsSubRoaming | null;
  deliveryMethod: IMtsSubDeliveryMethod[];
  payments: IMtsPaymentRow[];
  packages: IMtsPackageRow[];
  personalData: IMtsPersonalDataFull | null;
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

export interface IMtsUsageRow {
  date: string | null;
  category: string;
  label: string | null;
  networkEvent: string | null;
  direction: 'in' | 'out' | null;
  peer: string | null;
  peerName: string | null; // имя абонента из нашей базы, если собеседник известен
  units: number | null;
  unitCode: string | null;
  amount: number;
}

/** Итоги группы за период — SQL-агрегат бэкенда (getUsageTotals). */
export interface IUsageTotalsGroup {
  key: 'calls' | 'internet' | 'sms' | 'other';
  count: number;
  seconds: number;
  bytes: number;
  amount: number;
  inCount: number;
  inSeconds: number;
  outCount: number;
  outSeconds: number;
}

export interface IUsageTotals {
  groups: IUsageTotalsGroup[];
  total: number;
}

export interface IMtsUsageDay {
  date: string;
  events: number;
  calls: number;
  callsSeconds: number;
  smsCount: number;
  internetBytes: number;
  amount: number;
}

export interface IMtsUsageResult {
  month: string;
  rows?: IMtsUsageRow[];
  /** SQL-агрегат по ВСЕМ строкам периода — источник плиток и «Итого». */
  totals?: IUsageTotals;
  days?: IMtsUsageDay[];
  total?: number;
  /** Строки детализации обрезаны лимитом (сводки от этого не страдают). */
  truncated?: boolean;
  unavailable?: true;
  reason?: string;
}

export interface IMtsSubscriberSyncSectionError {
  section: string;
  status: number;
  code?: string;
  kind: 'transient' | 'failed';
}

export interface IMtsSubscriberSyncResult {
  msisdn: string;
  sections: number;
  stored: number;
  unavailable: number;
  failed: number;
  transient: number;
  errors: IMtsSubscriberSyncSectionError[];
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

  /** Период: месяц (YYYY-MM) или конкретный день (date=YYYY-MM-DD, приоритетнее месяца). */
  usage: async (msisdn: string, month: string, date?: string): Promise<IMtsUsageResult> => {
    const qs = new URLSearchParams(date ? { date } : { month });
    const res = await apiClient.get<ApiResponse<IMtsUsageResult>>(
      `/mts-business/subscribers/${encodeURIComponent(msisdn)}/usage?${qs.toString()}`,
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
