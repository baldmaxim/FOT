// Увольнение из 1С ЗУП3 (POST /api/public/v1/payroll/dismissals[?dry_run=1]): приказ, компенсация отпуска, выходное
// пособие. Право ключа — allow_payroll_dismissal_import. Разбор — payroll-1c-dismissals.rules, запись —
// payroll-1c-dismissals.service (одна транзакция, dry_run — с откатом).

import type { Request, Response } from 'express';
import { parseDismissalBatch } from '../services/payroll/payroll-1c-dismissals.rules.js';
import { applyDismissalBatch, DismissalApiError } from '../services/payroll/payroll-1c-dismissals.service.js';
import { fail, keyOf } from './public-data-api.helpers.js';

const BUSY_RETRY_AFTER_SECONDS = 5;

export const publicDismissalsController = {
  async post(req: Request, res: Response): Promise<void> {
    const key = keyOf(req);
    if (!key) {
      fail(res, 401, 'Unauthorized');
      return;
    }
    if (!key.allow_payroll_dismissal_import) {
      fail(res, 403, 'Ключу не разрешён приём увольнений из 1С (allow_payroll_dismissal_import)', 'forbidden', { retryable: false });
      return;
    }
    const dryRunRaw = req.query.dry_run;
    if (dryRunRaw !== undefined && !['0', '1', 'true', 'false'].includes(String(dryRunRaw))) {
      fail(res, 400, 'dry_run — 1 или 0', 'invalid_body', { retryable: false, errors: [] });
      return;
    }
    const dryRun = dryRunRaw === '1' || dryRunRaw === 'true';
    const parsed = parseDismissalBatch(req.body);
    if (parsed.errors.length > 0) {
      fail(res, 400, 'Документы не приняты — исправьте указанные поля', 'invalid_body', { retryable: false, errors: parsed.errors });
      return;
    }
    try {
      const documents = await applyDismissalBatch({ docs: parsed.docs, keyId: key.id, dryRun });
      res.json({ success: true, dry_run: dryRun, documents });
    } catch (err) {
      if (err instanceof DismissalApiError) {
        if (err.code === 'busy') res.setHeader('Retry-After', String(BUSY_RETRY_AFTER_SECONDS));
        fail(res, err.status, err.message, err.code, { retryable: err.retryable, errors: err.errors });
        return;
      }
      console.error('publicDismissals.post error:', err);
      fail(res, 500, 'Ошибка сервера', 'internal_error', { retryable: true });
    }
  },
};
