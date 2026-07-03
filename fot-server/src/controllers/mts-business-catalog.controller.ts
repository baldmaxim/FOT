import { Response } from 'express';
import * as Sentry from '@sentry/node';
import type { AuthenticatedRequest } from '../types/index.js';
import { mtsBusinessAccountsService } from '../services/mts-business-accounts.service.js';
import { mtsBusinessMetricsStoreService } from '../services/mts-business-metrics-store.service.js';
import { refreshAccountCatalog } from '../services/mts-business-metrics-daily-scheduler.service.js';
import { mtsBusinessCatalogService } from '../services/mts-business-catalog.service.js';
import { mtsBusinessActionsService } from '../services/mts-business-actions.service.js';
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

  /**
   * Ручное обновление каталога (тариф/услуги/пакеты/структура) по аккаунту
   * (или всем активным). Дороже, чем billing-refresh: на каждый номер — до
   * 2-3 вызовов МТС (тариф/услуги/ФИО), плюс структура абонента и пакеты на
   * ЛС. Отвечаем сразу (started), работа идёт в фоне — иначе таймаут.
   */
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

      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.MTS_BUSINESS_METRICS_REFRESHED, {
        details: { accountId: accountId ?? null, accounts: accounts.length, kind: 'catalog' },
      });

      res.json({ success: true, data: { started: true, accounts: accounts.length } });

      void Promise.all(accounts.map(a => refreshAccountCatalog(a.id)))
        .then(results => {
          const discovered = results.reduce((sum, r) => sum + r.discovered, 0);
          const failed = results.reduce((sum, r) => sum + r.failed, 0);
          console.log(`[mts-biz-catalog] фоновое обновление завершено: ЛС=${results.length} discovered=${discovered} failed=${failed}`);
        })
        .catch(error => {
          console.error('[mts-biz-catalog] фоновое обновление упало:', error instanceof Error ? error.message : 'unknown');
          Sentry.captureException(error, { tags: { module: 'mts-business-catalog', kind: 'background-refresh' } });
        });
    } catch (error) {
      fail(res, error, 'Ошибка запуска обновления каталога');
    }
  },

  /** Добавить/удалить услугу или добровольную блокировку — общий ModifyProduct, различаются action_type для аудита/статуса. */
  async modifyService(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { accountId, msisdn, externalID, kind, mode, confirmed } = req.body as {
        accountId?: string; msisdn?: string; externalID?: string;
        kind?: 'service' | 'block'; mode?: 'add' | 'remove'; confirmed?: boolean;
      };
      if (confirmed !== true) { res.status(400).json({ success: false, error: 'Требуется подтверждение (confirmed=true)' }); return; }
      if (!accountId || !msisdn || !externalID || (kind !== 'service' && kind !== 'block') || (mode !== 'add' && mode !== 'remove')) {
        res.status(400).json({ success: false, error: 'Укажите accountId, msisdn, externalID, kind (service|block) и mode (add|remove)' });
        return;
      }
      const { eventId } = await mtsBusinessCatalogService.modifyProduct(accountId, msisdn, mode === 'add' ? 'create' : 'delete', externalID);
      const actionType = `${kind}_${mode}` as const;
      await mtsBusinessActionsService.create({
        eventId, accountId, scope: 'msisdn', msisdn, actionType, payload: { externalID }, requestedBy: req.user.id,
      });
      const auditAction = kind === 'service'
        ? (mode === 'add' ? AUDIT_ACTIONS.MTS_BUSINESS_SERVICE_ADD_REQUESTED : AUDIT_ACTIONS.MTS_BUSINESS_SERVICE_REMOVE_REQUESTED)
        : (mode === 'add' ? AUDIT_ACTIONS.MTS_BUSINESS_BLOCK_ADD_REQUESTED : AUDIT_ACTIONS.MTS_BUSINESS_BLOCK_REMOVE_REQUESTED);
      await auditService.logFromRequest(req, req.user.id, auditAction, { details: { accountId, externalID } });
      res.json({ success: true, data: { eventId } });
    } catch (error) {
      fail(res, error, 'Ошибка изменения услуги/блокировки');
    }
  },

  /** Список заявок на управляющие действия (для бейджей «в обработке» на фронте). */
  async getActions(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const data = await mtsBusinessActionsService.list();
      res.json({ success: true, data });
    } catch (error) {
      fail(res, error, 'Ошибка получения списка заявок');
    }
  },
};
