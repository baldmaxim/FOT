import { apiClient } from '../api/client';
import type { ICardEvent } from '../hooks/useCardReader';

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

export interface ICardLookupDebug {
  tried: string[];
  sampleCards: Array<Record<string, string>>;
}

export interface ICardLookupMissing {
  found: false;
  uid: string;
  debug?: ICardLookupDebug;
}

export interface ICardAssignErrorPayload {
  error: string;
  debug?: ICardLookupDebug;
}

export type CardLookupResult = ICardLookupFound | ICardLookupMissing;

export interface ICardAssignResult {
  card: ISigurCardSummary;
  employeeId: number;
  sigurEmployeeId: number;
}

const buildLookupQuery = (input: ICardEvent | string): string => {
  const params = new URLSearchParams();
  if (typeof input === 'string') {
    if (input.trim()) params.set('uid', input.trim());
  } else {
    if (input.sigurCard) params.set('sigurCard', input.sigurCard);
    if (input.w26) params.set('w26', input.w26);
    if (input.hexUid) params.set('hex', input.hexUid);
    if (input.decBe) params.set('decBe', input.decBe);
    if (input.decLe) params.set('decLe', input.decLe);
  }
  return params.toString();
};

export const collectCardUids = (card: ICardEvent): string[] => {
  const out: string[] = [];
  for (const v of [card.sigurCard, card.w26, card.hexUid, card.decBe, card.decLe]) {
    if (typeof v === 'string' && v.trim() && !out.includes(v)) {
      out.push(v);
    }
  }
  return out;
};

export const sigurCardReaderService = {
  async lookup(input: ICardEvent | string): Promise<CardLookupResult> {
    const qs = buildLookupQuery(input);
    if (!qs) {
      throw new Error('Empty card payload');
    }
    const res = await apiClient.get<IApiResponse<CardLookupResult>>(`/sigur/cards/lookup?${qs}`);
    return res.data;
  },

  async assign(payload: {
    uid: string;
    uids?: string[];
    employeeId: number;
    expirationDate?: string;
  }): Promise<ICardAssignResult> {
    const res = await apiClient.post<IApiResponse<ICardAssignResult>>('/sigur/cards/assign', payload);
    return res.data;
  },
};
