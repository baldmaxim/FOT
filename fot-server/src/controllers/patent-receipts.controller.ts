import type { Response } from 'express';
import * as Sentry from '@sentry/node';
import { execute, query, queryOne, withTransaction } from '../config/postgres.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { r2Service } from '../services/r2.service.js';
import { aiReceiptRecognitionService } from '../services/ai-receipt-recognition.service.js';
import { trimWhiteBorders } from '../services/image-trim.service.js';
import { ensureBrowserFriendlyImage } from '../services/image-normalize.service.js';
import { sanitizeFileName } from '../utils/file-validation.utils.js';
import { decodeMulterFilename } from '../utils/multer-filename.utils.js';
import type { PatentPaymentReceiptPatch } from '../types/patent-receipt.types.js';
import { isAllowedOpenRouterModel } from '../services/settings.service.js';
import {
  decryptReceiptRow,
  decryptRawResponse,
  encryptReceiptFields,
} from '../services/patent-receipt-encryption.helper.js';
import { emitDomainChange } from '../services/realtime-broadcast.service.js';
import { getEmployeeUserId } from '../services/recipients.service.js';

function emitPatentReceiptChanged(params: {
  entityId?: number;
  authorUserId?: string | null;
  ownerUserId?: string | null;
  action: string;
}): void {
  const targetUserIds = [params.authorUserId, params.ownerUserId].filter(
    (u): u is string => typeof u === 'string' && u.length > 0,
  );
  if (targetUserIds.length === 0) return;
  emitDomainChange({
    event: 'patent_receipt:changed',
    targetUserIds: [...new Set(targetUserIds)],
    payload: {
      ...(params.entityId != null ? { entityId: params.entityId } : {}),
      action: params.action,
    },
  });
}

interface MulterRequest extends AuthenticatedRequest {
  file?: Express.Multer.File;
}

