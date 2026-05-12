import { Response } from 'express';
import { query, execute } from '../config/postgres.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { invalidateDeptTreeCache, invalidateSyncFilterCache } from '../services/skud-shared.service.js';

interface ISigurDeptRow {
  id: string;
  sigur_department_id: number | null;
  parent_id: string | null;
}

/**
 * Приводит is_active в org_departments в соответствие с whitelist.
 * Ручные отделы (sigur_department_id IS NULL) не трогаем.
 * Пустой whitelist → все sigur-отделы деактивируются.
 * Непустой → активируются только отделы из whitelist + все их предки (включая ручных).
 */
async function reconcileDepartmentsActivity(whitelistSigurIds: number[]): Promise<void> {
  let rows: ISigurDeptRow[];
  try {
    rows = await query<ISigurDeptRow>(
      'SELECT id, sigur_department_id, parent_id FROM org_departments',
    );
  } catch (error) {
    throw new Error(`reconcile: failed to load departments: ${(error as Error).message}`);
  }

  const sigurIdToDbId = new Map<number, string>();
  for (const row of rows) {
    if (row.sigur_department_id != null) {
      sigurIdToDbId.set(row.sigur_department_id, row.id);
    }
  }

  const parentByDbId = new Map<string, string | null>();
  for (const row of rows) {
    parentByDbId.set(row.id, row.parent_id);
  }

  const activeDbIds = new Set<string>();
  if (whitelistSigurIds.length > 0) {
    for (const sigurId of whitelistSigurIds) {
      const dbId = sigurIdToDbId.get(sigurId);
      if (!dbId) continue;
      let current: string | null = dbId;
      while (current && !activeDbIds.has(current)) {
        activeDbIds.add(current);
        current = parentByDbId.get(current) ?? null;
      }
    }
  }

  const sigurDbIds = rows
    .filter(row => row.sigur_department_id != null)
    .map(row => row.id);
  const inactiveDbIds = sigurDbIds.filter(id => !activeDbIds.has(id));
  const activeSigurDbIds = sigurDbIds.filter(id => activeDbIds.has(id));

  const BATCH = 500;

  for (let i = 0; i < inactiveDbIds.length; i += BATCH) {
    const batch = inactiveDbIds.slice(i, i + BATCH);
    try {
      await execute(
        'UPDATE org_departments SET is_active = false WHERE id = ANY($1::uuid[])',
        [batch],
      );
    } catch (updateError) {
      throw new Error(`reconcile: failed to deactivate: ${(updateError as Error).message}`);
    }
  }

  for (let i = 0; i < activeSigurDbIds.length; i += BATCH) {
    const batch = activeSigurDbIds.slice(i, i + BATCH);
    try {
      await execute(
        'UPDATE org_departments SET is_active = true WHERE id = ANY($1::uuid[])',
        [batch],
      );
    } catch (updateError) {
      throw new Error(`reconcile: failed to activate: ${(updateError as Error).message}`);
    }
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
      try {
        await execute(
          "DELETE FROM skud_sync_department_filter WHERE id <> '00000000-0000-0000-0000-000000000000'::uuid",
        );
      } catch (deleteError) {
        res.status(500).json({ success: false, error: (deleteError as Error).message });
        return;
      }

      // Вставляем новые записи
      if (departments.length > 0) {
        const BATCH = 500;
        for (let i = 0; i < departments.length; i += BATCH) {
          const batch = departments.slice(i, i + BATCH);
          const params: unknown[] = [];
          const placeholders: string[] = [];
          for (const d of batch) {
            params.push(d.sigur_department_id, d.sigur_department_name || null);
            placeholders.push(`($${params.length - 1}, $${params.length})`);
          }
          try {
            await execute(
              `INSERT INTO skud_sync_department_filter (sigur_department_id, sigur_department_name) VALUES ${placeholders.join(', ')}`,
              params,
            );
          } catch (insertError) {
            res.status(500).json({ success: false, error: (insertError as Error).message });
            return;
          }
        }
      }

      try {
        await reconcileDepartmentsActivity(departments.map(d => d.sigur_department_id));
      } catch (reconcileError) {
        console.error('reconcile departments activity error:', reconcileError);
        res.status(500).json({
          success: false,
          error: reconcileError instanceof Error ? reconcileError.message : 'Ошибка обновления активности отделов',
        });
        return;
      }

      invalidateSyncFilterCache();
      invalidateDeptTreeCache();
      res.json({ success: true, data: { count: departments.length } });
    } catch (error) {
      console.error('updateSyncFilter error:', error);
      res.status(500).json({ success: false, error: 'Ошибка сохранения фильтра синхронизации' });
    }
  },
};
