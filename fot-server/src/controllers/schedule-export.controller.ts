import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import { sendTableSnapshotXlsx } from './table-snapshot-export.js';

const SCHEDULE_TEMPLATES_SHEET = { sheetName: 'Шаблоны графиков', tableName: 'Schedule_Templates' } as const;

export const scheduleExportController = {
  /**
   * POST /api/schedules/templates/export — xlsx «Шаблонов графиков» ровно как на экране:
   * сортировка и фильтры столбцов применены на клиенте, сервер только оформляет лист.
   */
  async exportTemplates(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      await sendTableSnapshotXlsx(res, req.body, SCHEDULE_TEMPLATES_SHEET);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ success: false, error: err.issues[0]?.message ?? 'Некорректные данные' });
        return;
      }
      console.error('[schedules] exportTemplates error:', err);
      res.status(500).json({ success: false, error: 'Не удалось выгрузить таблицу' });
    }
  },
};
