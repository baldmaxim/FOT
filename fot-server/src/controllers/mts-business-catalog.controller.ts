import { Response } from 'express';
import * as Sentry from '@sentry/node';
import type { AuthenticatedRequest } from '../types/index.js';
import { mtsBusinessAccountsService } from '../services/mts-business-accounts.service.js';
import { mtsBusinessMetricsStoreService } from '../services/mts-business-metrics-store.service.js';
import { refreshAccountCatalog } from '../services/mts-business-metrics-daily-scheduler.service.js';
import { MtsBusinessApiError } from '../services/mts-business-base.service.js';
import { auditService, AUDIT_ACTIONS } from '../services/audit.service.js';

// Тариф/услуги/остатки пакетов/структура абонента — обогащение вкладки
// «Финансы». Как и billing: читается из истории, обновляется вручную
// («Обновить каталог») + еженедельным кадансом планировщика.

const fail = (res: Response, error: unknown, fallback: string): void => {
  if (error instanceof MtsBusinessApiError) {
    console.error(`[mts-biz-catalog] upstream error: http=${error.status}`);
    Sentry.captureException(error, { tags: { module: 'mts-business-catalog', kind: 'upstream' } });
    res.status(502).json({ success: false, error: fallback, mtsHttp: error.status, mtsMessage: error.message });
    return;
  }
  const msg = error instanceof Error ? error.message : 'unknown';
  console.error(`[mts-biz-catalog] ${fallback}: ${msg}`);
  Sentry.captureException(error, { tags: { module: 'mts-business-catalog', kind: 'generic' } });
  res.status(500).json({ success: false, error: fallback, internal: msg });
};

export const mtsBusinessCatalogController = {
  /** Тариф/кол-во и сумма платных услуг по каждому привязанному к сотруднику номеру. */
  async getEmployeesCatalog(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const accountId = req.query.accountId ? String(req.query.accountId) : null;
      const data = await mtsBusinessMetricsStoreService.getEmployeesCatalogSummary(accountId);
      res.json({ success: true, data });
    } catch (error) {
      fail(res, error, 'Ошибка получения каталога по сотрудникам');
    }
  },

  /** Остатки пакетов минут/SMS/интернета по каждому активному ЛС. */
  async getAccountsPackages(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const data = await mtsBusinessMetricsStoreService.getAccountsPackagesSummary();
      res.json({ success: true, data });
    } catch (error) {
      fail(res, error, 'Ошибка получения остатков пакетов');
    }
  },

  /** Ручное обновление каталога (тариф/услуги/пакеты/структура) по аккаунту (или всем активным). */
  async refresh(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { accountId, confirmed } = req.body as { accountId?: string; confirmed?: boolean };
      if (confirmed !== true) {
        res.status(400).json({ success: false, error: 'Требуется подтверждение (confirmed=true)' });
        return;
      }
      const accounts = accountId
        ? (await mtsBusinessAccountsService.list()).filter(a => a.id === accountId)
        : (await mtsBusinessAccountsService.list()).filter(a => a.isActive);
      if (accounts.length === 0) {
        res.status(400).json({ success: false, error: 'Аккаунт не найден или неактивен' });
        return;
      }

      const results = [];
      for (const account of accounts) {
        results.push(await refreshAccountCatalog(account.id));
      }

      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.MTS_BUSINESS_METRICS_REFRESHED, {
        details: { accountId: accountId ?? null, accounts: accounts.length, kind: 'catalog' },
      });

      res.json({ success: true, data: { results } });
    } catch (error) {
      fail(res, error, 'Ошибка обновления каталога');
    }
  },
};
