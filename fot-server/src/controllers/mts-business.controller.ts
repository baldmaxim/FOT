import { Response } from 'express';
import * as Sentry from '@sentry/node';
import type { AuthenticatedRequest } from '../types/index.js';
import { mtsBusinessAccountsService } from '../services/mts-business-accounts.service.js';
import { mtsBusinessDataService, type IMtsBusinessOrderInput } from '../services/mts-business-data.service.js';
import { mtsBusinessCdrService } from '../services/mts-business-cdr.service.js';
import { mtsBusinessMappingService } from '../services/mts-business-mapping.service.js';
import { MtsBusinessApiError } from '../services/mts-business-base.service.js';
import { MtsBusinessAuthError } from '../services/mts-business-auth.service.js';
import { auditService, AUDIT_ACTIONS } from '../services/audit.service.js';
import { query, execute, queryOne } from '../config/postgres.js';
import { encryptionService } from '../services/encryption.service.js';

// МТС «Бизнес» — детализация звонков (время разговоров). Мультиаккаунт (несколько
// API/лицевых счетов). Безопасность как в /mts: ошибки апстрима без тела (ПДн),
// креды/номера шифруются, аудит на изменения. Полный доступ — is_admin.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isValidationError = (error: unknown): boolean =>
  error instanceof Error && (
    error.message.startsWith('MTS Business base URL')
    || error.message.includes('аккаунт')
    || error.message.includes('Аккаунт')
    || error.message.includes('логин')
    || error.message.includes('название')
    || error.message.includes('Название')
    || error.message.includes('номер')
    || error.message.includes('Сотрудник')
  );

const fail = (res: Response, error: unknown, fallback: string): void => {
  if (error instanceof MtsBusinessApiError || error instanceof MtsBusinessAuthError) {
    console.error(`[mts-biz] upstream error: http=${error.status}`);
    Sentry.captureException(error, { tags: { module: 'mts-business', kind: 'upstream' } });
    res.status(502).json({ success: false, error: fallback, mtsHttp: error.status, mtsMessage: error.message });
    return;
  }
  if (isValidationError(error)) {
    res.status(400).json({ success: false, error: (error as Error).message });
    return;
  }
  const msg = error instanceof Error ? error.message : 'unknown';
  console.error(`[mts-biz] ${fallback}: ${msg}`);
  Sentry.captureException(error, { tags: { module: 'mts-business', kind: 'generic' } });
  res.status(500).json({ success: false, error: fallback, internal: msg });
};

