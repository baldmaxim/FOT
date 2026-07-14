import { apiClient } from '../api/client';
import type { IMtsUsageRow } from './mtsBusinessSubscribersService';
import type { IMtsSubTariffFee } from './mtsBusinessSubscriberService';

// ЛК сотрудника: «Моя SIM» (/my-sim — данные только по своим номерам, из БД,
// без ПДн и баланса ЛС) и «Телефонная книга» (/phonebook).

export interface IMySimNumber {
  msisdn: string;
  tariff: { name: string | null; fee: IMtsSubTariffFee | null };
  charges: { amount: number; capturedAt: string | null } | null;
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
  total: number;
  days: IUsageDayStat[];
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
};
