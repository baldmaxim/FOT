import { apiClient } from '../api/client';

interface IApiResponse<T> {
  success: boolean;
  data: T;
}

export interface ISigurCardSummary {
  cardId: number;
  cardNumber: string | null;
  status: string | null;
  format: string | null;
  startDate: string | null;
  expirationDate: string | null;
}

export interface ISigurCardEmployee {
  id: number;
  full_name: string;
  position_name: string | null;
  department: string | null;
  tab_number: string | null;
  sigur_employee_id: number | null;
}

export interface ICardLookupFound {
  found: true;
  uid: string;
  card: ISigurCardSummary;
  sigurEmployeeId: number | null;
  employee: ISigurCardEmployee | null;
}

export interface ICardLookupMissing {
  found: false;
  uid: string;
}

export type CardLookupResult = ICardLookupFound | ICardLookupMissing;

export interface ICardAssignResult {
  card: ISigurCardSummary;
  employeeId: number;
  sigurEmployeeId: number;
}

export const sigurCardReaderService = {
  async lookup(uid: string): Promise<CardLookupResult> {
    const res = await apiClient.get<IApiResponse<CardLookupResult>>(
      `/sigur/cards/lookup?uid=${encodeURIComponent(uid)}`,
    );
    return res.data;
  },

  async assign(payload: { uid: string; employeeId: number; expirationDate?: string }): Promise<ICardAssignResult> {
    const res = await apiClient.post<IApiResponse<ICardAssignResult>>('/sigur/cards/assign', payload);
    return res.data;
  },
};
