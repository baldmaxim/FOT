import { Response } from 'express';
import * as Sentry from '@sentry/node';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../types/index.js';
import { mtsBusinessSubscribersService } from '../services/mts-business-subscribers.service.js';
import { syncSubscriberFull } from '../services/mts-business-subscriber-sync.service.js';
import { mtsBusinessMappingService } from '../services/mts-business-mapping.service.js';
import { mtsBusinessCatalogService } from '../services/mts-business-catalog.service.js';
import { mtsBusinessActionsService } from '../services/mts-business-actions.service.js';
import { mtsBusinessDataService } from '../services/mts-business-data.service.js';
import { mtsBusinessCdrService, msisdnHash } from '../services/mts-business-cdr.service.js';
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

  /**
   * Детальная выписка по использованию SIM (вкладка «Использование»): живой
   * вызов Bills/BillingStatementExtdByMSISDN → события с датой/типом/объёмом/
   * деньгами. Период: ?month=YYYY-MM (весь месяц) или ?date=YYYY-MM-DD (один
   * день). Собеседники резолвятся в имена абонентов из нашей базы (peerName).
   * При 403/1010 — {unavailable:true}.
   */
  async usage(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const msisdn = String(req.params.msisdn || '').trim();
      const month = String(req.query.month || '').trim();
      const date = String(req.query.date || '').trim();

      let dateFrom: string;
      let dateTo: string;
      let period: string;
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        dateFrom = date;
        dateTo = date;
        period = date;
      } else {
        const m = /^(\d{4})-(\d{2})$/.exec(month);
        if (!m) {
          res.status(400).json({ success: false, error: 'Укажите month=YYYY-MM или date=YYYY-MM-DD' });
          return;
        }
        const lastDay = new Date(Number(m[1]), Number(m[2]), 0).getDate();
        dateFrom = `${month}-01`;
        dateTo = `${month}-${String(lastDay).padStart(2, '0')}`;
        period = month;
      }

      const ctx = await mtsBusinessMappingService.getSubscriberContext(msisdn);
      if (!ctx) {
        res.status(404).json({ success: false, error: 'Номер не найден или не определён лицевой счёт' });
        return;
      }
      try {
        const resp = await mtsBusinessDataService.getBillingStatementExtdByMsisdn(ctx.accountId, { msisdn, dateFrom, dateTo });
        const parsed = mtsBusinessCdrService.parseStatementUsageRows(resp);
        // Собеседник — конкретный абонент, если его номер есть в нашей базе.
        const names = await mtsBusinessMappingService.getNamesByMsisdnHash();
        const rows = parsed.map(r => {
          const hash = r.peer ? msisdnHash(r.peer) : null;
          return { ...r, peerName: hash ? names.get(hash) ?? null : null };
        });
        const total = rows.reduce((a, r) => a + r.amount, 0);
        res.json({ success: true, data: { month: period, rows, total } });
      } catch (error) {
        if (isFeatureUnavailable(error)) {
          res.json({ success: true, data: { month: period, unavailable: true, reason: 'MTS_FEATURE_NOT_CONNECTED' } });
          return;
        }
        throw error;
      }
    } catch (error) {
      fail(res, error, 'Ошибка получения выписки по использованию');
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
