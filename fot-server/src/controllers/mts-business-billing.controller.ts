import { Response } from 'express';
import * as Sentry from '@sentry/node';
import type { AuthenticatedRequest } from '../types/index.js';
import { moscowTodayIso } from '../utils/date.utils.js';
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
  /**
   * Сводка: последний срез по ЛС (баланс/лимит/неоплаченные) + начисления по
   * сотрудникам ЗА ПЕРИОД ?from/?to (YYYY-MM-DD; по умолчанию — с 1-го числа
   * текущего месяца МСК по сегодня).
   */
  async getSummary(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const today = moscowTodayIso();
      const from = String(req.query.from || `${today.slice(0, 7)}-01`);
      const to = String(req.query.to || today);
      if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) {
        res.status(400).json({ success: false, error: 'Параметры from/to должны быть в формате YYYY-MM-DD, from ≤ to' });
        return;
      }
      const [accounts, employees] = await Promise.all([
        mtsBusinessMetricsStoreService.getAccountsSummary(),
        mtsBusinessMetricsStoreService.getEmployeesSummary(null, from, to),
      ]);
      res.json({ success: true, data: { accounts, employees, period: { from, to } } });
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
   * ежедневный планировщик. Обход всех номеров аккаунта через rate-gate МТС
   * может занять несколько минут — отвечаем сразу (started), реальная работа
   * идёт в фоне, чтобы не упереться в таймаут прокси/фронта.
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
        details: { accountId: accountId ?? null, accounts: accounts.length },
      });

      res.json({ success: true, data: { started: true, accounts: accounts.length } });

      void Promise.all(accounts.map(a => refreshAccountMetrics(a.id)))
        .then(results => {
          const failed = results.reduce((sum, r) => sum + r.failed, 0);
          console.log(`[mts-biz-billing] фоновое обновление завершено: ЛС=${results.length} failed=${failed}`);
        })
        .catch(error => {
          console.error('[mts-biz-billing] фоновое обновление упало:', error instanceof Error ? error.message : 'unknown');
          Sentry.captureException(error, { tags: { module: 'mts-business-billing', kind: 'background-refresh' } });
        });
    } catch (error) {
      fail(res, error, 'Ошибка запуска обновления баланса');
    }
  },
};
