import type { Response } from 'express';
import { supabase } from '../config/database.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { r2Service } from '../services/r2.service.js';
import { aiReceiptRecognitionService } from '../services/ai-receipt-recognition.service.js';
import { trimWhiteBorders } from '../services/image-trim.service.js';
import type { PatentPaymentReceiptPatch } from '../types/patent-receipt.types.js';
import { isAllowedOpenRouterModel } from '../services/settings.service.js';
import {
  decryptReceiptRow,
  decryptRawResponse,
  encryptReceiptFields,
} from '../services/patent-receipt-encryption.helper.js';

interface MulterRequest extends AuthenticatedRequest {
  file?: Express.Multer.File;
}

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

interface IDocumentListRow {
  id: number;
  employee_id: number | null;
  file_name: string | null;
  mime_type: string | null;
  recognition_status: string | null;
  recognition_attempts: number | null;
  recognized_at: string | null;
  created_at: string;
  employees: { full_name: string | null } | null;
  patent_payment_receipts: Array<Record<string, unknown>> | null;
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
      .from('documents')
      .select(`
        id,
        employee_id,
        file_name,
        mime_type,
        recognition_status,
        recognition_attempts,
        recognized_at,
        created_at,
        employees:employee_id ( full_name ),
        patent_payment_receipts:patent_payment_receipts!document_id (
          id, document_id, employee_id,
          payment_date, payment_amount, payer_full_name, payer_inn, payer_passport,
          patent_number, kbk, oktmo, source_type, confidence,
          needs_review, manually_edited, recognition_model, cost_usd,
          created_at
        )
      `)
      .eq('category', 'patent_check')
      .order('created_at', { ascending: false })
      .limit(500);

    if (employee_id && /^\d+$/.test(employee_id)) {
      query = query.eq('employee_id', Number(employee_id));
    }
    if (status) {
      query = query.eq('recognition_status', status);
    }

    const { data, error } = await query;
    if (error) throw error;

    const docs = (data || []) as unknown as IDocumentListRow[];

    const result = docs
      .map(doc => {
        const receiptsRaw = doc.patent_payment_receipts;
        const rawReceipt = receiptsRaw && receiptsRaw.length > 0 ? receiptsRaw[0] : null;
        const receipt = rawReceipt
          ? (decryptReceiptRow(rawReceipt as Record<string, unknown>) as Record<string, unknown>)
          : null;

        return {
          id: (receipt?.id as number | null | undefined) ?? null,
          document_id: doc.id,
          employee_id: doc.employee_id,
          payment_date: (receipt?.payment_date as string | null | undefined) ?? null,
          payment_amount: (receipt?.payment_amount as string | null | undefined) ?? null,
          payer_full_name: (receipt?.payer_full_name as string | null | undefined) ?? null,
          payer_inn: (receipt?.payer_inn as string | null | undefined) ?? null,
          payer_passport: (receipt?.payer_passport as string | null | undefined) ?? null,
          patent_number: (receipt?.patent_number as string | null | undefined) ?? null,
          kbk: (receipt?.kbk as string | null | undefined) ?? null,
          oktmo: (receipt?.oktmo as string | null | undefined) ?? null,
          source_type: (receipt?.source_type as string | null | undefined) ?? null,
          confidence: (receipt?.confidence as string | null | undefined) ?? null,
          needs_review: Boolean(receipt?.needs_review),
          manually_edited: Boolean(receipt?.manually_edited),
          recognition_model: (receipt?.recognition_model as string | null | undefined) ?? null,
          cost_usd: (receipt?.cost_usd as string | null | undefined) ?? null,
          created_at: (receipt?.created_at as string | undefined) ?? doc.created_at,
          documents: {
            file_name: doc.file_name,
            mime_type: doc.mime_type,
            recognition_status: doc.recognition_status,
          },
          employees: doc.employees ? { full_name: doc.employees.full_name } : null,
        };
      })
      .filter(row => {
        if (from && (!row.payment_date || row.payment_date < from)) return false;
        if (to && (!row.payment_date || row.payment_date > to)) return false;
        if (needs_review === 'true' && !row.needs_review) return false;
        if (needs_review === 'false' && (!row.id || row.needs_review)) return false;
        return true;
      });