const RECEIPT_COLUMNS = `
  r.id, r.document_id, r.employee_id,
  r.payment_date, r.payment_amount, r.commission, r.total_amount,
  r.payer_full_name, r.payer_inn, r.payer_passport, r.document_number,
  r.payment_purpose, r.patent_number, r.patent_issue_date, r.kbk, r.oktmo, r.uin,
  r.recipient_name, r.recipient_inn, r.recipient_kpp, r.recipient_bank_name, r.recipient_bank_bic, r.recipient_account, r.recipient_corr_account,
  r.payer_bank_name, r.payer_bank_bic, r.payer_account, r.payment_method,
  r.source_type, r.raw_response, r.confidence, r.recognition_model, r.prompt_tokens, r.completion_tokens, r.cost_usd,
  r.needs_review, r.reviewed_by, r.reviewed_at, r.manually_edited,
  r.is_verified, r.verified_by, r.verified_at,
  r.period_start, r.period_end,
  r.created_at, r.updated_at
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
  'period_start',
  'period_end',
]);

const list = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const {
      employee_id,
      from,
      to,
      needs_review,
      status,
    } = req.query as Record<string, string | undefined>;

    const whereParts: string[] = [`d.category = 'patent_check'`];
    const params: unknown[] = [];
    const addParam = (v: unknown): string => {
      params.push(v);
      return `$${params.length}`;
    };

    if (employee_id && /^\d+$/.test(employee_id)) {
      whereParts.push(`d.employee_id = ${addParam(Number(employee_id))}`);
    }
    if (status) {
      whereParts.push(`d.recognition_status = ${addParam(status)}`);
    }

    const whereSql = `WHERE ${whereParts.join(' AND ')}`;

    type DocRow = {
      id: number;
      employee_id: number | null;
      file_name: string | null;
      mime_type: string | null;
      r2_key: string | null;
      recognition_status: string | null;
      recognition_attempts: number | null;
      recognized_at: string | null;
      recognition_error: string | null;
      created_at: string;
      employee_full_name: string | null;
      receipt_id: number | null;
      receipt_data: Record<string, unknown> | null;
    };

    const docs = await query<DocRow>(
      `SELECT
         d.id,
         d.employee_id,
         d.file_name,
         d.mime_type,
         d.r2_key,
         d.recognition_status,
         d.recognition_attempts,
         d.recognized_at,
         d.recognition_error,
         d.created_at,
         e.full_name AS employee_full_name,
         r.id AS receipt_id,
         CASE WHEN r.id IS NULL THEN NULL ELSE to_jsonb(r) END AS receipt_data
       FROM documents d
       LEFT JOIN employees e ON e.id = d.employee_id
       LEFT JOIN patent_payment_receipts r ON r.document_id = d.id
       ${whereSql}
       ORDER BY d.created_at DESC
       LIMIT 500`,
      params,
    );

    const mapped = docs
      .map(doc => {
        const rawReceipt = doc.receipt_data;
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
          is_verified: Boolean(receipt?.is_verified),
          recognition_model: (receipt?.recognition_model as string | null | undefined) ?? null,
          cost_usd: (receipt?.cost_usd as string | null | undefined) ?? null,
          period_start: (receipt?.period_start as string | null | undefined) ?? null,
          period_end: (receipt?.period_end as string | null | undefined) ?? null,
          created_at: (receipt?.created_at as string | undefined) ?? doc.created_at,
          r2_key: doc.r2_key,
          documents: {
            file_name: doc.file_name,
            mime_type: doc.mime_type,
            recognition_status: doc.recognition_status,
            recognition_error: doc.recognition_error,
          },
          employees: doc.employee_full_name !== null ? { full_name: doc.employee_full_name } : null,
        };
      })
      .filter(row => {
        if (from && (!row.payment_date || row.payment_date < from)) return false;
        if (to && (!row.payment_date || row.payment_date > to)) return false;
        if (needs_review === 'true' && !row.needs_review) return false;
        if (needs_review === 'false' && (!row.id || row.needs_review)) return false;
        return true;
      });

    const result = await Promise.all(mapped.map(async row => {
      let download_url: string | null = null;
      if (row.r2_key) {
        try {
          download_url = await r2Service.generateDownloadUrl(row.r2_key);
        } catch (err) {
          console.warn('patent-receipts.list download_url failed:', err);
        }
      }
      const { r2_key: _r2_key, ...rest } = row;
      void _r2_key;
      return { ...rest, download_url };
    }));

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('patent-receipts.list error:', err);
    Sentry.captureException(err, { tags: { route: 'GET /api/patent-receipts' } });
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

    const data = await queryOne<{
      [k: string]: unknown;
      documents_data: { file_name: string | null; mime_type: string | null; r2_key: string | null; recognition_status: string | null } | null;
      employees_data: { full_name: string | null } | null;
      raw_response: unknown;
    }>(
      `SELECT ${RECEIPT_COLUMNS},
              CASE WHEN d.id IS NULL THEN NULL ELSE jsonb_build_object(
                'file_name', d.file_name,
                'mime_type', d.mime_type,
                'r2_key', d.r2_key,
                'recognition_status', d.recognition_status
              ) END AS documents_data,
              CASE WHEN e.id IS NULL THEN NULL ELSE jsonb_build_object(
                'full_name', e.full_name
              ) END AS employees_data
         FROM patent_payment_receipts r
         LEFT JOIN documents d ON d.id = r.document_id
         LEFT JOIN employees e ON e.id = r.employee_id
        WHERE r.id = $1`,
      [id],
    );

    if (!data) {
      res.status(404).json({ success: false, error: 'Чек не найден' });
      return;
    }

    const r2Key = data.documents_data?.r2_key ?? null;
    let download_url: string | null = null;
    if (r2Key) {
      try {
        download_url = await r2Service.generateDownloadUrl(r2Key);
      } catch (err) {
        console.warn('patent-receipts.getOne download_url failed:', err);
      }
    }

    // Reshape: положить documents/employees как ожидает существующий клиент.
    const flatRow: Record<string, unknown> = { ...data };
    flatRow.documents = data.documents_data;
    flatRow.employees = data.employees_data;
    delete flatRow.documents_data;
    delete flatRow.employees_data;

    const decrypted = decryptReceiptRow(flatRow);
    decrypted.raw_response = decryptRawResponse(data.raw_response);

    res.json({ success: true, data: { ...decrypted, download_url } });
  } catch (err) {
    console.error('patent-receipts.getOne error:', err);
    Sentry.captureException(err, { tags: { route: 'GET /api/patent-receipts/:id' } });
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
    const nowIso = new Date().toISOString();
    const patch: Record<string, unknown> = {
      manually_edited: true,
      reviewed_by: req.user.id,
      reviewed_at: nowIso,
      updated_at: nowIso,
    };

    for (const [key, value] of Object.entries(body)) {
      if (PATCH_ALLOWED_FIELDS.has(key as keyof PatentPaymentReceiptPatch)) {
        patch[key] = value;
      }
    }

    const encrypted = encryptReceiptFields(patch);

    // Динамический SET. Все ключи — известные имена колонок (из allow-list),
    // но всё равно используем placeholder только для значений.
    const setClauses: string[] = [];
    const params: unknown[] = [];
    const addParam = (v: unknown): string => {
      params.push(v);
      return `$${params.length}`;
    };
    for (const [key, value] of Object.entries(encrypted)) {
      setClauses.push(`${key} = ${addParam(value)}`);
    }
    if (setClauses.length === 0) {
      res.status(400).json({ success: false, error: 'Нет полей для обновления' });
      return;
    }
    const idPlaceholder = addParam(id);

    const data = await queryOne<Record<string, unknown>>(
      `UPDATE patent_payment_receipts AS r SET ${setClauses.join(', ')}
        WHERE r.id = ${idPlaceholder}
        RETURNING ${RECEIPT_COLUMNS}`,
      params,
    );

    if (!data) {
      res.status(404).json({ success: false, error: 'Чек не найден или ошибка обновления' });
      return;
    }

    const employeeId = typeof data.employee_id === 'number' ? data.employee_id : null;
    if (employeeId != null) {
      getEmployeeUserId(employeeId)
        .then((ownerUserId) => {
          emitPatentReceiptChanged({
            entityId: id,
            authorUserId: req.user.id,
            ownerUserId,
            action: 'update',
          });
        })
        .catch((e) => console.error('[patent-receipts] emit update realtime error:', e));
    } else {
      emitPatentReceiptChanged({
        entityId: id,
        authorUserId: req.user.id,
        action: 'update',
      });
    }

    res.json({ success: true, data: decryptReceiptRow(data) });
  } catch (err) {
    console.error('patent-receipts.update error:', err);
    Sentry.captureException(err, { tags: { route: 'PATCH /api/patent-receipts/:id' } });
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

    const rows = await query<{
      id: number;
      employee_id: number | null;
      payment_date: string | null;
      payment_amount: string | null;
      period_start: string | null;
      period_end: string | null;
      created_at: string;
      documents: { file_name: string | null; mime_type: string | null; r2_key: string | null; recognition_status: string | null } | null;
    }>(
      `SELECT r.id, r.employee_id, r.payment_date, r.payment_amount, r.period_start, r.period_end, r.created_at,
              CASE WHEN d.id IS NULL THEN NULL ELSE jsonb_build_object(
                'file_name', d.file_name,
                'mime_type', d.mime_type,
                'r2_key', d.r2_key,
                'recognition_status', d.recognition_status
              ) END AS documents
         FROM patent_payment_receipts r
         LEFT JOIN documents d ON d.id = r.document_id
        WHERE r.employee_id = $1
        ORDER BY r.created_at DESC
        LIMIT 100`,
      [employeeId],
    );

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
    Sentry.captureException(err, { tags: { route: 'GET /api/patent-receipts/my' } });
    res.status(500).json({ success: false, error: 'Ошибка загрузки чеков' });
  }
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

    const periodStart = typeof req.body?.period_start === 'string' ? req.body.period_start.trim() : '';
    const periodEnd = typeof req.body?.period_end === 'string' ? req.body.period_end.trim() : '';
    if (!ISO_DATE_RE.test(periodStart) || !ISO_DATE_RE.test(periodEnd)) {
      res.status(400).json({ success: false, error: 'Период оплаты обязателен (формат YYYY-MM-DD)' });
      return;
    }
    if (periodStart > periodEnd) {
      res.status(400).json({ success: false, error: 'Дата «по» должна быть не раньше даты «с»' });
      return;
    }

    const file = req.file;
    let buffer = file.buffer;
    let mimeType = file.mimetype || 'application/octet-stream';
    let fileSize = file.size;
    let safeFileName = sanitizeFileName(decodeMulterFilename(file.originalname));

    // HEIC/HEIF → JPEG до записи в R2: иначе чек скачивается вместо превью и
    // не распознаётся vision-моделью.
    const normalized = await ensureBrowserFriendlyImage(buffer, mimeType, safeFileName);
    buffer = normalized.buffer;
    mimeType = normalized.mimeType;
    fileSize = normalized.size;
    safeFileName = normalized.fileName;

    const trimmed = await trimWhiteBorders(buffer, mimeType);
    buffer = trimmed.buffer;
    mimeType = trimmed.mimeType;
    fileSize = trimmed.size;

    const r2Key = r2Service.generateKey(employeeId, safeFileName);
    await r2Service.uploadObject(r2Key, buffer, mimeType);

    let data: Record<string, unknown> | null = null;
    try {
      data = await queryOne<Record<string, unknown>>(
        `INSERT INTO documents (employee_id, category, file_name, file_size, mime_type, r2_key, uploaded_by)
         VALUES ($1, 'patent_check', $2, $3, $4, $5, $6)
         RETURNING *`,
        [employeeId, safeFileName, fileSize, mimeType, r2Key, req.user.id],
      );
    } catch (err) {
      try { await r2Service.deleteObject(r2Key); } catch { /* best-effort */ }
      throw err;
    }
    if (!data) {
      try { await r2Service.deleteObject(r2Key); } catch { /* best-effort */ }
      throw new Error('Insert failed');
    }

    const documentId = Number(data.id);
    try {
      await execute(
        `INSERT INTO document_links (document_id, entity_type, entity_id, purpose)
         VALUES ($1, 'employee', $2, 'patent_check')
         ON CONFLICT (document_id, entity_type, entity_id, purpose) DO NOTHING`,
        [documentId, String(employeeId)],
      );
    } catch (err) {
      console.warn('patent-receipts.uploadMy document_links upsert failed:', err);
    }

    try {
      await execute(
        `INSERT INTO patent_payment_receipts (document_id, employee_id, period_start, period_end)
         VALUES ($1, $2, $3::date, $4::date)
         ON CONFLICT (document_id) DO UPDATE SET
           employee_id = EXCLUDED.employee_id,
           period_start = EXCLUDED.period_start,
           period_end = EXCLUDED.period_end`,
        [documentId, employeeId, periodStart, periodEnd],
      );
    } catch (err) {
      console.warn('patent-receipts.uploadMy patent_payment_receipts upsert failed:', err);
    }

    res.json({ success: true, data });

    emitPatentReceiptChanged({
      entityId: documentId,
      authorUserId: req.user.id,
      action: 'upload',
    });

    void aiReceiptRecognitionService.enqueueRecognition(documentId);
  } catch (err) {
    console.error('patent-receipts.uploadMy error:', err);
    Sentry.captureException(err, { tags: { route: 'POST /api/patent-receipts/my/upload' } });
    res.status(500).json({ success: false, error: 'Ошибка загрузки чека' });
  }
};

const remove = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const documentId = Number(req.params.documentId);
    if (!Number.isFinite(documentId)) {
      res.status(400).json({ success: false, error: 'Некорректный document_id' });
      return;
    }

    const doc = await queryOne<{ id: number; r2_key: string | null; category: string }>(
      `SELECT id, r2_key, category FROM documents WHERE id = $1`,
      [documentId],
    );

    if (!doc) {
      res.status(404).json({ success: false, error: 'Документ не найден' });
      return;
    }
    if (doc.category !== 'patent_check') {
      res.status(400).json({ success: false, error: 'Документ не является чеком за патент' });
      return;
    }

    const r2Key = doc.r2_key ?? null;
    if (r2Key) {
      try {
        await r2Service.deleteObject(r2Key);
      } catch (err) {
        console.warn('patent-receipts.remove R2 delete failed:', err);
      }
    }

    // Получаем employee_id перед удалением — нужно для notification сотруднику.
    const receiptOwner = await queryOne<{ employee_id: number | null }>(
      `SELECT employee_id FROM patent_payment_receipts WHERE document_id = $1`,
      [documentId],
    );

    // Удаляем связанные записи в одной транзакции.
    await withTransaction(async (client) => {
      await client.query('DELETE FROM patent_payment_receipts WHERE document_id = $1', [documentId]);
      await client.query('DELETE FROM document_links WHERE document_id = $1', [documentId]);
      await client.query('DELETE FROM documents WHERE id = $1', [documentId]);
    });

    const ownerEmployeeId = receiptOwner?.employee_id ?? null;
    if (ownerEmployeeId != null) {
      getEmployeeUserId(ownerEmployeeId)
        .then((ownerUserId) => {
          emitPatentReceiptChanged({
            entityId: documentId,
            authorUserId: req.user.id,
            ownerUserId,
            action: 'delete',
          });
        })
        .catch((e) => console.error('[patent-receipts] emit delete realtime error:', e));
    } else {
      emitPatentReceiptChanged({
        entityId: documentId,
        authorUserId: req.user.id,
        action: 'delete',
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('patent-receipts.remove error:', err);
    Sentry.captureException(err, { tags: { route: 'DELETE /api/patent-receipts/by-document/:documentId' } });
    const message = err instanceof Error ? err.message : 'Ошибка удаления чека';
    res.status(500).json({ success: false, error: message });
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
    Sentry.captureException(err, { tags: { route: 'POST /api/patent-receipts/:documentId/recognize' } });
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Ошибка распознавания' });
  }
};

const setVerified = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ success: false, error: 'Некорректный id' });
      return;
    }

    const verified = Boolean((req.body as { verified?: unknown } | undefined)?.verified);

    const data = await queryOne<Record<string, unknown>>(
      `UPDATE patent_payment_receipts AS r SET
         is_verified = $1,
         verified_by = CASE WHEN $1 THEN $2::uuid ELSE NULL END,
         verified_at = CASE WHEN $1 THEN now() ELSE NULL END,
         updated_at = now()
        WHERE r.id = $3
        RETURNING ${RECEIPT_COLUMNS}`,
      [verified, req.user.id, id],
    );

    if (!data) {
      res.status(404).json({ success: false, error: 'Чек не найден' });
      return;
    }

    res.json({ success: true, data: decryptReceiptRow(data) });
  } catch (err) {
    console.error('patent-receipts.setVerified error:', err);
    Sentry.captureException(err, { tags: { route: 'PATCH /api/patent-receipts/:id/verify' } });
    res.status(500).json({ success: false, error: 'Ошибка обновления отметки проверки' });
  }
};

export const patentReceiptsController = {
  list,
  getOne,
  getMy,
  uploadMy,
  update,
  recognize,
  remove,
  setVerified,
};
