/**
 * «KPI объектов → Экспорт»: xlsx ровно той таблицы, что на экране (общий снимок таблицы —
 * table-snapshot-excel.service).
 */
import type ExcelJS from 'exceljs';
import { buildTableSnapshotWorkbook, type ITableSnapshot } from './table-snapshot-excel.service.js';

export { toExcelCellValue } from './table-snapshot-excel.service.js';

export const OBJECT_KPI_EXPORT_SHEET = { sheetName: 'KPI объектов', tableName: 'KPI_Objects' } as const;

export function buildObjectKpiExportWorkbook(table: ITableSnapshot): ExcelJS.Workbook {
  return buildTableSnapshotWorkbook(table, OBJECT_KPI_EXPORT_SHEET);
}
