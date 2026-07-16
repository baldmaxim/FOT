import { Response } from 'express';
import * as Sentry from '@sentry/node';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../types/index.js';
import { mtsBusinessSyncLogService } from '../services/mts-business-sync-log.service.js';

// «Лог синхронизации» МТС Бизнес (карточка на вкладке «Администрирование»):
// история прогонов (mts_business_sync_runs) и записи warn/error/diff по номерам
// (mts_business_sync_log, миграция 222). Только чтение — записи делают синки.

const runsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  job: z.enum(['refresh_all', 'cdr_daily', 'metrics_daily', 'catalog_weekly', 'rolling']).optional(),
  status: z.enum(['running', 'ok', 'partial', 'error', 'interrupted']).optional(),
  onlyProblems: z.coerce.boolean().optional(),
});

const entriesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
  level: z.enum(['info', 'warn', 'error', 'problems']).optional(),
});

const fail = (res: Response, error: unknown, fallback: string): void => {
  const msg = error instanceof Error ? error.message : 'unknown';
  console.error(`[mts-biz-sync-log] ${fallback}: ${msg}`);
  Sentry.captureException(error, { tags: { module: 'mts-business', kind: 'sync-log' } });
  res.status(500).json({ success: false, error: fallback, internal: msg });
};

export const mtsBusinessSyncLogController = {
  /** Список прогонов синхронизаций (пагинация + фильтры job/status). */
  async listRuns(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const parsed = runsSchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ success: false, error: 'Некорректный запрос', details: parsed.error.flatten() });
        return;
      }
      const data = await mtsBusinessSyncLogService.listRuns(parsed.data);
      res.json({ success: true, data });
    } catch (error) {
      fail(res, error, 'Ошибка чтения лога синхронизации');
    }
  },

  /** Все записи подряд (все прогоны + конвейер), свежие сверху — лента лога. */
  async listAllEntries(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const parsed = entriesSchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ success: false, error: 'Некорректный запрос', details: parsed.error.flatten() });
        return;
      }
      const data = await mtsBusinessSyncLogService.listAllEntries(parsed.data);
      res.json({ success: true, data });
    } catch (error) {
      fail(res, error, 'Ошибка чтения ленты лога синхронизации');
    }
  },

  /** Записи прогона; runId='standalone' — строки rolling-конвейера без прогона. */
  async listEntries(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const runIdRaw = req.params.runId;
      const runId = runIdRaw === 'standalone' ? null : runIdRaw;
      if (runId != null && !z.string().uuid().safeParse(runId).success) {
        res.status(400).json({ success: false, error: 'Некорректный идентификатор прогона' });
        return;
      }
      const parsed = entriesSchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ success: false, error: 'Некорректный запрос', details: parsed.error.flatten() });
        return;
      }
      const data = await mtsBusinessSyncLogService.listEntries(runId, parsed.data);
      res.json({ success: true, data });
    } catch (error) {
      fail(res, error, 'Ошибка чтения записей лога синхронизации');
    }
  },
};
