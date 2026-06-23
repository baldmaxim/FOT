import { apiClient, buildApiUrl, buildAuthHeaders } from '../api/client';

export type ReceiptSourceType = 'solidarnost_terminal' | 'sber_pdf' | 'tinkoff_pdf' | 'unknown';
export type RecognitionStatus = 'pending' | 'processing' | 'done' | 'failed' | 'needs_review';
export type PaymentMethod = 'cash' | 'card' | 'transfer' | null;

export interface IPatentReceiptListRow {
  id: number | null;
  document_id: number;
  employee_id: number | null;
  payment_date: string | null;
  payment_amount: string | null;
  payer_full_name: string | null;
  payer_inn: string | null;
  payer_passport: string | null;
  patent_number: string | null;
  kbk: string | null;
  oktmo: string | null;
  source_type: ReceiptSourceType | null;
  confidence: string | null;
  needs_review: boolean;
  manually_edited: boolean;
  is_verified: boolean;
  recognition_model: string | null;
  cost_usd: string | null;
  period_start: string | null;
  period_end: string | null;
  created_at: string;
  download_url: string | null;
  documents: { file_name: string | null; mime_type: string | null; recognition_status: RecognitionStatus | null; recognition_error: string | null } | null;
  employees: { full_name: string | null } | null;
}

export interface IPatentReceiptDetail extends IPatentReceiptListRow {
  commission: string | null;
  total_amount: string | null;
  document_number: string | null;
  payment_purpose: string | null;
  patent_issue_date: string | null;
  uin: string | null;
  recipient_name: string | null;
  recipient_inn: string | null;
  recipient_kpp: string | null;
  recipient_bank_name: string | null;
  recipient_bank_bic: string | null;
  recipient_account: string | null;
  recipient_corr_account: string | null;
  payer_bank_name: string | null;
  payer_bank_bic: string | null;
  payer_account: string | null;
  payment_method: PaymentMethod;
  raw_response: unknown;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  verified_by: string | null;
  verified_at: string | null;
  updated_at: string;
  download_url: string | null;
  documents: (IPatentReceiptListRow['documents'] & { r2_key?: string | null }) | null;
}

export interface IPatentReceiptPatch {
  payment_date?: string | null;
  payment_amount?: number | null;
  commission?: number | null;
  total_amount?: number | null;
  payer_full_name?: string | null;
  payer_inn?: string | null;
  payer_passport?: string | null;
  document_number?: string | null;
  payment_purpose?: string | null;
  patent_number?: string | null;
  patent_issue_date?: string | null;
  kbk?: string | null;
  oktmo?: string | null;
  uin?: string | null;
  recipient_name?: string | null;
  recipient_inn?: string | null;
  recipient_kpp?: string | null;
  recipient_bank_name?: string | null;
  recipient_bank_bic?: string | null;
  recipient_account?: string | null;
  recipient_corr_account?: string | null;
  payer_bank_name?: string | null;
  payer_bank_bic?: string | null;
  payer_account?: string | null;
  payment_method?: PaymentMethod;
  needs_review?: boolean;
  period_start?: string | null;
  period_end?: string | null;
}

export interface IRecognizeResult {
  ok: boolean;
  status: RecognitionStatus;
  receiptId?: number;
  error?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cost_usd: number;
    model: string;
  };
}

export interface IListFilters {
  employee_id?: number;
  from?: string;
  to?: string;
  needs_review?: boolean;
  status?: RecognitionStatus;
  search?: string;
}

export interface IMyPatentReceipt {
  id: number;
  employee_id: number | null;
  payment_date: string | null;
  payment_amount: string | null;
  period_start: string | null;
  period_end: string | null;
  created_at: string;
  download_url: string | null;
  documents: { file_name: string | null; mime_type: string | null; recognition_status: RecognitionStatus | null } | null;
}

export interface IMissingPatentRow {
  employee_id: number;
  full_name: string | null;
  position_name: string | null;
  department_name: string | null;
  manager_full_name: string | null;
  objects: string[];
  paid_sum: number;
  required_sum: number;
  months_count: number;
}

interface ApiResponse<T> {
  data: T;
}

interface MissingResponse {
  success: boolean;
  data: IMissingPatentRow[];
  required_sum: number | null;
  months_count: number | null;
}

export const patentReceiptService = {
  list: async (filters?: IListFilters): Promise<IPatentReceiptListRow[]> => {
    const params = new URLSearchParams();
    if (filters?.employee_id) params.set('employee_id', String(filters.employee_id));
    if (filters?.from) params.set('from', filters.from);
    if (filters?.to) params.set('to', filters.to);
    if (filters?.needs_review !== undefined) params.set('needs_review', String(filters.needs_review));
    if (filters?.status) params.set('status', filters.status);
    if (filters?.search) params.set('search', filters.search);
    const qs = params.toString();
    const res = await apiClient.get<ApiResponse<IPatentReceiptListRow[]>>(`/patent-receipts${qs ? `?${qs}` : ''}`);
    return res.data;
  },

  get: async (id: number): Promise<IPatentReceiptDetail> => {
    const res = await apiClient.get<ApiResponse<IPatentReceiptDetail>>(`/patent-receipts/${id}`);
    return res.data;
  },

  update: async (id: number, patch: IPatentReceiptPatch): Promise<IPatentReceiptDetail> => {
    const res = await apiClient.patch<ApiResponse<IPatentReceiptDetail>>(`/patent-receipts/${id}`, patch);
    return res.data;
  },

  setVerified: async (id: number, verified: boolean): Promise<IPatentReceiptDetail> => {
    const res = await apiClient.patch<ApiResponse<IPatentReceiptDetail>>(`/patent-receipts/${id}/verify`, { verified });
    return res.data;
  },

  remove: async (documentId: number): Promise<void> => {
    await apiClient.delete<{ success: boolean }>(`/patent-receipts/by-document/${documentId}`);
  },

  recognize: async (documentId: number, model?: string): Promise<IRecognizeResult> => {
    const res = await apiClient.post<ApiResponse<IRecognizeResult>>(`/patent-receipts/${documentId}/recognize`, model ? { model } : {});
    return res.data;
  },

  listMy: async (): Promise<IMyPatentReceipt[]> => {
    const res = await apiClient.get<ApiResponse<IMyPatentReceipt[]>>('/patent-receipts/my');
    return res.data;
  },

  listMissing: async (from: string, to: string): Promise<MissingResponse> => {
    const params = new URLSearchParams({ from, to });
    const res = await apiClient.get<MissingResponse>(`/patent-receipts/missing?${params.toString()}`);
    return res;
  },

  su10Departments: async (): Promise<{ id: string; name: string }[]> => {
    const res = await apiClient.get<ApiResponse<{ id: string; name: string }[]>>('/patent-receipts/su10-departments');
    return res.data;
  },

  exportMissing: async (from: string, to: string): Promise<Blob> => {
    const params = new URLSearchParams({ from, to });
    const response = await fetch(
      buildApiUrl(`/patent-receipts/missing/export?${params.toString()}`),
      { credentials: 'include', headers: buildAuthHeaders() },
    );
    if (!response.ok) throw new Error('Ошибка экспорта');
    return response.blob();
  },

  uploadMy: async (file: File, periodStart: string, periodEnd: string): Promise<{ id: number }> => {
    const form = new FormData();
    form.append('file', file);
    form.append('period_start', periodStart);
    form.append('period_end', periodEnd);
    const res = await apiClient.post<ApiResponse<{ id: number }>>('/patent-receipts/my/upload', form);
    return res.data;
  },
};
