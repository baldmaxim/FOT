import { Response } from 'express';
import * as Sentry from '@sentry/node';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../types/index.js';
import { startRefreshAll, getRefreshAllStatus } from '../services/mts-business-refresh-all.service.js';
import { getRollingStatus } from '../services/mts-business-statement-rolling.service.js';
import { getSigurRuntimeState } from '../services/sigur-runtime-state.service.js';
import { auditService, AUDIT_ACTIONS } from '../services/audit.service.js';
import { settingsService } from '../services/settings.service.js';

// «Обновить всё» — запуск/статус фонового полного обновления модуля МТС Бизнес
// (см. mts-business-refresh-all.service.ts) + статусы фоновых планировщиков
// для вкладки «Администрирование».

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const startSchema = z.object({
  accountId: z.string().uuid().optional(),
  dateFrom: z.string().regex(DATE_RE).optional(),
  dateTo: z.string().regex(DATE_RE).optional(),
  confirmed: z.literal(true),
});

const scheduleSchema = z.object({
  enabled: z.boolean(),
  hourMsk: z.number().int().min(0).max(23),
});

// Доля лимита 10–90%: 100% съели бы весь пакет запросов и живые вызовы карточки
// абонента ждали бы освобождения окна.
const rollingSchema = z.object({
  enabled: z.boolean(),
  budgetSharePercent: z.number().int().min(10).max(90).optional(),
  hotMinutes: z.number().int().min(5).max(240).optional(),
  coldHours: z.number().int().min(1).max(72).optional(),
});

const fail = (res: Response, error: unknown, fallback: string): void => {
  const msg = error instanceof Error ? error.message : 'unknown';
  console.error(`[mts-biz-refresh-all] ${fallback}: ${msg}`);
  Sentry.captureException(error, { tags: { module: 'mts-business', kind: 'refresh-all' } });
  res.status(500).json({ success: false, error: fallback, internal: msg });
};

interface ISchedulerStatusRow {
  id: string;
  label: string;
  lastRunAt: string | null;
  lastStatus: 'ok' | 'partial' | 'error' | null;
  lastMessage: string | null;
  lastResult: Record<string, unknown> | null;
}

const metaString = (meta: Record<string, unknown> | undefined, key: string): string | null => {
  const v = meta?.[key];
  return typeof v === 'string' ? v : null;
};

/**
 * Сводка последнего прогона планировщика из sigur_runtime_state.meta.
 * Прогон, завершившийся с per-номерными ошибками (lastResult.failed > 0),
 * помечается 'partial' — раньше он выглядел «ок» и скрывал ежедневные сбои.
 */
const schedulerRowFromState = (
  id: string,
  label: string,
  meta: Record<string, unknown> | undefined,
  resultKey = 'lastResult',
): ISchedulerStatusRow => {
  const lastSuccessAt = metaString(meta, 'lastSuccessAt');
  const lastFailureAt = metaString(meta, 'lastFailureAt');
  const failedAfterSuccess = lastFailureAt != null
    && (lastSuccessAt == null || Date.parse(lastFailureAt) > Date.parse(lastSuccessAt));
  const result = meta?.[resultKey];
  const lastResult = result && typeof result === 'object' ? (result as Record<string, unknown>) : null;
  const failedCount = typeof lastResult?.failed === 'number' ? lastResult.failed : 0;
  const partial = !failedAfterSuccess && lastSuccessAt != null && failedCount > 0;
  return {
    id,
    label,
    lastRunAt: failedAfterSuccess ? lastFailureAt : lastSuccessAt,
    lastStatus: lastSuccessAt == null && lastFailureAt == null
      ? null
      : failedAfterSuccess ? 'error' : partial ? 'partial' : 'ok',
    lastMessage: failedAfterSuccess
      ? metaString(meta, 'lastError')
      : partial ? `ошибок: ${failedCount}` : null,
    lastResult,
  };
};

