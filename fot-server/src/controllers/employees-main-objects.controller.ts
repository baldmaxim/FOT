/**
 * «Управление кадрами» → столбец «Объект»: объект, где сотрудник набрал больше
 * всего часов за период (сегодня и 29 дней до по Москве).
 *
 * GET /api/employees/main-objects?ids=1,2,3 — расчёт тот же, что в Excel-выгрузке
 * (loadMainObjectByEmployee + resolveExportPeriod). Серверного кэша нет: страница
 * списка ≤ 200 человек, клиент сам перезапрашивает раз в минуту.
 */
import { Response } from 'express';
import { filterEmployeeIdsByReadScope } from '../services/employee-scope-filter.service.js';
import { loadMainObjectByEmployee } from '../services/employees-export-objects.service.js';
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

      const period = resolveExportPeriod();
      // Чужие id отбрасываются молча: список страницы строится тем же скоупом чтения,
      // расхождение возможно только при подмене запроса.
      const visibleIds = await filterEmployeeIdsByReadScope(req, ids);
      const byEmployee = visibleIds.length > 0
        ? await loadMainObjectByEmployee(visibleIds, period)
        : new Map<number, string>();

      const objects: Record<string, string> = {};
      for (const [employeeId, objectName] of byEmployee) objects[String(employeeId)] = objectName;

      res.json({ success: true, data: { period, objects } });
    } catch (error) {
      console.error('Get employee main objects error:', error);
      res.status(500).json({ success: false, error: 'Не удалось рассчитать объекты сотрудников' });
    }
  },
};
