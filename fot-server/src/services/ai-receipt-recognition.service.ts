import axios from 'axios';
import * as Sentry from '@sentry/node';
import { supabase } from '../config/database.js';
import { r2Service } from './r2.service.js';
import { openRouterService, type IChatMessage } from './openrouter.service.js';
import { encryptReceiptFields, encryptRawResponse } from './patent-receipt-encryption.helper.js';
import {
  IRecognitionRunResult,
  IRecognizedReceiptPayload,
  RecognitionStatus,
  ReceiptSourceType,
} from '../types/patent-receipt.types.js';

const ALLOWED_SOURCE_TYPES: ReceiptSourceType[] = ['solidarnost_terminal', 'sber_pdf', 'tinkoff_pdf', 'unknown'];
const ALLOWED_PAYMENT_METHODS = ['cash', 'card', 'transfer'] as const;

const SYSTEM_PROMPT = `Ты извлекаешь поля из чека/квитанции об оплате авансового НДФЛ за патент иностранным гражданином в РФ.
Чек может быть из терминала «Солидарность», Сбербанк-онлайн или Т-Банка.
Верни строго JSON по заданной схеме. Если поля нет — null. Не выдумывай.

Особое внимание к ФИО (русские транслитерации с тюркских/таджикских имён):
- Не удваивай согласные (Д, Н, Л, М, Т, С) если в оригинале одна буква. Распространённые ошибки OCR: «УМЕДЖОНОВИЧ» → ошибочно «УМЕДДЖОНОВИЧ», «АХМАДЖОН» → «АХМАДДЖОН». Сравнивай каждое слово ФИО посимвольно с изображением, считай число одинаковых букв подряд.
- Сохраняй регистр как в документе. Не добавляй буквы, которых нет в изображении.

Поля и пояснения:
- payment_date: дата платежа в формате YYYY-MM-DD
- payment_amount: сумма платежа (число рублей, без валюты)
- payer_full_name: ФИО плательщика как написано
- payer_inn: ИНН плательщика (12 цифр для физлица)
- payer_passport: серия+номер паспорта плательщика, только цифры подряд
- patent_number: номер патента из назначения платежа (например "77 2600115121")
- patent_issue_date: дата выдачи патента в формате YYYY-MM-DD (из текста "выдан 16.03.2026")
- kbk: КБК (20 цифр)
- oktmo: ОКТМО
- uin: УИН/УИНО индекс документа
- recipient_name: получатель (например "Казначейство России (ФНС России)")
- recipient_inn / recipient_kpp / recipient_bank_bic / recipient_account: реквизиты получателя
- payment_method: 'cash' если "Наличные", 'card' если "Платёжный счёт"/"Безналичная оплата" с карты, 'transfer' если перевод; иначе null
- source_type: одно из solidarnost_terminal, sber_pdf, tinkoff_pdf, unknown
- confidence: твоя оценка точности извлечения от 0 до 1 (0.9 если все ключевые поля чёткие)
- unrecognized_fields: список имён полей которые отсутствовали или нечитаемы

Если документ явно не является платёжным чеком/квитанцией (например это селфи, паспорт, договор) — верни confidence < 0.3 и source_type "unknown".`;

