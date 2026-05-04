export type RecognitionStatus = 'pending' | 'processing' | 'done' | 'failed' | 'needs_review';

export type ReceiptSourceType = 'solidarnost_terminal' | 'sber_pdf' | 'tinkoff_pdf' | 'unknown';

/** Структура JSON, который возвращает LLM по json_schema. Все поля кроме confidence/source_type/unrecognized_fields могут быть null. */
export interface IRecognizedReceiptPayload {
  source_type: ReceiptSourceType;

  payment_date: string | null;
  payment_amount: number | null;
  commission: number | null;
  total_amount: number | null;

  payer_full_name: string | null;
  payer_inn: string | null;
  payer_passport: string | null;
  document_number: string | null;

  payment_purpose: string | null;
  patent_number: string | null;
  patent_issue_date: string | null;
  kbk: string | null;
  oktmo: string | null;
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
  payment_method: 'cash' | 'card' | 'transfer' | null;

  confidence: number;
  unrecognized_fields: string[];
}

export interface IRecognitionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
  model: string;
}

export interface IRecognitionRunResult {
  ok: boolean;
  status: RecognitionStatus;
  receiptId?: number;
  data?: IRecognizedReceiptPayload;
  error?: string;
  usage?: IRecognitionUsage;
}

/** Строка в таблице patent_payment_receipts (для GET /api/patent-receipts/:id) */
export interface IPatentPaymentReceipt {
  id: number;
  document_id: number;
  employee_id: number | null;

  payment_date: string | null;
  payment_amount: string | null;
  commission: string | null;
  total_amount: string | null;
  payer_full_name: string | null;
  payer_inn: string | null;
  payer_passport: string | null;
  document_number: string | null;

  payment_purpose: string | null;
  patent_number: string | null;
  patent_issue_date: string | null;
  kbk: string | null;
  oktmo: string | null;
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
  payment_method: string | null;

  source_type: ReceiptSourceType | null;
  raw_response: unknown;
  confidence: string | null;
  recognition_model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_usd: string | null;

  needs_review: boolean;
  reviewed_by: string | null;
  reviewed_at: string | null;
  manually_edited: boolean;

  period_start: string | null;
  period_end: string | null;

  created_at: string;
  updated_at: string;
}

/** Поля, которые HR может править вручную через PATCH */
export type PatentPaymentReceiptPatch = Partial<Pick<IPatentPaymentReceipt,
  | 'payment_date'
  | 'payment_amount'
  | 'commission'
  | 'total_amount'
  | 'payer_full_name'
  | 'payer_inn'
  | 'payer_passport'
  | 'document_number'
  | 'payment_purpose'
  | 'patent_number'
  | 'patent_issue_date'
  | 'kbk'
  | 'oktmo'
  | 'uin'
  | 'recipient_name'
  | 'recipient_inn'
  | 'recipient_kpp'
  | 'recipient_bank_name'
  | 'recipient_bank_bic'
  | 'recipient_account'
  | 'recipient_corr_account'
  | 'payer_bank_name'
  | 'payer_bank_bic'
  | 'payer_account'
  | 'payment_method'
  | 'needs_review'
  | 'period_start'
  | 'period_end'
>>;