    res.json({ success: true, data: result });
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

const getMy = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = req.user.employee_id;
    if (!employeeId) {
      res.json({ success: true, data: [] });
      return;
    }

    const { data, error } = await supabase
      .from('patent_payment_receipts')
      .select('id, employee_id, payment_date, payment_amount, created_at, documents:document_id ( file_name, mime_type, r2_key, recognition_status )')
      .eq('employee_id', employeeId)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;

    const rows = (data || []) as unknown as Array<{
      id: number;
      employee_id: number | null;
      payment_date: string | null;
      payment_amount: string | null;
      created_at: string;
      documents: { file_name: string | null; mime_type: string | null; r2_key: string | null; recognition_status: string | null } | null;
    }>;

    const result = await Promise.all(rows.map(async row => {
      const decrypted = decryptReceiptRow(row as unknown as Record<string, unknown>) as typeof row;
      let download_url: string | null = null;
      const r2Key = row.documents?.r2_key ?? null;
      if (r2Key) {
        try {
          download_url = await r2Service.generateDownloadUrl(r2Key);
        } catch (err) {
          console.warn('patent-receipts.getMy download_url failed:', err);
        }
      }
      const { documents, ...rest } = decrypted;
      const docPublic = documents
        ? { file_name: documents.file_name, mime_type: documents.mime_type, recognition_status: documents.recognition_status }
        : null;
      return { ...rest, documents: docPublic, download_url };
    }));

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('patent-receipts.getMy error:', err);
    res.status(500).json({ success: false, error: 'Ошибка загрузки чеков' });
  }
};

const uploadMy = async (req: MulterRequest, res: Response): Promise<void> => {
  try {
    const employeeId = req.user.employee_id;
    if (!employeeId) {
      res.status(403).json({ success: false, error: 'Аккаунт не привязан к сотруднику' });
      return;
    }
    if (!(await r2Service.isEnabledAsync())) {
      res.status(503).json({ success: false, error: 'R2 хранилище не настроено' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ success: false, error: 'Файл обязателен' });
      return;
    }

    const file = req.file;
    let buffer = file.buffer;
    let mimeType = file.mimetype || 'application/octet-stream';
    let fileSize = file.size;

    const trimmed = await trimWhiteBorders(buffer, mimeType);
    buffer = trimmed.buffer;
    mimeType = trimmed.mimeType;
    fileSize = trimmed.size;

    const r2Key = r2Service.generateKey(employeeId, file.originalname);
    await r2Service.uploadObject(r2Key, buffer, mimeType);

    const { data, error } = await supabase
      .from('documents')
      .insert({
        employee_id: employeeId,
        category: 'patent_check',
        file_name: file.originalname,
        file_size: fileSize,
        mime_type: mimeType,
        r2_key: r2Key,
        uploaded_by: req.user.id,
      })
      .select()
      .single();

    if (error || !data) {
      try { await r2Service.deleteObject(r2Key); } catch { /* best-effort */ }
      throw error || new Error('Insert failed');
    }

    const documentId = Number(data.id);
    const { error: linkError } = await supabase
      .from('document_links')
      .upsert(
        [{ document_id: documentId, entity_type: 'employee', entity_id: String(employeeId), purpose: 'patent_check' }],
        { onConflict: 'document_id,entity_type,entity_id,purpose' },
      );
    if (linkError) {
      console.warn('patent-receipts.uploadMy document_links upsert failed:', linkError);
    }

    res.json({ success: true, data });

    void aiReceiptRecognitionService.enqueueRecognition(documentId);
  } catch (err) {
    console.error('patent-receipts.uploadMy error:', err);
    res.status(500).json({ success: false, error: 'Ошибка загрузки чека' });
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
  getMy,
  uploadMy,
  update,
  recognize,
};
