import { apiClient } from '../api/client';
import type { MtsSection } from './mtsBusinessTypes';

// Карточка номера (read-only) — собирает по одному MSISDN всё, что отдаёт
// MTS Business API. Каждая секция (кроме identity) — дискриминированное
// объединение: данные / «нет в тарифе» / ошибка (карточка не падает целиком).

export type { MtsSection } from './mtsBusinessTypes';

export interface IMtsSubIdentity {
  msisdn: string;
  fio: string | null;
  employeeId: number | null;
  employeeFullName: string | null;
  employeeTabNumber: string | null;
  accountNo: string | null;
  contractId: string | null;
  organizationName: string | null;
  region: string | null;
  imsi: string | null;
  sim: string | null;
  iccid: string | null;
  inn: string | null;
  kpp: string | null;
  stale: boolean;
  capturedAt: string | null;
}

export interface IMtsSubBalance {
  amount: number | null;
  creditLimit: number | null;
  currencyCode: string | null;
  validUntil: string | null;
}

export interface IMtsSubServiceItem {
  code: string | null;
  name: string | null;
  status: string | null;
  monthlyAmount: number | null;
  currencyCode: string | null;
  startDateTime: string | null;
  endDateTime: string | null;
}

export interface IMtsSubTariffFee {
  amount: number | null;
  currencyCode: string | null;
}

export interface IMtsSubTariff {
  name: string | null;
  fee: IMtsSubTariffFee | null;
}

export interface IMtsSubForwardingRule {
  forwardingType: string | null;
  forwardingAddress: string | null;
  noReplyTimer: number | null;
  numType: string | null;
  status: string | null;
}

/**
 * Типы переадресации, которыми УМЕЕМ управлять (МТС может вернуть и CFB —
 * показываем, но не редактируем). Совпадает с FORWARDING_TYPES на бэкенде.
 */
export const MTS_FORWARDING_TYPES = ['CFU', 'CFNRY', 'CFNRC'] as const;

export type MtsForwardingType = (typeof MTS_FORWARDING_TYPES)[number];

/** Таймер «нет ответа» по умолчанию, сек (только CFNRY). */
export const MTS_DEFAULT_NO_REPLY_TIMER = 20;

/**
 * Исход мутации переадресации — один контракт для админки и ЛК «Моя SIM»:
 *  - queued  — МТС принял заявку, статус доедет поллингом по eventId;
 *  - applied — правило уже применено (контур применяет синхронно), ждать нечего;
 *  - unknown — МТС ответил, но исход не подтверждён: повторять операцию НЕЛЬЗЯ,
 *    нужно обновить состояние позже.
 * tracking:false — в МТС применено, но локальная запись в портале не сохранилась.
 */
export interface IForwardingResult {
  outcome: 'queued' | 'applied' | 'unknown';
  eventId: string | null;
  tracking: boolean;
}

export const isMtsForwardingType = (v: string | null | undefined): v is MtsForwardingType =>
  v != null && (MTS_FORWARDING_TYPES as readonly string[]).includes(v);

/** Активное правило = первое с управляемым типом и непустым адресом (МТС отдаёт и заглушки). */
export const pickMtsForwardingRule = (
  rules: IMtsSubForwardingRule[] | null | undefined,
): IMtsSubForwardingRule | null =>
  rules?.find(r => isMtsForwardingType(r.forwardingType) && Boolean(r.forwardingAddress)) ?? null;

export interface IMtsSubRoaming {
  countryId: string | null;
  countryName: string | null;
  isInternational: boolean;
}

export interface IMtsSubDeliveryMethod {
  method: string | null;
  address: string | null;
  documentFormat: string | null;
}

export interface IMtsSubCharge {
  msisdn: string;
  amount: number | null;
  periodStart: string | null;
  periodEnd: string | null;
}

export interface IMtsSubscriberCard {
  identity: IMtsSubIdentity;
  balance: MtsSection<IMtsSubBalance>;
  tariff: MtsSection<IMtsSubTariff>;
  connectedServices: MtsSection<IMtsSubServiceItem[]>;
  availableServices: MtsSection<IMtsSubServiceItem[]>;
  connectedBlocks: MtsSection<IMtsSubServiceItem[]>;
  availableBlocks: MtsSection<IMtsSubServiceItem[]>;
  forwarding: MtsSection<IMtsSubForwardingRule[]>;
  roaming: MtsSection<IMtsSubRoaming>;
  deliveryMethod: MtsSection<IMtsSubDeliveryMethod[]>;
  currentCharges: MtsSection<IMtsSubCharge | null>;
}

export type MtsExpenseCategory = 'calls' | 'sms' | 'internet' | 'periodic' | 'oneTime' | 'topups' | 'other';
export interface IMtsExpenseBucket {
  count: number;
  amount: number;
}
export interface IMtsMonthExpenses {
  month: string;
  summary: Record<MtsExpenseCategory, IMtsExpenseBucket> & { total: number };
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

export const mtsBusinessSubscriberService = {
  getCard: async (msisdn: string): Promise<IMtsSubscriberCard> => {
    const res = await apiClient.get<ApiResponse<IMtsSubscriberCard>>(`/mts-business/subscriber/${encodeURIComponent(msisdn)}/card`);
    return res.data;
  },

  getExpenses: async (msisdn: string, month: string): Promise<IMtsMonthExpenses> => {
    const res = await apiClient.get<ApiResponse<IMtsMonthExpenses>>(
      `/mts-business/subscriber/${encodeURIComponent(msisdn)}/expenses?month=${encodeURIComponent(month)}`,
    );
    return res.data;
  },
};
