import type { Response } from 'express';

import type { AuthenticatedRequest } from '../types/index.js';
import { OBJECT_KPI_EXPORT_SHEET } from '../services/object-kpi-export-excel.service.js';
import { respondWithError } from './object-kpi.controller.js';
import { sendTableSnapshotXlsx, TABLE_SNAPSHOT_MAX_ROWS } from './table-snapshot-export.js';

/** Лимит строк снимка — общий для клиентских таблиц (table-snapshot-export). */
export const OBJECT_KPI_EXPORT_MAX_ROWS = TABLE_SNAPSHOT_MAX_ROWS;

export const objectKpiExportController = {
  /** POST /object-kpi/report/export — xlsx из снимка таблицы экрана (см. table-snapshot-excel.service). */
  async exportTable(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      await sendTableSnapshotXlsx(res, req.body, OBJECT_KPI_EXPORT_SHEET);
    } catch (error) {
      respondWithError(res, error, '[object-kpi] exportTable');
    }
  },
};
