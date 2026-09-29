import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import { buildObjectKpiExportWorkbook } from '../services/object-kpi-export-excel.service.js';
import { sanitizeExportFileName } from '../services/skud-export.service.js';
import { respondWithError } from './object-kpi.controller.js';

/**
 * Лимиты снимка: на вкладке не больше пары десятков строк (объекты или месяцы одного
 * объекта), запас — на рост справочника, но не на «выгрузку произвольной таблицы».
 */
export const OBJECT_KPI_EXPORT_MAX_COLUMNS = 20;
export const OBJECT_KPI_EXPORT_MAX_ROWS = 1000;

const cellSchema = z.union([z.string().max(300), z.number().finite(), z.null()]);

export const objectKpiExportSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    subtitle: z.string().trim().max(300),
    file_name: z.string().trim().min(1).max(150),
    columns: z
      .array(z.object({
        label: z.string().trim().min(1).max(60),
        type: z.enum(['text', 'money', 'percent', 'int']),
      }))
      .min(1)
      .max(OBJECT_KPI_EXPORT_MAX_COLUMNS),
    rows: z
      .array(z.object({ cells: z.array(cellSchema), muted: z.boolean().optional() }))
      .min(1, 'Нет строк для выгрузки')
      .max(OBJECT_KPI_EXPORT_MAX_ROWS, 'Слишком много строк для выгрузки'),
  })
  // Имена столбцов умной таблицы Excel обязаны быть уникальными, иначе файл не откроется.
  .refine((value) => new Set(value.columns.map((column) => column.label)).size === value.columns.length, {
    message: 'Названия столбцов повторяются',
  })
  .refine((value) => value.rows.every((row) => row.cells.length === value.columns.length), {
    message: 'Число ячеек в строке не совпадает с числом столбцов',
  });

export const objectKpiExportController = {
  /** POST /object-kpi/report/export — xlsx из снимка таблицы экрана (см. object-kpi-export-excel.service). */
  async exportTable(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const payload = objectKpiExportSchema.parse(req.body);
      const workbook = buildObjectKpiExportWorkbook(payload);
      const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
      const fileName = `${sanitizeExportFileName(payload.file_name.replace(/\.xlsx$/i, ''))}.xlsx`;

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      );
      res.send(buffer);
    } catch (error) {
      respondWithError(res, error, '[object-kpi] exportTable');
    }
  },
};
