import { Response } from 'express';
import { query } from '../config/postgres.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { sigurService } from '../services/sigur.service.js';
import { normalizeDepartment } from '../services/sigur-sync-shared.js';
import {
  EmptySyncFilterError,
  saveSyncFilterWithReconciliation,
} from '../services/sigur-sync-filter.service.js';

/**
 * Снимок отделов Sigur — единственное основание ВКЛЮЧИТЬ отдел при сохранении
 * фильтра: whitelist и иерархия БД помнят строки, давно удалённые в Sigur, и без
 * снимка реконсиляция воскрешала их (03–04.09.2026, «дубли папок»).
 * null = Sigur не ответил или вернул пусто: включение откладывается до синка.
 */
async function loadAliveSigurDepartmentIds(): Promise<Set<number> | null> {
  try {
    const raw = (await sigurService.getDepartments()) as Record<string, unknown>[];
    const ids = new Set<number>();
    for (const item of raw ?? []) {
      const id = normalizeDepartment(item).id;
      if (id > 0) ids.add(id);
    }
    return ids.size > 0 ? ids : null;
  } catch (error) {
    console.warn(
      '[sync-filter] снимок отделов Sigur недоступен, включение отделов отложено до синка:',
      (error as Error).message,
    );
    return null;
  }
}

export const sigurFilterController = {
  /**
   * GET /api/sigur/sync-filter
   * Возвращает текущий whitelist отделов для синхронизации
   */
  async getFilter(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const data = await query(
        `SELECT id, sigur_department_id, sigur_department_name, created_at
         FROM skud_sync_department_filter
         ORDER BY sigur_department_name`,
      );
      res.json({ success: true, data });
    } catch (error) {
      console.error('getSyncFilter error:', error);
      res.status(500).json({ success: false, error: 'Ошибка загрузки фильтра синхронизации' });
    }
  },

  /**
   * PUT /api/sigur/sync-filter
   * Заменяет whitelist отделов целиком.
   *
   * Запись и реконсиляция активности идут одной транзакцией
   * (saveSyncFilterWithReconciliation): раньше DELETE-all и INSERT выполнялись
   * вне транзакции, и обрыв между ними выключал синхронизацию целиком.
   */
  async updateFilter(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { departments, confirm_empty: confirmEmpty } = req.body as {
        departments: Array<{ sigur_department_id: number; sigur_department_name: string }>;
        confirm_empty?: boolean;
      };
      if (!Array.isArray(departments)) {
        res.status(400).json({ success: false, error: 'departments должен быть массивом' });
        return;
      }

      const aliveSigurIds = await loadAliveSigurDepartmentIds();
      const result = await saveSyncFilterWithReconciliation(
        departments.map(item => ({
          sigur_department_id: item.sigur_department_id,
          sigur_department_name: item.sigur_department_name ?? null,
        })),
        {
          allowEmpty: confirmEmpty === true,
          source: `user:${req.user?.id ?? 'unknown'}`,
          reconcile: { aliveSigurIds },
        },
      );

      res.json({
        success: true,
        data: {
          count: departments.length,
          inserted: result.inserted,
          updated: result.updated,
          deleted: result.deleted,
          activated: result.activated,
          deactivated: result.deactivated,
          warnings: result.warnings,
          deferred_activation: result.deferredActivation,
          sigur_unavailable: aliveSigurIds === null,
        },
      });
    } catch (error) {
      if (error instanceof EmptySyncFilterError) {
        res.status(400).json({
          success: false,
          error: 'Пустой фильтр отключит синхронизацию с Sigur. Отметьте отделы или подтвердите очистку явно.',
          code: error.code,
          data: { current_count: error.currentCount },
        });
        return;
      }
      console.error('updateSyncFilter error:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Ошибка сохранения фильтра синхронизации',
      });
    }
  },
};
