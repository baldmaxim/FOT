import { Response } from 'express';
import * as Sentry from '@sentry/node';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../types/index.js';
import { mtsBusinessSubscribersService } from '../services/mts-business-subscribers.service.js';
import { syncSubscriberFull } from '../services/mts-business-subscriber-sync.service.js';
import { syncMsisdnStatement } from '../services/mts-business-statement-sync.service.js';
import { defaultDetalizationWindow } from '../services/mts-business-refresh-all.service.js';
import { mtsBusinessStatementRowsService, parseUsagePeriod, USAGE_ROWS_LIMIT } from '../services/mts-business-statement-rows.service.js';
import { mtsBusinessMappingService } from '../services/mts-business-mapping.service.js';
import { mtsBusinessCatalogService } from '../services/mts-business-catalog.service.js';
import { mtsBusinessActionsService } from '../services/mts-business-actions.service.js';
import { mtsBusinessDataService } from '../services/mts-business-data.service.js';
import { mtsBusinessCdrService, msisdnHash } from '../services/mts-business-cdr.service.js';
import { MtsBusinessApiError, isFeatureUnavailable } from '../services/mts-business-base.service.js';
import {
  FORWARDING_TYPES,
  validateForwardingTarget,
  resolveNoReplyTimer,
} from '../services/mts-forwarding.shared.js';
import { persistForwardingResult, sendForwardingResult } from '../services/mts-forwarding-persist.service.js';
import { auditService, AUDIT_ACTIONS } from '../services/audit.service.js';

// Вкладка «Абоненты»: список/детали из БД, точечный полный синк одного номера,
// живой каталог подключаемого (услуги/блокировки/тарифы), смена тарифа и
// переадресация за абонента (те же write-вызовы МТС, что в ЛК «Моя SIM», но по
// edit-праву на /mts-business — админ может снять переадресацию у уволенного).

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

const setForwardingSchema = z.object({
  accountId: z.string().uuid().optional(),
  msisdn: z.string().min(10).max(20),
  type: z.enum(FORWARDING_TYPES),
  target: z.string().trim().min(1),
  timer: z.coerce.number().int().min(5).max(30).optional(),
  confirmed: z.literal(true),
});

const deleteForwardingSchema = z.object({
  accountId: z.string().uuid().optional(),
  msisdn: z.string().min(10).max(20),
  type: z.enum(FORWARDING_TYPES),
  confirmed: z.literal(true),
});