export const mtsBusinessController = {
  // === Аккаунты (несколько API/лицевых счетов) ===
  async listAccounts(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      res.json({ success: true, data: await mtsBusinessAccountsService.list() });
    } catch (error) {
      fail(res, error, 'Ошибка получения аккаунтов МТС Бизнес');
    }
  },

  async createAccount(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { label, accountNumber, login, password, baseUrl } = req.body as {
        label?: string; accountNumber?: string | null; login?: string; password?: string; baseUrl?: string | null;
      };
      const data = await mtsBusinessAccountsService.create(
        { label: label ?? '', accountNumber, login: login ?? '', password: password ?? '', baseUrl },
        req.user.id,
      );
      mtsBusinessDataService.invalidate();
      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.MTS_BUSINESS_ACCOUNT_CREATED, {
        details: { label, accountNumber: accountNumber ?? null },
      });
      res.json({ success: true, data });
    } catch (error) {
      fail(res, error, 'Ошибка создания аккаунта МТС Бизнес');
    }
  },

  async updateAccount(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { label, accountNumber, login, password, baseUrl, isActive } = req.body as {
        label?: string; accountNumber?: string | null; login?: string; password?: string | null; baseUrl?: string | null; isActive?: boolean;
      };
      const data = await mtsBusinessAccountsService.update(
        req.params.id,
        { label, accountNumber, login, password, baseUrl, isActive },
        req.user.id,
      );
      mtsBusinessDataService.invalidate();
      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.MTS_BUSINESS_ACCOUNT_UPDATED, {
        entityId: req.params.id,
        details: { passwordChanged: password !== undefined && password !== null && password !== '' },
      });
      res.json({ success: true, data });
    } catch (error) {
      fail(res, error, 'Ошибка изменения аккаунта МТС Бизнес');
    }
  },

  async deleteAccount(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const data = await mtsBusinessAccountsService.remove(req.params.id);
      mtsBusinessDataService.invalidate();
      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.MTS_BUSINESS_ACCOUNT_DELETED, {
        entityId: req.params.id,
      });
      res.json({ success: true, data });
    } catch (error) {
      fail(res, error, 'Ошибка удаления аккаунта МТС Бизнес');
    }
  },

  async testAccount(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      await mtsBusinessDataService.testConnection(req.params.id);
      res.json({ success: true, data: { ok: true } });
    } catch (error) {
      const status = error instanceof MtsBusinessApiError || error instanceof MtsBusinessAuthError ? error.status : 0;
      res.json({
        success: true,
        data: { ok: false, error: error instanceof Error ? error.message : 'unknown', mtsHttp: status },
      });
    }
  },

  // === Заказ детализации ===
  async orderDetalization(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { accountId, scope, targets, dateFrom, dateTo, deliveryAddress, confirmed } = req.body as {
        accountId?: string; scope?: string; targets?: unknown;
        dateFrom?: string; dateTo?: string; deliveryAddress?: string; confirmed?: boolean;
      };

      if (confirmed !== true) {
        res.status(400).json({ success: false, error: 'Требуется подтверждение (confirmed=true)' });
        return;
      }
      if (!accountId) {
        res.status(400).json({ success: false, error: 'Выберите аккаунт' });
        return;
      }
      const scopeVal = scope === 'account' ? 'account' : 'msisdn';
      const list = Array.isArray(targets) ? targets.map(t => String(t).trim()).filter(Boolean) : [];
      if (list.length === 0) {
        res.status(400).json({ success: false, error: 'Укажите хотя бы один номер/лицевой счёт' });
        return;
      }
      if (!dateFrom || !dateTo || !DATE_RE.test(dateFrom) || !DATE_RE.test(dateTo)) {
        res.status(400).json({ success: false, error: 'Даты периода должны быть в формате YYYY-MM-DD' });
        return;
      }
      if (!deliveryAddress || !deliveryAddress.includes('@')) {
        res.status(400).json({ success: false, error: 'Укажите корректный email для доставки документа' });
        return;
      }

      const input: IMtsBusinessOrderInput = { targets: list, dateFrom, dateTo, deliveryAddress };
      const { messageId } = scopeVal === 'account'
        ? await mtsBusinessDataService.orderCallDetailByAccount(accountId, input)
        : await mtsBusinessDataService.orderCallDetailByMsisdn(accountId, input);

      await execute(
        `INSERT INTO mts_business_detalization_requests
           (message_id, account_id, scope, target_enc, date_from, date_to, status, requested_by, requested_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'in_progress', $7, NOW())
         ON CONFLICT (message_id) DO UPDATE
           SET status = 'in_progress', checked_at = NULL, account_id = EXCLUDED.account_id`,
        [messageId, accountId, scopeVal, encryptionService.encrypt(JSON.stringify(list)), dateFrom, dateTo, req.user.id],
      );

      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.MTS_BUSINESS_DETALIZATION_ORDERED, {
        details: { accountId, scope: scopeVal, count: list.length, dateFrom, dateTo },
      });

      res.json({ success: true, data: { messageId } });
    } catch (error) {
      fail(res, error, 'Ошибка заказа детализации МТС Бизнес');
    }
  },

  async listRequests(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const rows = await query<{
        message_id: string; account_id: string | null; scope: string; target_enc: string | null;
        date_from: string; date_to: string; status: string; requested_at: string; checked_at: string | null;
      }>(
        `SELECT message_id, account_id, scope, target_enc, date_from, date_to, status, requested_at, checked_at
           FROM mts_business_detalization_requests
          ORDER BY requested_at DESC
          LIMIT 200`,
      );
      const data = rows.map(r => {
        let targets: string[] = [];
        const dec = encryptionService.decryptField(r.target_enc);
        if (dec) { try { targets = JSON.parse(dec) as string[]; } catch { targets = []; } }
        return {
          messageId: r.message_id,
          accountId: r.account_id,
          scope: r.scope,
          targetCount: targets.length,
          dateFrom: r.date_from,
          dateTo: r.date_to,
          status: r.status,
          requestedAt: r.requested_at,
          checkedAt: r.checked_at,
        };
      });
      res.json({ success: true, data });
    } catch (error) {
      fail(res, error, 'Ошибка получения списка заявок');
    }
  },

  async refreshStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const messageId = req.params.id;
      const row = await queryOne<{ account_id: string | null }>(
        'SELECT account_id FROM mts_business_detalization_requests WHERE message_id = $1',
        [messageId],
      );
      if (!row) { res.status(404).json({ success: false, error: 'Заявка не найдена' }); return; }
      if (!row.account_id) { res.status(400).json({ success: false, error: 'У заявки не задан аккаунт' }); return; }
      const { status } = await mtsBusinessDataService.checkRequestStatus(row.account_id, messageId);
      await execute(
        `UPDATE mts_business_detalization_requests SET status = $2, checked_at = NOW() WHERE message_id = $1`,
        [messageId, status],
      );
      res.json({ success: true, data: { messageId, status } });
    } catch (error) {
      fail(res, error, 'Ошибка проверки статуса заявки');
    }
  },

  /** Загрузка детализации (XLS/XML) → парсинг → сохранение CDR. */
  async uploadDetalization(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const file = (req as AuthenticatedRequest & { file?: { buffer: Buffer; originalname?: string } }).file;
      if (!file || !file.buffer || file.buffer.length === 0) {
        res.status(400).json({ success: false, error: 'Файл детализации (XLS/XML) не передан' });
        return;
      }
      const { sourceMessageId, msisdn } = req.body as { sourceMessageId?: string; msisdn?: string };
      const result = await mtsBusinessCdrService.parseFileAndStore(
        file.buffer,
        file.originalname || 'upload.xls',
        sourceMessageId?.trim() || null,
        msisdn?.trim() || null,
      );

      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.MTS_BUSINESS_DETALIZATION_UPLOADED, {
        details: { fileName: file.originalname ?? null, parsed: result.parsed, inserted: result.inserted, skipped: result.skipped },
      });

      res.json({ success: true, data: result });
    } catch (error) {
      fail(res, error, 'Ошибка обработки файла детализации');
    }
  },

  // === Привязка номеров ===
  async getNumberMap(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      res.json({ success: true, data: await mtsBusinessMappingService.getNumberMap() });
    } catch (error) {
      fail(res, error, 'Ошибка получения привязок номеров');
    }
  },

  async setNumberMap(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { msisdn, employeeId } = req.body as { msisdn?: string; employeeId?: number | null };
      if (!msisdn) { res.status(400).json({ success: false, error: 'Укажите номер телефона' }); return; }
      const data = await mtsBusinessMappingService.setNumberMap(msisdn, employeeId ?? null, req.user.id);
      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.MTS_BUSINESS_NUMBER_MAP_UPDATED, {
        details: { employeeId: employeeId ?? null },
      });
      res.json({ success: true, data });
    } catch (error) {
      fail(res, error, 'Ошибка сохранения привязки номера');
    }
  },

  // === Отчёт ===
  async getTalkTimeReport(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const from = String(req.query.from || '');
      const to = String(req.query.to || '');
      if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
        res.status(400).json({ success: false, error: 'Параметры from/to должны быть в формате YYYY-MM-DD' });
        return;
      }
      res.json({ success: true, data: await mtsBusinessCdrService.getTalkTimeReport(from, to) });
    } catch (error) {
      fail(res, error, 'Ошибка формирования отчёта времени разговоров');
    }
  },
};