export const mtsBusinessRefreshController = {
  /** Запуск фонового полного обновления (409, если прогон уже идёт). */
  async start(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const parsed = startSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, error: 'Некорректный запрос', details: parsed.error.flatten() });
        return;
      }
      const { accountId, dateFrom, dateTo } = parsed.data;
      if ((dateFrom && !dateTo) || (!dateFrom && dateTo)) {
        res.status(400).json({ success: false, error: 'Укажите обе даты периода или ни одной' });
        return;
      }

      const result = await startRefreshAll({ accountId, dateFrom, dateTo });
      if (!result.started) {
        res.status(409).json({ success: false, error: 'Обновление уже выполняется' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.MTS_BUSINESS_REFRESH_ALL_STARTED, {
        details: { accountId: accountId ?? null, dateFrom: dateFrom ?? null, dateTo: dateTo ?? null },
      });
      res.json({ success: true, data: { started: true } });
    } catch (error) {
      if (error instanceof Error && error.message.includes('аккаунт')) {
        res.status(400).json({ success: false, error: error.message });
        return;
      }
      fail(res, error, 'Ошибка запуска обновления');
    }
  },

  /** Текущий/последний статус прогона «Обновить всё» (для polling с фронта). */
  async getStatus(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      res.json({ success: true, data: await getRefreshAllStatus() });
    } catch (error) {
      fail(res, error, 'Ошибка получения статуса обновления');
    }
  },

  /** Последние прогоны фоновых планировщиков модуля (вкладка «Администрирование»). */
  async getSchedulersStatus(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const [cdrState, metricsState, refreshAllDailyState] = await Promise.all([
        getSigurRuntimeState('mts_business_cdr_daily'),
        getSigurRuntimeState('mts_business_metrics_daily'),
        getSigurRuntimeState('mts_business_refresh_all_daily'),
      ]);
      const data: ISchedulerStatusRow[] = [
        schedulerRowFromState('cdr-daily', 'Детализация звонков (ежедневно)', cdrState?.meta),
        schedulerRowFromState('metrics-daily', 'Балансы и начисления (ежедневно)', metricsState?.meta),
        {
          ...schedulerRowFromState('catalog-weekly', 'Каталог: номера, тарифы, услуги (раз в 7 дней)', metricsState?.meta, 'lastCatalogResult'),
          lastRunAt: metaString(metricsState?.meta, 'lastWeeklyRunYmdMsk'),
        },
        schedulerRowFromState('refresh-all-daily', 'Полное обновление «Обновить всё» (ежедневно, авто)', refreshAllDailyState?.meta),
      ];
      res.json({ success: true, data });
    } catch (error) {
      fail(res, error, 'Ошибка получения статуса планировщиков');
    }
  },

  /** Настройка ежедневного автопрогона «Обновить всё» (вкл/выкл + час МСК). */
  async getSchedule(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      res.json({ success: true, data: await settingsService.getMtsBusinessRefreshAllSchedule() });
    } catch (error) {
      fail(res, error, 'Ошибка получения настройки автообновления');
    }
  },

  async setSchedule(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const parsed = scheduleSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, error: 'Некорректный запрос', details: parsed.error.flatten() });
        return;
      }
      const next = await settingsService.setMtsBusinessRefreshAllSchedule(parsed.data, req.user.id);
      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.MTS_BUSINESS_REFRESH_ALL_SCHEDULE_UPDATED, {
        details: { enabled: next.enabled, hourMsk: next.hourMsk },
      });
      res.json({ success: true, data: next });
    } catch (error) {
      fail(res, error, 'Ошибка сохранения настройки автообновления');
    }
  },

  /** Непрерывный конвейер свежести: статус + глубина очереди по лицевым счетам. */
  async getRolling(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      res.json({ success: true, data: await getRollingStatus() });
    } catch (error) {
      fail(res, error, 'Ошибка получения статуса непрерывного обновления');
    }
  },

  /** Настройка конвейера: вкл/выкл, доля лимита, интервалы свежести. */
  async setRolling(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const parsed = rollingSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, error: 'Некорректный запрос', details: parsed.error.flatten() });
        return;
      }
      const next = await settingsService.setMtsBusinessRolling(parsed.data, req.user.id);
      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.MTS_BUSINESS_REFRESH_ALL_SCHEDULE_UPDATED, {
        details: { rolling: next },
      });
      res.json({ success: true, data: next });
    } catch (error) {
      fail(res, error, 'Ошибка сохранения настройки непрерывного обновления');
    }
  },
};
