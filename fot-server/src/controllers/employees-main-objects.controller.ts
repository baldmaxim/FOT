/**
 * «Управление кадрами» → столбец «Объект»: объект, где сотрудник набрал больше
 * всего часов за 30 полных дней.
 *
 * GET /api/employees/main-objects?ids=1,2,3 — данные ночного снимка (миграция 277),
 * тот же источник, что у Excel-выгрузки. Пока снимка нет — расчёт на лету за
 * сегодня и 29 дней до (resolveExportPeriod), страница списка ≤ 200 человек.
 */
import { Response } from 'express';
import { filterEmployeeIdsByReadScope } from '../services/employee-scope-filter.service.js';
import { loadMainObjects } from '../services/employee-main-object-snapshot.service.js';
import { resolveExportPeriod } from './employees-export.controller.js';
import type { AuthenticatedRequest } from '../types/index.js';

export const MAIN_OBJECTS_MAX_IDS = 200;

export function parseEmployeeIdsParam(value: unknown): number[] | null {
  if (typeof value !== 'string') return null;
  const parts = value.split(',').map(part => part.trim()).filter(Boolean);
  const ids: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const id = Number(part);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    ids.push(id);
  }
  return [...new Set(ids)];
}

export const employeesMainObjectsController = {
  async getMainObjects(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const ids = parseEmployeeIdsParam(req.query.ids);
      if (ids === null) {
        res.status(400).json({ success: false, error: 'Некорректный список сотрудников' });
        return;
      }
      if (ids.length > MAIN_OBJECTS_MAX_IDS) {
        res.status(400).json({
          success: false,
          error: `Слишком много сотрудников в запросе (максимум ${MAIN_OBJECTS_MAX_IDS})`,
        });
        return;
      }

      // Чужие id отбрасываются молча: список страницы строится тем же скоупом чтения,
      // расхождение возможно только при подмене запроса.
      const visibleIds = await filterEmployeeIdsByReadScope(req, ids);
      const result = await loadMainObjects(visibleIds, resolveExportPeriod());

      const objects: Record<string, string> = {};
      for (const [employeeId, objectName] of result.objects) objects[String(employeeId)] = objectName;

      res.json({ success: true, data: { period: result.period, objects, source: result.source } });
    } catch (error) {
      console.error('Get employee main objects error:', error);
      res.status(500).json({ success: false, error: 'Не удалось рассчитать объекты сотрудников' });
    }
  },
};
