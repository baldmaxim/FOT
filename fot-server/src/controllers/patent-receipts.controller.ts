import type { Response } from 'express';
import { supabase } from '../config/database.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { r2Service } from '../services/r2.service.js';
import { aiReceiptRecognitionService } from '../services/ai-receipt-recognition.service.js';
import type { PatentPaymentReceiptPatch } from '../types/patent-receipt.types.js';
import { isAllowedOpenRouterModel } from '../services/settings.service.js';
import {
  decryptReceiptRow,
  decryptRawResponse,
  encryptReceiptFields,
} from '../services/patent-receipt-encryption.helper.js';

const RECEIPT_COLUMNS = `
  id, document_id, employee_id,
  payment_date, payment_amount, commission, total_amount,
  payer_full_name, payer_inn, payer_passport, document_number,
  payment_purpose, patent_number, patent_issue_date, kbk, oktmo, uin,
  recipient_name, recipient_inn, recipient_kpp, recipient_bank_name, recipient_bank_bic, recipient_account, recipient_corr_account,
  payer_bank_name, payer_bank_bic, payer_account, payment_method,
  source_type, raw_response, confidence, recognition_model, prompt_tokens, completion_tokens, cost_usd,
  needs_review, reviewed_by, reviewed_at, manually_edited,
  created_at, updated_at
`;

const PATCH_ALLOWED_FIELDS = new Set<keyof PatentPaymentReceiptPatch>([
  'payment_date',
  'payment_amount',
  'commission',
  'total_amount',
  'payer_full_name',
  'payer_inn',
  'payer_passport',
  'document_number',
  'payment_purpose',
  'patent_number',
  'patent_issue_date',
  'kbk',
  'oktmo',
  'uin',
  'recipient_name',
  'recipient_inn',
  'recipient_kpp',
  'recipient_bank_name',
  'recipient_bank_bic',
  'recipient_account',
  'recipient_corr_account',
  'payer_bank_name',
  'payer_bank_bic',
  'payer_account',
  'payment_method',
  'needs_review',
]);

interface IListRow {
  id: number;
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
  source_type: string | null;
  confidence: string | null;
  needs_review: boolean;
  manually_edited: boolean;
  recognition_model: string | null;
  cost_usd: string | null;
  created_at: string;
}

const list = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const {
      employee_id,
      from,
      to,
      needs_review,
      status,
    } = req.query as Record<string, string | undefined>;

    let query = supabase
      .from('patent_payment_receipts')
      .select(`${RECEIPT_COLUMNS}, documents:document_id ( file_name, mime_type, recognition_status ), employees:employee_id ( full_name )`)
      .order('payment_date', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false });

    if (employee_id && /^\d+$/.test(employee_id)) {
      query = query.eq('employee_id', Number(employee_id));
    }
    if (from) query = query.gte('payment_date', from);
    if (to) query = query.lte('payment_date', to);
    if (needs_review === 'true') query = query.eq('needs_review', true);
    if (needs_review === 'false') query = query.eq('needs_review', false);

    const { data, error } = await query.limit(500);
    if (error) throw error;

    let rows = (data || []) as unknown as Array<IListRow & {
      documents: { file_name: string | null; mime_type: string | null; recognition_status: string | null } | null;
      employees: { full_name: string | null } | null;
    }>;

    if (status) {
      rows = rows.filter(r => r.documents?.recognition_status === status);
    }

    const decrypted = rows.map(row => decryptReceiptRow(row as unknown as Record<string, unknown>));

    res.json({ success: true, data: decrypted });
  } catch (err) {
    console.error('patent-receipts.list error:', err);
    res.status(500).json({ success: false, error: 'Ошибка загрузки списка чеков' });
  }
};

const getOne = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ success: false, error: 'Некорректный id' });
      return;
    }

    const { data, error } = await supabase
      .from('patent_payment_receipts')
      .select(`${RECEIPT_COLUMNS}, documents:document_id ( file_name, mime_type, r2_key, recognition_status ), employees:employee_id ( full_name )`)
      .eq('id', id)
      .single();

    if (error || !data) {
      res.status(404).json({ success: false, error: 'Чек не найден' });
      return;
    }

    const row = data as unknown as { documents?: { r2_key?: string | null }; raw_response?: unknown };
    let download_url: string | null = null;
    if (row.documents?.r2_key) {
      try {
        download_url = await r2Service.generateDownloadUrl(row.documents.r2_key);
      } catch (err) {
        console.warn('patent-receipts.getOne download_url failed:', err);
      }
    }

    const decrypted = decryptReceiptRow(data as Record<string, unknown>);
    decrypted.raw_response = decryptRawResponse(row.raw_response);

    res.json({ success: true, data: { ...decrypted, download_url } });
  } catch (err) {
    console.error('patent-receipts.getOne error:', err);
    res.status(500).json({ success: false, error: 'Ошибка загрузки чека' });
  }
};

const update = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ success: false, error: 'Некорректный id' });
      return;
    }

    const body = (req.body || {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {
      manually_edited: true,
      reviewed_by: req.user.id,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    for (const [key, value] of Object.entries(body)) {
      if (PATCH_ALLOWED_FIELDS.has(key as keyof PatentPaymentReceiptPatch)) {
        patch[key] = value;
      }
    }

    const { data, error } = await supabase
      .from('patent_payment_receipts')
      .update(encryptReceiptFields(patch))
      .eq('id', id)
      .select(RECEIPT_COLUMNS)
      .single();

    if (error || !data) {
      res.status(404).json({ success: false, error: 'Чек не найден или ошибка обновления' });
      return;
    }

    res.json({ success: true, data: decryptReceiptRow(data as Record<string, unknown>) });
  } catch (err) {
    console.error('patent-receipts.update error:', err);
    res.status(500).json({ success: false, error: 'Ошибка обновления чека' });
  }
};

const recognize = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const documentId = Number(req.params.documentId);
    if (!Number.isFinite(documentId)) {
      res.status(400).json({ success: false, error: 'Некорректный documentId' });
      return;
    }

    const { model } = (req.body || {}) as { model?: string };
    if (model !== undefined && !isAllowedOpenRouterModel(String(model))) {
      res.status(400).json({ success: false, error: 'Модель не разрешена' });
      return;
    }

    const result = await aiReceiptRecognitionService.recognizePatentReceipt(documentId, {
      modelOverride: model,
    });

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('patent-receipts.recognize error:', err);
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Ошибка распознавания' });
  }
};

export const patentReceiptsController = {
  list,
  getOne,
  update,
  recognize,
};
