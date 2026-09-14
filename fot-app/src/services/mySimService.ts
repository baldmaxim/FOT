import { apiClient } from '../api/client';
import type { IMtsUsageRow, IUsageTotals, IMtsPackageRow } from './mtsBusinessSubscribersService';
import type { IMtsSubTariffFee } from './mtsBusinessSubscriberService';

// ЛК сотрудника: «Моя SIM» (/my-sim — данные только по своим номерам, из БД,
// без ПДн и баланса ЛС) и «Телефонная книга» (/phonebook).

export interface IMySimNumber {
  msisdn: string;
  tariff: { name: string | null; fee: IMtsSubTariffFee | null };
  charges: { amount: number; capturedAt: string | null } | null;
  packages: IMtsPackageRow[]; // остатки пакетов по номеру (минуты/SMS/интернет)
  capturedAt: string | null;
  months: string[]; // месяцы, за которые в БД есть выписка (YYYY-MM, свежие сверху)
}

export interface IUsageDayStat {
  date: string; // YYYY-MM-DD
  events: number;
  calls: number;
  callsSeconds: number;
  smsCount: number;
  internetBytes: number;
  amount: number;
}

export interface IMySimUsageNumber {
  msisdn: string;
  rows: IMtsUsageRow[];
  /** Итог по SQL-агрегату периода (не по обрезанным лимитом строкам). */
  total: number;
  days: IUsageDayStat[];
  /** Сводка по группам — тот же агрегат, что у админской вкладки «Абоненты». */
  totals: IUsageTotals;
  /** Строки детализации обрезаны лимитом сервера (на сводки не влияет). */
  truncated?: boolean;
}

export interface IMySimUsageResult {
  month: string;
  numbers: IMySimUsageNumber[];
}

export interface IPhonebookRow {
  msisdn: string | null;
  employeeId: number;
  fullName: string;
  positionName: string | null;
  departmentName: string | null;
}

/** Тип правила: всегда / нет ответа (таймер) / недоступен. CFB (занято) — не поддерживаем. */
export type ForwardingType = 'CFU' | 'CFNRY' | 'CFNRC';

export interface IForwardingRule {
  forwardingType: string | null;
  forwardingAddress: string | null;
  noReplyTimer: number | null;
  numType: string | null;
  status: string | null;
}

export interface IMyForwardingNumber {
  msisdn: string;
  rules: IForwardingRule[];
  capturedAt: string | null;
}

/**
 * Серверная операция переадресации: включение/смена режима (kind=set) — при
 * необходимости портал сам подключает услугу «Переадресация вызова», снимает
 * мешающие правила и ставит выбранное; отключение (kind=remove) снимает все правила.
 */
export type ForwardingOperationState =
  | 'service_reserved' | 'service_sending' | 'service_accepted' | 'service_unknown'
  | 'rule_ready' | 'rule_sending' | 'rule_verifying' | 'rule_confirmed'
  | 'rule_clear_sending' | 'rule_clear_verifying'
  | 'unconfirmed' | 'done' | 'failed' | 'cancelled' | 'expired';

export interface IForwardingOperation {
  id: string;
  kind: 'set' | 'remove';
  state: ForwardingOperationState;
  final: boolean;
  type: ForwardingType;
  targetTail: string | null;
  timer: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: string;
}

export interface IMyForwardingChangeResult {
  outcome: 'applied' | 'operation_pending' | 'operation_failed';
  operationId: string;
  state: ForwardingOperationState;
  operation: IForwardingOperation;
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

export const mySimService = {
  /** Номера сотрудника — для строки «Телефон» в блоке «Информация». */
  getNumbers: async (): Promise<string[]> => {
    const res = await apiClient.get<ApiResponse<{ numbers: string[] }>>('/my-sim/numbers');
    return res.data.numbers;
  },

  getMySim: async (): Promise<IMySimNumber[]> => {
    const res = await apiClient.get<ApiResponse<{ numbers: IMySimNumber[] }>>('/my-sim');
    return res.data.numbers;
  },

  /** Период: месяц (YYYY-MM) или конкретный день (date=YYYY-MM-DD, приоритетнее месяца). */
  getUsage: async (month: string, date?: string): Promise<IMySimUsageResult> => {
    const qs = new URLSearchParams(date ? { date } : { month });
    const res = await apiClient.get<ApiResponse<IMySimUsageResult>>(`/my-sim/usage?${qs.toString()}`);
    return res.data;
  },

  getPhonebook: async (): Promise<IPhonebookRow[]> => {
    const res = await apiClient.get<ApiResponse<{ rows: IPhonebookRow[] }>>('/phonebook');
    return res.data.rows;
  },

  /** Переадресация: текущие правила по своим номерам (из ночного снапшота). */
  getForwarding: async (): Promise<IMyForwardingNumber[]> => {
    const res = await apiClient.get<ApiResponse<{ numbers: IMyForwardingNumber[] }>>('/my-sim/forwarding');
    return res.data.numbers;
  },

  /** Включить/сменить режим: applied — режим подтверждён; operation_pending — доводится на сервере. */
  setForwarding: async (input: { msisdn: string; type: ForwardingType; target: string; timer?: number }): Promise<IMyForwardingChangeResult> => {
    const res = await apiClient.post<ApiResponse<IMyForwardingChangeResult>>('/my-sim/forwarding', input);
    return res.data;
  },

  /** Операция переадресации по номеру: незавершённая или последняя за сутки. */
  getForwardingOperation: async (msisdn: string): Promise<IForwardingOperation | null> => {
    const res = await apiClient.get<ApiResponse<IForwardingOperation | null>>(
      `/my-sim/forwarding/operation?msisdn=${encodeURIComponent(msisdn)}`,
    );
    return res.data;
  },

  /** Отключить переадресацию — та же серверная операция, исход как у setForwarding. */
  deleteForwarding: async (input: { msisdn: string; type: ForwardingType }): Promise<IMyForwardingChangeResult> => {
    const res = await apiClient.post<ApiResponse<IMyForwardingChangeResult>>('/my-sim/forwarding/delete', input);
    return res.data;
  },
};
