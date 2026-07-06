import { Response } from 'express';
import * as Sentry from '@sentry/node';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../types/index.js';
import { mtsBusinessSubscribersService } from '../services/mts-business-subscribers.service.js';
import { syncSubscriberFull } from '../services/mts-business-subscriber-sync.service.js';
import { mtsBusinessMappingService } from '../services/mts-business-mapping.service.js';
import { mtsBusinessCatalogService } from '../services/mts-business-catalog.service.js';
import { mtsBusinessActionsService } from '../services/mts-business-actions.service.js';
import { MtsBusinessApiError, isFeatureUnavailable } from '../services/mts-business-base.service.js';
import { auditService, AUDIT_ACTIONS } from '../services/audit.service.js';

// Вкладка «Абоненты»: список/детали из БД, точечный полный синк одного номера,
// живой каталог подключаемого (услуги/блокировки/тарифы) и смена тарифа.

const fail = (res: Response, error: unknown, fallback: string): void => {
  if (error instanceof MtsBusinessApiError) {
    console.error(`[mts-biz-subscribers] upstream error: http=${error.status} code=${error.code ?? '-'}`);
    Sentry.captureException(error, { tags: { module: 'mts-business', kind: 'subscribers-upstream' } });
    res.status(502).json({ success: false, error: fallback, mtsHttp: error.status, mtsMessage: error.message });
    return;
  }
  const msg = error instanceof Error ? error.message : 'unknown';
  console.error(`[mts-biz-subscribers] ${fallback}: ${msg}`);
  Sentry.captureException(error, { tags: { module: 'mts-business', kind: 'subscribers' } });
  res.status(500).json({ success: false, error: fallback, internal: msg });
};

const tariffSchema = z.object({
  accountId: z.string().uuid().optional(),
  msisdn: z.string().min(10).max(20),
  externalID: z.string().trim().min(1).max(40),
  confirmed: z.literal(true),
});

type Section<T> = { data: T } | { unavailable: true; reason: 'MTS_FEATURE_NOT_CONNECTED' } | { error: string };

const settleSection = async <T>(fn: () => Promise<T>): Promise<Section<T>> => {
  try {
    return { data: await fn() };
  } catch (e) {
    if (isFeatureUnavailable(e)) return { unavailable: true, reason: 'MTS_FEATURE_NOT_CONNECTED' };
    console.warn(`[mts-biz-subscribers] секция каталога пропущена: ${e instanceof MtsBusinessApiError ? `http=${e.status} code=${e.code ?? '-'}` : 'ошибка'}`);
    return { error: e instanceof MtsBusinessApiError ? `МТС ${e.status}` : 'ошибка' };
  }
};

export const mtsBusinessSubscribersController = {
  /** Список абонентов (таблица) — целиком из БД. */
  async list(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      res.json({ success: true, data: await mtsBusinessSubscribersService.listSubscribers() });
    } catch (error) {
      fail(res, error, 'Ошибка получения списка абонентов');
    }
  },

  /** Детали абонента (боковая панель) — из сохранённых снапшотов, 0 живых вызовов. */
  async details(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const msisdn = String(req.params.msisdn || '').trim();
      const data = await mtsBusinessSubscribersService.getSubscriberDetails(msisdn);
      if (!data) {
        res.status(404).json({ success: false, error: 'Номер не найден или не определён лицевой счёт' });
        return;
      }
      res.json({ success: true, data });
    } catch (error) {
      fail(res, error, 'Ошибка получения данных абонента');
    }
  },

  /** Живой каталог подключаемого: доступные услуги/блокировки/тарифы (3 вызова МТС). */
  async available(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const msisdn = String(req.params.msisdn || '').trim();
      const ctx = await mtsBusinessMappingService.getSubscriberContext(msisdn);
      if (!ctx) {
        res.status(404).json({ success: false, error: 'Номер не найден или не определён лицевой счёт' });
        return;
      }
      const [services, blocks, tariffs] = await Promise.all([
        settleSection(() => mtsBusinessCatalogService.getAvailableServices(ctx.accountId, msisdn)),
        settleSection(() => mtsBusinessCatalogService.getAvailableBlocks(ctx.accountId, msisdn)),
        settleSection(() => mtsBusinessCatalogService.getAvailableTariffs(ctx.accountId, msisdn)),
      ]);
      res.json({ success: true, data: { accountId: ctx.accountId, services, blocks, tariffs } });
    } catch (error) {
      fail(res, error, 'Ошибка получения каталога подключаемого');
    }
  },

  /** Полный синк одного абонента (кнопка «Обновить данные» в панели). */
  async refreshOne(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const msisdn = String(req.params.msisdn || '').trim();
      const { confirmed } = req.body as { confirmed?: boolean };
      if (confirmed !== true) {
        res.status(400).json({ success: false, error: 'Требуется подтверждение (confirmed=true)' });
        return;
      }
      const ctx = await mtsBusinessMappingService.getSubscriberContext(msisdn);
      if (!ctx) {
        res.status(404).json({ success: false, error: 'Номер не найден или не определён лицевой счёт' });
        return;
      }
      const result = await syncSubscriberFull(ctx.accountId, msisdn);
      res.json({ success: true, data: result });
    } catch (error) {
      fail(res, error, 'Ошибка обновления данных абонента');
    }
  },

  /** Смена тарифа — асинхронная заявка (eventId → статус-поллер), critical 2FA. */
  async changeTariff(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const parsed = tariffSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, error: 'Некорректный запрос', details: parsed.error.flatten() });
        return;
      }
      const { msisdn, externalID } = parsed.data;
      let accountId = parsed.data.accountId ?? null;
      if (!accountId) {
        accountId = (await mtsBusinessMappingService.getSubscriberContext(msisdn))?.accountId ?? null;
      }
      if (!accountId) {
        res.status(400).json({ success: false, error: 'Не удалось определить лицевой счёт номера' });
        return;
      }
      const { eventId } = await mtsBusinessCatalogService.changeBillPlan(accountId, msisdn, externalID);
      await mtsBusinessActionsService.create({
        eventId, accountId, scope: 'msisdn', msisdn, actionType: 'tariff_change',
        payload: { externalID }, requestedBy: req.user.id,
      });
      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.MTS_BUSINESS_TARIFF_CHANGE_REQUESTED, {
        details: { accountId, externalID },
      });
      res.json({ success: true, data: { eventId } });
    } catch (error) {
      fail(res, error, 'Ошибка смены тарифа');
    }
  },
};