/** ЛС номера: из запроса либо из маппинга. Отвечает 400 и возвращает null, если не определить. */
const resolveAccountId = async (res: Response, fromBody: string | undefined, msisdn: string): Promise<string | null> => {
  const accountId = fromBody ?? (await mtsBusinessMappingService.getSubscriberContext(msisdn))?.accountId ?? null;
  if (!accountId) {
    res.status(400).json({ success: false, error: 'Не удалось определить лицевой счёт номера' });
    return null;
  }
  return accountId;
};

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
   * Детальная выписка по использованию SIM (вкладка «Использование») — из БД
   * (mts_business_statement_rows, пишется ночным «Обновить всё»). Период:
   * ?month=YYYY-MM (весь месяц) или ?date=YYYY-MM-DD (один день). Собеседники
   * резолвятся в имена абонентов из нашей базы (peerName). Если строк за период
   * в БД нет (месяцы до внедрения) — одноразовый живой fallback с автосохранением
   * (backfill по требованию); при 403/1010 — {unavailable:true}.
   */
  async usage(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const msisdn = String(req.params.msisdn || '').trim();
      const period = parseUsagePeriod(String(req.query.month || '').trim(), String(req.query.date || '').trim());
      if (!period) {
        res.status(400).json({ success: false, error: 'Укажите month=YYYY-MM или date=YYYY-MM-DD' });
        return;
      }

      const hash = msisdnHash(msisdn);
      if (hash) {
        // totals — SQL-агрегат по ВСЕМ строкам периода; rows — детализация с cap'ом.
        // Плитки/статистика считаются по totals, иначе на «тяжёлых» номерах цифры
        // разъезжались бы с ЛК (там итог всегда по агрегату).
        const [stored, totals, days] = await Promise.all([
          mtsBusinessStatementRowsService.getUsageRows(hash, period.dateFrom, period.dateTo),
          mtsBusinessStatementRowsService.getUsageTotals(hash, period.dateFrom, period.dateTo),
          mtsBusinessStatementRowsService.getDailyStats(hash, period.dateFrom, period.dateTo),
        ]);
        if (stored.length > 0) {
          const names = await mtsBusinessMappingService.getNamesByMsisdnHash();
          const rows = stored.map(({ peerHash, ...r }) => ({
            ...r,
            peerName: peerHash ? names.get(peerHash) ?? null : null,
          }));
          res.json({
            success: true,
            data: {
              month: period.period,
              rows,
              totals,
              days,
              total: totals.total,
              truncated: rows.length >= USAGE_ROWS_LIMIT,
            },
          });
          return;
        }
      }

      const ctx = await mtsBusinessMappingService.getSubscriberContext(msisdn);
      if (!ctx) {
        res.status(404).json({ success: false, error: 'Номер не найден или не определён лицевой счёт' });
        return;
      }
      try {
        const resp = await mtsBusinessDataService.getBillingStatementExtdByMsisdn(ctx.accountId, {
          msisdn, dateFrom: period.dateFrom, dateTo: period.dateTo,
        });
        const parsed = mtsBusinessCdrService.parseStatementUsageRows(resp);
        await mtsBusinessStatementRowsService.storeRows(ctx.accountId, msisdn, parsed, 'backfill');
        // Строки сохранены — сводки берём тем же SQL-агрегатом, что и в основной
        // ветке, чтобы бэкфилл-ответ не считался по другой методике.
        const hashAfter = msisdnHash(msisdn);
        const [totals, days] = hashAfter
          ? await Promise.all([
            mtsBusinessStatementRowsService.getUsageTotals(hashAfter, period.dateFrom, period.dateTo),
            mtsBusinessStatementRowsService.getDailyStats(hashAfter, period.dateFrom, period.dateTo),
          ])
          : [{ groups: [], total: 0 }, []];
        // Собеседник — конкретный абонент, если его номер есть в нашей базе.
        const names = await mtsBusinessMappingService.getNamesByMsisdnHash();
        const rows = parsed.slice(0, USAGE_ROWS_LIMIT).map(r => {
          const peerHash = r.peer ? msisdnHash(r.peer) : null;
          return { ...r, peerName: peerHash ? names.get(peerHash) ?? null : null };
        });
        res.json({
          success: true,
          data: {
            month: period.period,
            rows,
            totals,
            days,
            total: totals.total,
            truncated: parsed.length > USAGE_ROWS_LIMIT,
          },
        });
      } catch (error) {
        if (isFeatureUnavailable(error)) {
          res.json({ success: true, data: { month: period.period, unavailable: true, reason: 'MTS_FEATURE_NOT_CONNECTED' } });
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
      // Освежаем и выписку (звонки/строки/начисления) за текущий месяц — кнопка
      // «Обновить данные» должна обновлять вкладку «Использование». Не фатально.
      try {
        const w = defaultDetalizationWindow();
        await syncMsisdnStatement(ctx.accountId, msisdn, w.dateFrom, w.dateTo, null, 'manual');
      } catch (e) {
        console.warn(`[mts-biz-subscribers] refresh statement failed: ${e instanceof Error ? e.message : 'unknown'}`);
      }
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

  /**
   * Включить/изменить переадресацию ЗА абонента (админ). Тот же write-вызов МТС,
   * что и в самообслуживании ЛК «Моя SIM», но без проверки «номер мой» — скоуп
   * даёт edit-право на /mts-business + critical-2FA. Асинхронно: вернём eventId,
   * снапшот правил перепишет статус-поллер по completed.
   */
  async setForwarding(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const parsed = setForwardingSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, error: 'Некорректный запрос', details: parsed.error.flatten() });
        return;
      }
      const { msisdn, type } = parsed.data;
      const target = validateForwardingTarget(parsed.data.target, msisdn);
      if (!target.ok) {
        res.status(400).json({ success: false, error: target.error });
        return;
      }
      const accountId = await resolveAccountId(res, parsed.data.accountId, msisdn);
      if (!accountId) return;
      const timer = resolveNoReplyTimer(type, parsed.data.timer);

      const result = await mtsBusinessCatalogService.changeCallForwarding(accountId, msisdn, 'create', {
        forwardingType: type,
        forwardingAddress: target.value,
        noReplyTimer: timer,
      });
      const { tracking } = await persistForwardingResult({
        result, accountId, msisdn, actionType: 'forwarding_set',
        payload: { type, target: target.value, timer }, requestedBy: req.user.id,
        // В аудит номер назначения целиком не пишем — только тип правила и хвост.
        audit: () => auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.MTS_BUSINESS_FORWARDING_SET_REQUESTED, {
          details: { accountId, type, timer, targetTail: target.value.slice(-4), outcome: result.outcome },
        }),
      });
      sendForwardingResult(res, result, tracking);
    } catch (error) {
      fail(res, error, 'Ошибка включения переадресации');
    }
  },

  /** Снять переадресацию за абонента (напр. у уволенного сотрудника). */
  async deleteForwarding(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const parsed = deleteForwardingSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, error: 'Некорректный запрос', details: parsed.error.flatten() });
        return;
      }
      const { msisdn, type } = parsed.data;
      const accountId = await resolveAccountId(res, parsed.data.accountId, msisdn);
      if (!accountId) return;

      const result = await mtsBusinessCatalogService.changeCallForwarding(accountId, msisdn, 'delete', {
        forwardingType: type,
      });
      const { tracking } = await persistForwardingResult({
        result, accountId, msisdn, actionType: 'forwarding_remove',
        payload: { type }, requestedBy: req.user.id,
        audit: () => auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.MTS_BUSINESS_FORWARDING_REMOVE_REQUESTED, {
          details: { accountId, type, outcome: result.outcome },
        }),
      });
      sendForwardingResult(res, result, tracking);
    } catch (error) {
      fail(res, error, 'Ошибка отключения переадресации');
    }
  },
};
