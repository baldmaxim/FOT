import { Response } from 'express';
import { supabase } from '../config/database.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { invalidateSyncFilterCache } from '../services/skud-shared.service.js';

export const sigurFilterController = {
  /**
   * GET /api/sigur/sync-filter
   * Возвращает текущий whitelist отделов для синхронизации
   */
  async getFilter(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { data, error } = await supabase
        .from('skud_sync_department_filter')
        .select('id, sigur_department_id, sigur_department_name, created_at')
        .order('sigur_department_name');

      if (error) {
        res.status(500).json({ success: false, error: error.message });
        return;
      }
      res.json({ success: true, data: data || [] });
    } catch (error) {
      console.error('getSyncFilter error:', error);
      res.status(500).json({ success: false, error: 'Ошибка загрузки фильтра синхронизации' });
    }
  },

  /**
   * PUT /api/sigur/sync-filter
   * Заменяет whitelist отделов целиком
   */
  async updateFilter(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { departments } = req.body as {
        departments: Array<{ sigur_department_id: number; sigur_department_name: string }>;
      };
      if (!Array.isArray(departments)) {
        res.status(400).json({ success: false, error: 'departments должен быть массивом' });
        return;
      }

      // Удаляем все текущие записи
      const { error: deleteError } = await supabase
        .from('skud_sync_department_filter')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000');

      if (deleteError) {
        res.status(500).json({ success: false, error: deleteError.message });
        return;
      }

      // Вставляем новые записи
      if (departments.length > 0) {
        const rows = departments.map(d => ({
          sigur_department_id: d.sigur_department_id,
          sigur_department_name: d.sigur_department_name || null,
        }));

        const BATCH = 500;
        for (let i = 0; i < rows.length; i += BATCH) {
          const batch = rows.slice(i, i + BATCH);
          const { error: insertError } = await supabase
            .from('skud_sync_department_filter')
            .insert(batch);

          if (insertError) {
            res.status(500).json({ success: false, error: insertError.message });
            return;
          }
        }
      }

      invalidateSyncFilterCache();
      res.json({ success: true, data: { count: departments.length } });
    } catch (error) {
      console.error('updateSyncFilter error:', error);
      res.status(500).json({ success: false, error: 'Ошибка сохранения фильтра синхронизации' });
    }
  },
};