const RECEIPT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'source_type', 'payment_date', 'payment_amount', 'commission', 'total_amount',
    'payer_full_name', 'payer_inn', 'payer_passport', 'document_number',
    'payment_purpose', 'patent_number', 'patent_issue_date', 'kbk', 'oktmo', 'uin',
    'recipient_name', 'recipient_inn', 'recipient_kpp', 'recipient_bank_name',
    'recipient_bank_bic', 'recipient_account', 'recipient_corr_account',
    'payer_bank_name', 'payer_bank_bic', 'payer_account', 'payment_method',
    'confidence', 'unrecognized_fields',
  ],
  properties: {
    source_type: { type: 'string', enum: ALLOWED_SOURCE_TYPES },
    payment_date: { type: ['string', 'null'] },
    payment_amount: { type: ['number', 'null'] },
    commission: { type: ['number', 'null'] },
    total_amount: { type: ['number', 'null'] },
    payer_full_name: { type: ['string', 'null'] },
    payer_inn: { type: ['string', 'null'] },
    payer_passport: { type: ['string', 'null'] },
    document_number: { type: ['string', 'null'] },
    payment_purpose: { type: ['string', 'null'] },
    patent_number: { type: ['string', 'null'] },
    patent_issue_date: { type: ['string', 'null'] },
    kbk: { type: ['string', 'null'] },
    oktmo: { type: ['string', 'null'] },
    uin: { type: ['string', 'null'] },
    recipient_name: { type: ['string', 'null'] },
    recipient_inn: { type: ['string', 'null'] },
    recipient_kpp: { type: ['string', 'null'] },
    recipient_bank_name: { type: ['string', 'null'] },
    recipient_bank_bic: { type: ['string', 'null'] },
    recipient_account: { type: ['string', 'null'] },
    recipient_corr_account: { type: ['string', 'null'] },
    payer_bank_name: { type: ['string', 'null'] },
    payer_bank_bic: { type: ['string', 'null'] },
    payer_account: { type: ['string', 'null'] },
    payment_method: { type: ['string', 'null'], enum: [...ALLOWED_PAYMENT_METHODS, null] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    unrecognized_fields: { type: 'array', items: { type: 'string' } },
  },
} as const;

const MAX_INLINE_BYTES = 4 * 1024 * 1024;

const stripJsonFence = (raw: string): string => {
  let s = raw.trim();
  const fenceMatch = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch) {
    s = fenceMatch[1].trim();
  }
  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace > 0 && lastBrace > firstBrace) {
    s = s.slice(firstBrace, lastBrace + 1);
  }
  return s;
};

