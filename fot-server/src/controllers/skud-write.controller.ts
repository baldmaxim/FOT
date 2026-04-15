import { Response } from 'express';
import { supabase } from '../config/database.js';
import { auditService } from '../services/audit.service.js';
import { sigurService } from '../services/sigur.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

import { invalidateInternalPointsCache } from '../services/skud-shared.service.js';
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

export interface MulterRequest extends AuthenticatedRequest {
  file?: Express.Multer.File;
}

export const skudWriteController = {
  /**
   * PUT /api/skud/access-point-settings
   */
  async saveAccessPointSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { department_id, settings } = req.body as {
        department_id?: string;
        settings: { access_point_name: string; is_internal: boolean }[];
      };

      if (!Array.isArray(settings)) {
        res.status(400).json({ success: false, error: 'settings обязательны' });
        return;
      }

      let targetDeptId = department_id || null;

      if (!targetDeptId) {
        const { data: rootDepts } = await supabase
          .from('org_departments')
          .select('id')
          .is('parent_id', null)
          .limit(1);
        if (!rootDepts || rootDepts.length === 0) {
          res.status(400).json({ success: false, error: 'Корневой отдел не найден' });
          return;
        }
        targetDeptId = rootDepts[0].id;
      }

      // Дедупликация по trimmed name
      const internalMap = new Map<string, boolean>();
      for (const s of settings) {
        const name = s.access_point_name.trim();
        if (s.is_internal) internalMap.set(name, true);
      }
      const uniqueInternalNames = [...internalMap.keys()];

      const { error: deleteError } = await supabase
        .from('skud_access_point_settings')
        .delete()
        .eq('department_id', targetDeptId)
        .select('id');

      if (deleteError) {
        console.error('Delete access point settings error:', deleteError);
        res.status(500).json({ success: false, error: 'Ошибка удаления старых настроек' });
        return;
      }

      if (uniqueInternalNames.length > 0) {
        const rows = uniqueInternalNames.map(name => ({
          department_id: targetDeptId,
          access_point_name: name,
          is_internal: true,
        }));

        const { error } = await supabase
          .from('skud_access_point_settings')
          .insert(rows);

        if (error) {
          console.error('Save access point settings error:', error);
          res.status(500).json({ success: false, error: 'Ошибка сохранения настроек' });
          return;
        }
      }

      invalidateInternalPointsCache();
      res.json({ success: true, message: 'Настройки сохранены' });
    } catch (error) {
      console.error('Save access point settings error:', error);
      res.status(500).json({ success: false, error: 'Ошибка сохранения настроек' });
    }
  },

  /**
   * POST /api/skud/sync-access-points
   */
  async syncAccessPoints(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const connection = (_req.query.connection as 'external' | 'internal') || undefined;
      deleteAccessPointCacheEntry('__all__');
      if (connection) deleteAccessPointCacheEntry(`__all__:${connection}`);

      if (!sigurService.isConfigured()) {
        res.status(400).json({ success: false, error: 'Sigur не настроен' });
        return;
      }

      const sigurAPs = await sigurService.getAccessPoints(connection);
      const freshNames = [...new Set(
        (sigurAPs as Record<string, unknown>[])
          .map(ap => ((ap.name as string) || '').trim())
          .filter(Boolean)
      )].sort();

      const { data: currentSettings } = await supabase
        .from('skud_access_point_settings')
        .select('id, access_point_name');

      const freshSet = new Set(freshNames);
      const toDelete = (currentSettings || []).filter(s => !freshSet.has(s.access_point_name));
      const removed = toDelete.map(r => r.access_point_name);

      if (toDelete.length > 0) {
        await supabase
          .from('skud_access_point_settings')
          .delete()
          .in('id', toDelete.map(r => r.id));
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
      if (!sigurService.isConfigured()) {
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
