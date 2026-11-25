// Ведомости выплаты из 1С по API (миграция 379):
//  - POST /api/public/v1/payroll/payouts[?dry_run=1] — тело XML «зп_документы_31» (тот же файл, что «Выгрузить данные»),
//    Content-Type application/xml или text/xml, до 25 МБ; у каждой ведомости — «Док_Версия»;
//  - POST /api/public/v1/payroll/payouts/cancel — { documents: [{ guid, version }] }: распроведение или удаление в 1С.
// Право ключа — allow_payroll_payouts_import. Правила и запись — services/payroll/payroll-1c-payouts.api.*.

import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { Payout1cParseError } from '../services/payroll/payroll-1c-payouts.parser.js';
import { PAYOUT_API_MAX_DOCS } from '../services/payroll/payroll-1c-payouts.month-xml.js';
import { applyPayoutsApi, cancelPayoutsApi, PayoutApiError } from '../services/payroll/payroll-1c-payouts.api.service.js';
import { fail, keyOf } from './public-data-api.helpers.js';

export const PAYOUTS_BODY_LIMIT = '25mb';
const BUSY_RETRY_AFTER_SECONDS = 5;
const XML_TYPE_RE = /^(application|text)\/xml\b/i;

const cancelSchema = z.object({
  documents: z.array(z.object({
    guid: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'guid — UUID документа'),
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })).min(1).max(PAYOUT_API_MAX_DOCS),
});

/** Ключ без права — 403; ключа нет — 401 (до контроллера его не пропустит dataApiAuth). */
const allowed = (req: Request, res: Response): boolean => {
  const key = keyOf(req);
  if (!key) {
    fail(res, 401, 'Unauthorized');
    return false;
  }
  if (!key.allow_payroll_payouts_import) {
    fail(res, 403, 'Ключу не разрешён приём ведомостей выплаты из 1С (allow_payroll_payouts_import)', 'forbidden', { retryable: false });
    return false;
  }
  return true;
};

const sendError = (res: Response, err: unknown, where: string): void => {
  if (err instanceof Payout1cParseError) {
    fail(res, 400, err.message, 'invalid_xml', { retryable: false, errors: [] });
    return;
  }
  if (err instanceof PayoutApiError) {
    if (err.code === 'busy') res.setHeader('Retry-After', String(BUSY_RETRY_AFTER_SECONDS));
    fail(res, err.status, err.message, err.code, { retryable: err.retryable, errors: err.details });
    return;
  }
  console.error(`publicPayouts.${where} error:`, err instanceof Error ? err.message : err);
  fail(res, 500, 'Ошибка сервера', 'internal_error', { retryable: true });
};

export const publicPayoutsController = {
  async post(req: Request, res: Response): Promise<void> {
    if (!allowed(req, res)) return;
    if (!XML_TYPE_RE.test(String(req.headers['content-type'] ?? ''))) {
      fail(res, 415, 'Нужен Content-Type: application/xml (файл «Выгрузить данные» 1С)', 'unsupported_media_type', { retryable: false });
      return;
    }
    const dryRunRaw = req.query.dry_run;
    if (dryRunRaw !== undefined && !['0', '1', 'true', 'false'].includes(String(dryRunRaw))) {
      fail(res, 400, 'dry_run — 1 или 0', 'invalid_body', { retryable: false, errors: [] });
      return;
    }
    const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (body.trim() === '') {
      fail(res, 400, 'Пустое тело — нужен XML ведомостей', 'empty_body', { retryable: false, errors: [] });
      return;
    }
    const dryRun = dryRunRaw === '1' || dryRunRaw === 'true';
    try {
      const documents = await applyPayoutsApi({ xml: body, keyId: keyOf(req)?.id ?? null, dryRun });
      res.json({ success: true, dry_run: dryRun, documents });
    } catch (err) {
      sendError(res, err, 'post');
    }
  },

  async cancel(req: Request, res: Response): Promise<void> {
    if (!allowed(req, res)) return;
    const parsed = cancelSchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, 400, parsed.error.errors.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '), 'invalid_body',
        { retryable: false, errors: [] });
      return;
    }
    const guids = parsed.data.documents.map(item => item.guid.toLowerCase());
    if (new Set(guids).size !== guids.length) {
      fail(res, 400, 'ГУИД в запросе повторяется', 'invalid_body', { retryable: false, errors: [] });
      return;
    }
    try {
      const documents = await cancelPayoutsApi({
        items: parsed.data.documents.map((item, index) => ({ guid: guids[index], version: item.version })),
        keyId: keyOf(req)?.id ?? null,
        bodySha: createHash('sha256').update(JSON.stringify(req.body), 'utf8').digest('hex'),
      });
      res.json({ success: true, documents });
    } catch (err) {
      sendError(res, err, 'cancel');
    }
  },
};

/** Тело больше PAYOUTS_BODY_LIMIT — 413 (иначе общий обработчик дал бы 500). */
export const payoutsBodyErrorHandler = (err: unknown, _req: Request, res: Response, next: NextFunction): void => {
  const type = (err as { type?: string } | null)?.type;
  if (type === 'entity.too.large') {
    fail(res, 413, `Тело больше ${PAYOUTS_BODY_LIMIT}`, 'payload_too_large', { retryable: false });
    return;
  }
  next(err);
};
