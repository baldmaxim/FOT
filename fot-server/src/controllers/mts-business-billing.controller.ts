import { Response } from 'express';
import * as Sentry from '@sentry/node';
import type { AuthenticatedRequest } from '../types/index.js';
import { mtsBusinessAccountsService } from '../services/mts-business-accounts.service.js';
import { mtsBusinessMetricsStoreService, type MtsBusinessDailyMetric } from '../services/mts-business-metrics-store.service.js';
import { refreshAccountMetrics } from '../services/mts-business-metrics-daily-scheduler.service.js';
import { MtsBusinessApiError } from '../services/mts-business-base.service.js';
import { auditService, AUDIT_ACTIONS } from '../services/audit.service.js';

// МТС «Бизнес» — вкладка «Финансы» (баланс/начисления/неоплаченные счета).
// Читающие эндпоинты обслуживаются из истории (mts_business_metric_daily),
// не бьют в живой API МТС на каждое открытие страницы. Обновление данных —
// ручное («Обновить сейчас», как «Загрузить за период» у CDR) + ежедневный
// планировщик (mts-business-metrics-daily-scheduler.service.ts).

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED_METRICS: MtsBusinessDailyMetric[] = ['balance', 'credit_limit', 'unpaid_amount', 'charges_amount'];

const fail = (res: Response, error: unknown, fallback: string): void => {
  if (error instanceof MtsBusinessApiError) {
    console.error(`[mts-biz-billing] upstream error: http=${error.status}`);
    Sentry.captureException(error, { tags: { module: 'mts-business-billing', kind: 'upstream' } });
    res.status(502).json({ success: false, error: fallback, mtsHttp: error.status, mtsMessage: error.message });
    return;
  }
  const msg = error instanceof Error ? error.message : 'unknown';
  console.error(`[mts-biz-billing] ${fallback}: ${msg}`);
  Sentry.captureException(error, { tags: { module: 'mts-business-billing', kind: 'generic' } });
  res.status(500).json({ success: false, error: fallback, internal: msg });
};

export const mtsBusinessBillingController = {
  /** Последний известный срез по всем активным ЛС и привязанным номерам. */
  async getSummary(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const [accounts, employees] = await Promise.all([
        mtsBusinessMetricsStoreService.getAccountsSummary(),
        mtsBusinessMetricsStoreService.getEmployeesSummary(),
      ]);
      res.json({ success: true, data: { accounts, employees } });
    } catch (error) {
      fail(res, error, 'Ошибка получения сводки по балансам');
    }
  },

  /** Тренд метрики по дням — для графика (по конкретному ЛС или сумма по всем). */
  async getTrend(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const metric = String(req.query.metric || '') as MtsBusinessDailyMetric;
      const from = String(req.query.from || '');
      const to = String(req.query.to || '');
      const accountId = req.query.accountId ? String(req.query.accountId) : null;
      if (!ALLOWED_METRICS.includes(metric)) {
        res.status(400).json({ success: false, error: 'Некорректная метрика' });
        return;
      }
      if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
        res.status(400).json({ success: false, error: 'Параметры from/to должны быть в формате YYYY-MM-DD' });
        return;
      }
      const data = await mtsBusinessMetricsStoreService.getAccountMetricTrend(metric, accountId, from, to);
      res.json({ success: true, data });
    } catch (error) {
      fail(res, error, 'Ошибка получения тренда');
    }
  },

  /**
   * Ручное обновление снимка баланса/начислений по одному аккаунту (или всем
   * активным, если accountId не передан) — та же функция, что использует
   * ежедневный планировщик. Ошибка одного аккаунта не рушит остальные.
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

      const results = [];
      for (const account of accounts) {
        results.push(await refreshAccountMetrics(account.id));
      }

      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.MTS_BUSINESS_METRICS_REFRESHED, {
        details: { accountId: accountId ?? null, accounts: accounts.length },
      });

      res.json({ success: true, data: { results } });
    } catch (error) {
      fail(res, error, 'Ошибка обновления снимка баланса');
    }
  },
};
