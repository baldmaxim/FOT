import { Response } from 'express';
import { z } from 'zod';
import { query, execute } from '../config/postgres.js';
import { auditService } from '../services/audit.service.js';
import { sigurService } from '../services/sigur.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

import { AccessPointZoneError, changeAccessPointZone } from '../services/access-point-zone.service.js';
import {
  importFromExcel,
  syncEmployee as syncEmployeeService,
  cleanDuplicates as cleanDuplicatesService,
  clearData,
} from '../services/skud-import.service.js';
import {
  setAccessPointCacheEntry,
  deleteAccessPointCacheEntry,
} from '../services/skud-shared.service.js';
import { notifySkudRealtimeChanged } from '../services/skud-realtime.service.js';

const zoneChangeSchema = z.object({
  access_point_name: z.string().trim().min(1, 'Не указана точка доступа').max(300),
  is_internal: z.boolean({ invalid_type_error: 'Не указан тип зоны', required_error: 'Не указан тип зоны' }),
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Некорректная дата'),
});

export interface MulterRequest extends AuthenticatedRequest {
  file?: Express.Multer.File;
}

export const skudWriteController = {
  /**
   * POST /api/skud/access-point-settings/zone — смена типа зоны точки с датой начала.
   */
  async changeAccessPointZone(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }
      const input = zoneChangeSchema.parse(req.body);
      const result = await changeAccessPointZone(
        { accessPointName: input.access_point_name, isInternal: input.is_internal, effectiveFrom: input.effective_from },
        { req, userId: req.user.id },
      );
      res.json({ success: true, data: { changed: result.changed } });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      if (error instanceof AccessPointZoneError) {
        res.status(error.status).json({ success: false, error: error.message });
        return;
      }
      console.error('Change access point zone error:', error);
      res.status(500).json({ success: false, error: 'Ошибка смены типа зоны' });
    }
  },

  /**
   * PUT /api/skud/access-point-settings — прежнее сохранение списком, без дат.
   *
   * Отключено: оно меняло тип зоны сразу для всех прошлых дат, и часы в табелях
   * пересчитывались за закрытые месяцы (инцидент 12.10.2026). Тип зоны меняется только
   * через changeAccessPointZone. Роут оставлен, чтобы ещё не обновившаяся вкладка получила
   * понятный отказ, а не 404.
   */
  async saveAccessPointSettings(_req: AuthenticatedRequest, res: Response): Promise<void> {
    res.status(409).json({
      success: false,
      error: 'Тип зоны теперь меняется с датой начала. Обновите страницу',
    });
  },

  /**
   * POST /api/skud/sync-access-points
   */
  async syncAccessPoints(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const connection = (_req.query.connection as 'external' | 'internal') || undefined;
      deleteAccessPointCacheEntry('__all__');
      if (connection) deleteAccessPointCacheEntry(`__all__:${connection}`);

      if (!(await sigurService.isConfigured())) {
        res.status(400).json({ success: false, error: 'Sigur не настроен' });
        return;
      }

      const sigurAPs = await sigurService.getAccessPoints(connection);
      const freshNames = [...new Set(
        (sigurAPs as Record<string, unknown>[])
          .map(ap => ((ap.name as string) || '').trim())
          .filter(Boolean)
      )].sort();

      const currentSettings = await query<{ id: string; access_point_name: string }>(
        'SELECT id, access_point_name FROM skud_access_point_settings',
      );

      const freshSet = new Set(freshNames);
      const toDelete = currentSettings.filter(s => !freshSet.has(s.access_point_name));
      const removed = toDelete.map(r => r.access_point_name);

      if (toDelete.length > 0) {
        await execute(
          'DELETE FROM skud_access_point_settings WHERE id = ANY($1::uuid[])',
          [toDelete.map(r => r.id)],
        );
      }

      setAccessPointCacheEntry('__all__', freshNames);
      if (connection) setAccessPointCacheEntry(`__all__:${connection}`, freshNames);

      res.json({
        success: true,
        data: { accessPoints: freshNames, removed, settingsRemoved: removed.length },
      });
    } catch (error) {
      console.error('Sync access points error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения точек доступа из Sigur' });
    }
  },

  /**
   * POST /api/skud/import
   */
  async import(req: MulterRequest, res: Response): Promise<void> {
    try {
      if (!req.file) {
        res.status(400).json({ success: false, error: 'File is required' });
        return;
      }

      const data = await importFromExcel({
        fileBuffer: req.file.buffer,
        userId: req.user.id,
      });

      await auditService.logFromRequest(req, req.user.id, 'IMPORT_SKUD', {
        details: { imported: data.imported, errors: data.errors.length, matched_employees: data.matched },
      });

      res.json({ success: true, data });
    } catch (error) {
      const err = error as Error & { errors?: string[] };
      if (err.message === 'Файл пуст') {
        res.status(400).json({ success: false, error: err.message });
        return;
      }
      if (err.message === 'Нет данных для импорта') {
        res.status(400).json({ success: false, error: err.message, errors: err.errors });
        return;
      }
      console.error('Import SKUD error:', error);
      res.status(500).json({ success: false, error: 'Ошибка импорта' });
    }
  },

  /**
   * POST /api/skud/sync-employee
   */
  async syncEmployee(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { employeeId, startDate, endDate } = req.body as {
        employeeId: unknown;
        startDate: unknown;
        endDate: unknown;
      };

      if (typeof employeeId !== 'number' || !Number.isInteger(employeeId)) {
        res.status(400).json({ success: false, error: 'employeeId должен быть целым числом' });
        return;
      }
      if (typeof startDate !== 'string' || typeof endDate !== 'string' || !startDate || !endDate) {
        res.status(400).json({ success: false, error: 'startDate и endDate обязательны (YYYY-MM-DD)' });
        return;
      }
      if (!(await sigurService.isConfigured())) {
        res.status(503).json({ success: false, error: 'Sigur не настроен' });
        return;
      }

      const connection = (req.body.connection as 'external' | 'internal') || undefined;

      await syncEmployeeService(req, res, {
        employeeId,
        startDate,
        endDate,
        connection,
      });
      notifySkudRealtimeChanged({
        source: 'employee_sync',
        employeeIds: [employeeId],
        from: startDate,
        to: endDate,
      });
    } catch (error) {
      console.error('syncEmployee error:', error);
      const err = error as Error & { statusCode?: number };
      if (res.headersSent) {
        try {
          res.write(`data: ${JSON.stringify({ type: 'error', error: err.message || 'Ошибка синхронизации событий сотрудника' })}\n\n`);
        } catch { /* ignore */ }
        res.end();
      } else {
        res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Ошибка синхронизации событий сотрудника' });
      }
    }
  },

  /**
   * POST /api/skud/clean-duplicates
   */
  async cleanDuplicates(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const data = await cleanDuplicatesService();

      await auditService.logFromRequest(req, req.user.id, 'CLEAN_SKUD_DUPLICATES', {
        details: { totalUpdated: data.hashesUpdated, totalDeleted: data.duplicatesDeleted },
      });

      res.json({ success: true, data });
    } catch (error) {
      console.error('Clean duplicates error:', error);
      res.status(500).json({ success: false, error: 'Ошибка очистки дублей' });
    }
  },

  /**
   * DELETE /api/skud/clear
   */
  async clear(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { startDate, endDate } = req.body;

      await clearData({ startDate, endDate, userId: req.user.id });

      await auditService.logFromRequest(req, req.user.id, 'CLEAR_SKUD', {
        details: { startDate, endDate },
      });

      res.json({ success: true, message: 'Данные очищены' });
    } catch (error) {
      console.error('Clear SKUD error:', error);
      res.status(500).json({ success: false, error: 'Ошибка очистки данных' });
    }
  },
};