const normalizeDate = (raw: string | null): string | null => {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  let m = trimmed.match(/^(\d{2})[./](\d{2})[./](\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = trimmed.match(/^(\d{4})[./](\d{2})[./](\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
};

const sanitizeNumber = (raw: number | null): number | null => {
  if (raw == null) return null;
  if (!Number.isFinite(raw)) return null;
  return Math.round(raw * 100) / 100;
};

const validatePayload = (raw: unknown): IRecognizedReceiptPayload => {
  if (!raw || typeof raw !== 'object') throw new Error('LLM вернул не-объект');
  const r = raw as Record<string, unknown>;
  const source = ALLOWED_SOURCE_TYPES.includes(r.source_type as ReceiptSourceType)
    ? (r.source_type as ReceiptSourceType)
    : 'unknown';
  const paymentMethodRaw = r.payment_method;
  const paymentMethod = typeof paymentMethodRaw === 'string' && (ALLOWED_PAYMENT_METHODS as readonly string[]).includes(paymentMethodRaw)
    ? (paymentMethodRaw as 'cash' | 'card' | 'transfer')
    : null;
  return {
    source_type: source,
    payment_date: normalizeDate(typeof r.payment_date === 'string' ? r.payment_date : null),
    payment_amount: sanitizeNumber(typeof r.payment_amount === 'number' ? r.payment_amount : null),
    commission: sanitizeNumber(typeof r.commission === 'number' ? r.commission : null),
    total_amount: sanitizeNumber(typeof r.total_amount === 'number' ? r.total_amount : null),
    payer_full_name: typeof r.payer_full_name === 'string' ? r.payer_full_name : null,
    payer_inn: typeof r.payer_inn === 'string' ? r.payer_inn.replace(/\s+/g, '') : null,
    payer_passport: typeof r.payer_passport === 'string' ? r.payer_passport.replace(/\s+/g, '') : null,
    document_number: typeof r.document_number === 'string' ? r.document_number : null,
    payment_purpose: typeof r.payment_purpose === 'string' ? r.payment_purpose : null,
    patent_number: typeof r.patent_number === 'string' ? r.patent_number : null,
    patent_issue_date: normalizeDate(typeof r.patent_issue_date === 'string' ? r.patent_issue_date : null),
    kbk: typeof r.kbk === 'string' ? r.kbk.replace(/\s+/g, '') : null,
    oktmo: typeof r.oktmo === 'string' ? r.oktmo.replace(/\s+/g, '') : null,
    uin: typeof r.uin === 'string' ? r.uin.replace(/\s+/g, '') : null,
    recipient_name: typeof r.recipient_name === 'string' ? r.recipient_name : null,
    recipient_inn: typeof r.recipient_inn === 'string' ? r.recipient_inn.replace(/\s+/g, '') : null,
    recipient_kpp: typeof r.recipient_kpp === 'string' ? r.recipient_kpp.replace(/\s+/g, '') : null,
    recipient_bank_name: typeof r.recipient_bank_name === 'string' ? r.recipient_bank_name : null,
    recipient_bank_bic: typeof r.recipient_bank_bic === 'string' ? r.recipient_bank_bic.replace(/\s+/g, '') : null,
    recipient_account: typeof r.recipient_account === 'string' ? r.recipient_account.replace(/\s+/g, '') : null,
    recipient_corr_account: typeof r.recipient_corr_account === 'string' ? r.recipient_corr_account.replace(/\s+/g, '') : null,
    payer_bank_name: typeof r.payer_bank_name === 'string' ? r.payer_bank_name : null,
    payer_bank_bic: typeof r.payer_bank_bic === 'string' ? r.payer_bank_bic.replace(/\s+/g, '') : null,
    payer_account: typeof r.payer_account === 'string' ? r.payer_account.replace(/\s+/g, '') : null,
    payment_method: paymentMethod,
    confidence: typeof r.confidence === 'number' && r.confidence >= 0 && r.confidence <= 1 ? r.confidence : 0,
    unrecognized_fields: Array.isArray(r.unrecognized_fields)
      ? r.unrecognized_fields.filter((x): x is string => typeof x === 'string')
      : [],
  };
};

const FIO_MAX_WORD_DISTANCE = 2;

const normalizeFioWord = (s: string): string => s.toUpperCase().replace(/Ё/g, 'Е').trim();

const levenshtein = (a: string, b: string): number => {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
};

interface IFioNormalizationResult {
  value: string | null;
  corrected: boolean;
}

const normalizePayerFio = (
  payerFio: string | null,
  employeeFio: string | null | undefined,
  confidence: number,
): IFioNormalizationResult => {
  if (!payerFio || !employeeFio || confidence < 0.7) {
    return { value: payerFio, corrected: false };
  }
  const payerWords = payerFio.split(/\s+/).filter(Boolean).map(normalizeFioWord);
  const employeeWords = employeeFio.split(/\s+/).filter(Boolean).map(normalizeFioWord);
  if (payerWords.length === 0 || employeeWords.length === 0) {
    return { value: payerFio, corrected: false };
  }
  if (payerWords.length !== employeeWords.length) {
    return { value: payerFio, corrected: false };
  }
  let anyDifference = false;
  for (let i = 0; i < payerWords.length; i++) {
    const dist = levenshtein(payerWords[i], employeeWords[i]);
    if (dist > FIO_MAX_WORD_DISTANCE) return { value: payerFio, corrected: false };
    if (dist > 0) anyDifference = true;
  }
  if (!anyDifference) return { value: payerFio, corrected: false };
  return { value: employeeFio, corrected: true };
};

const decideStatus = (payload: IRecognizedReceiptPayload): RecognitionStatus => {
  const allKeyFieldsEmpty =
    !payload.payment_date &&
    payload.payment_amount == null &&
    !payload.payer_full_name &&
    !payload.patent_number;
  if (allKeyFieldsEmpty) return 'failed';
  if (payload.confidence < 0.7) return 'needs_review';
  if (!payload.payment_date || payload.payment_amount == null) return 'needs_review';
  if (payload.source_type === 'unknown') return 'needs_review';
  return 'done';
};

interface IDocumentRow {
  id: number;
  employee_id: number | null;
  category: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  r2_key: string;
}

const buildImagePart = async (doc: IDocumentRow): Promise<{ type: 'image_url'; image_url: { url: string } }> => {
  const presignedUrl = await r2Service.generateDownloadUrl(doc.r2_key);

  // PDF и крупные изображения — отдаём base64, иначе передаём URL напрямую.
  const useBase64 = doc.mime_type === 'application/pdf' || doc.file_size > MAX_INLINE_BYTES;
  if (!useBase64) {
    return { type: 'image_url', image_url: { url: presignedUrl } };
  }

  const fileRes = await axios.get<ArrayBuffer>(presignedUrl, {
    responseType: 'arraybuffer',
    timeout: 30_000,
  });
  const b64 = Buffer.from(fileRes.data).toString('base64');
  return { type: 'image_url', image_url: { url: `data:${doc.mime_type};base64,${b64}` } };
};

const updateDocumentStatus = async (
  documentId: number,
  status: RecognitionStatus | null,
  attemptIncrement: boolean,
  errorText?: string | null,
): Promise<void> => {
  const patch: Record<string, unknown> = {
    recognition_status: status,
    recognized_at: status === 'done' || status === 'needs_review' ? new Date().toISOString() : null,
  };
  if (status === 'failed') {
    patch.recognition_error = errorText ? errorText.slice(0, 1000) : null;
  } else if (status === 'done' || status === 'needs_review' || status === 'processing') {
    patch.recognition_error = null;
  }
  if (attemptIncrement) {
    const { data: cur } = await supabase
      .from('documents')
      .select('recognition_attempts')
      .eq('id', documentId)
      .single();
    patch.recognition_attempts = ((cur?.recognition_attempts as number | null) || 0) + 1;
  }
  await supabase.from('documents').update(patch).eq('id', documentId);
};

export const aiReceiptRecognitionService = {
  /**
   * Запустить распознавание чека. Идемпотентно — UPSERT по document_id.
   * Возвращает результат, в т.ч. для случая когда LLM не настроен.
   */
  async recognizePatentReceipt(
    documentId: number,
    opts?: { modelOverride?: string },
  ): Promise<IRecognitionRunResult> {
    const { data: doc, error: docErr } = await supabase
      .from('documents')
      .select('id, employee_id, category, file_name, file_size, mime_type, r2_key')
      .eq('id', documentId)
      .single();

    if (docErr || !doc) {
      return { ok: false, status: 'failed', error: 'Документ не найден' };
    }
    if (doc.category !== 'patent_check') {
      return { ok: false, status: 'failed', error: 'Категория документа не patent_check' };
    }

    await updateDocumentStatus(documentId, 'processing', true);

    let rawLlmContent: string | null = null;

    try {
      const imagePart = await buildImagePart(doc as IDocumentRow);

      const messages: IChatMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Извлеки поля из чека ниже строго в JSON.' },
            imagePart,
          ],
        },
      ];

      const completion = await openRouterService.chatCompletion(
        {
          messages,
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'patent_receipt', strict: true, schema: RECEIPT_JSON_SCHEMA },
          },
          temperature: 0,
          max_tokens: 1500,
        },
        { modelOverride: opts?.modelOverride },
      );

      const content = completion.choices[0]?.message.content;
      rawLlmContent = content ?? null;
      if (!content) throw new Error('LLM вернул пустой ответ');

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        const stripped = stripJsonFence(content);
        try {
          parsed = JSON.parse(stripped);
        } catch {
          const preview = content.slice(0, 300).replace(/\s+/g, ' ');
          throw new Error(`LLM вернул не-JSON. Начало ответа: ${preview}`);
        }
      }

      const payload = validatePayload(parsed);

      if (doc.employee_id && payload.payer_full_name) {
        const { data: emp } = await supabase
          .from('employees')
          .select('full_name')
          .eq('id', doc.employee_id)
          .single();
        const employeeFullName = (emp?.full_name as string | null | undefined) ?? null;
        const fioRes = normalizePayerFio(payload.payer_full_name, employeeFullName, payload.confidence);
        if (fioRes.corrected && fioRes.value) {
          console.log(`[ai-receipt-recognition] auto-corrected fio doc=${documentId} "${payload.payer_full_name}" -> "${fioRes.value}"`);
          payload.payer_full_name = fioRes.value;
        }
      }

      const status = decideStatus(payload);

      if (status === 'failed') {
        throw new Error('Распознавание не извлекло ни одного ключевого поля чека');
      }

      const promptTokens = completion.usage?.prompt_tokens ?? 0;
      const completionTokens = completion.usage?.completion_tokens ?? 0;
      const costUsd = completion.usage?.cost ?? 0;

      const upsertRow = {
        document_id: documentId,
        employee_id: doc.employee_id,
        payment_date: payload.payment_date,
        payment_amount: payload.payment_amount,
        commission: payload.commission,
        total_amount: payload.total_amount,
        payer_full_name: payload.payer_full_name,
        payer_inn: payload.payer_inn,
        payer_passport: payload.payer_passport,
        document_number: payload.document_number,
        payment_purpose: payload.payment_purpose,
        patent_number: payload.patent_number,
        patent_issue_date: payload.patent_issue_date,
        kbk: payload.kbk,
        oktmo: payload.oktmo,
        uin: payload.uin,
        recipient_name: payload.recipient_name,
        recipient_inn: payload.recipient_inn,
        recipient_kpp: payload.recipient_kpp,
        recipient_bank_name: payload.recipient_bank_name,
        recipient_bank_bic: payload.recipient_bank_bic,
        recipient_account: payload.recipient_account,
        recipient_corr_account: payload.recipient_corr_account,
        payer_bank_name: payload.payer_bank_name,
        payer_bank_bic: payload.payer_bank_bic,
        payer_account: payload.payer_account,
        payment_method: payload.payment_method,
        source_type: payload.source_type,
        raw_response: encryptRawResponse(parsed),
        confidence: payload.confidence,
        recognition_model: completion.resolvedModel,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        cost_usd: costUsd,
        needs_review: status === 'needs_review',
        manually_edited: false,
        updated_at: new Date().toISOString(),
      };

      const { data: upserted, error: upsertErr } = await supabase
        .from('patent_payment_receipts')
        .upsert(encryptReceiptFields(upsertRow), { onConflict: 'document_id' })
        .select('id')
        .single();

      if (upsertErr) throw upsertErr;

      await updateDocumentStatus(documentId, status, false);

      return {
        ok: true,
        status,
        receiptId: upserted?.id,
        data: payload,
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
          cost_usd: costUsd,
          model: completion.resolvedModel,
        },
      };
    } catch (err) {
      console.error('[ai-receipt-recognition]', err);
      const errorMessage = err instanceof Error ? err.message : 'unknown error';
      Sentry.captureException(err, {
        tags: { service: 'ai-receipt-recognition', stage: 'recognize' },
        extra: {
          documentId,
          rawLlmContent: rawLlmContent ? rawLlmContent.slice(0, 4000) : null,
        },
      });
      await updateDocumentStatus(documentId, 'failed', false, errorMessage);
      return {
        ok: false,
        status: 'failed',
        error: errorMessage,
      };
    }
  },

  /**
   * Поставить распознавание в очередь (fire-and-forget).
   * Если OpenRouter не настроен — тихо выходим, не меняя status.
   */
  async enqueueRecognition(documentId: number): Promise<void> {
    try {
      const { settingsService } = await import('./settings.service.js');
      const config = await settingsService.getResolvedOpenRouterConfig();
      if (!config) {
        console.warn(`[ai-receipt-recognition] OpenRouter не настроен, пропускаем документ ${documentId}`);
        return;
      }

      await supabase
        .from('documents')
        .update({ recognition_status: 'pending' })
        .eq('id', documentId)
        .is('recognition_status', null);

      setImmediate(() => {
        void this.recognizePatentReceipt(documentId).catch(err =>
          console.error(`[ai-receipt-recognition] enqueue ${documentId}`, err),
        );
      });
    } catch (err) {
      console.error('[ai-receipt-recognition.enqueue]', err);
      Sentry.captureException(err, {
        tags: { service: 'ai-receipt-recognition', stage: 'enqueue' },
        extra: { documentId },
      });
    }
  },

  /**
   * Восстановить зависшие задачи при старте сервера.
   */
  async resumePendingRecognitions(): Promise<number> {
    const { data, error } = await supabase
      .from('documents')
      .select('id')
      .eq('category', 'patent_check')
      .in('recognition_status', ['pending', 'processing'])
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

    if (error || !data) return 0;

    for (const row of data as { id: number }[]) {
      setImmediate(() => {
        void this.recognizePatentReceipt(row.id).catch(err =>
          console.error(`[ai-receipt-recognition] resume ${row.id}`, err),
        );
      });
    }

    return data.length;
  },
};
