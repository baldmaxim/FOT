/**
 * «Экспорт» видимых строк любой из таблиц окна «Справочник» на «Расчётах» (миграция 315) и «Свода».
 * Сами таблицы — свои контроллеры («Удержания» — payroll-staff-deductions.controller.ts, миграция 321).
 */
import type { Response } from 'express';

import type { AuthenticatedRequest } from '../types/index.js';
import type { ITableSnapshotSheet } from '../services/table-snapshot-excel.service.js';
import { handlePayrollZodError } from './payroll-dictionary.helpers.js';
import { sendTableSnapshotXlsx } from './table-snapshot-export.js';

/** Лист xlsx у каждой таблицы: имя листа ≤ 31 символа, имя умной таблицы — латиница. */
const REGISTRY_SHEETS = new Map<string, ITableSnapshotSheet>([
  ['housing', { sheetName: 'Доплата за проживание', tableName: 'HousingAllowance' }],
  ['supplements', { sheetName: 'Доплата', tableName: 'Supplements' }],
  ['compensation-stops', { sheetName: 'Без проезда', tableName: 'CompensationStops' }],
  ['overtime-stops', { sheetName: 'Без переработки', tableName: 'OvertimeStops' }],
  ['dormitory-allowances', { sheetName: 'Доплата за общежитие', tableName: 'DormitoryAllowance' }],
  ['deductions', { sheetName: 'Удержания', tableName: 'Deductions' }],
  ['summary', { sheetName: 'Свод', tableName: 'PayrollSummary' }],
]);

/**
 * POST /api/payroll/registry/:table/export — xlsx ровно как на экране: сортировка и фильтры применены
 * на клиенте, сервер только оформляет лист (до 1000 строк).
 */
const exportTable = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const sheet = REGISTRY_SHEETS.get(String(req.params.table));
    if (!sheet) {
      res.status(404).json({ success: false, error: 'Таблица не найдена' });
      return;
    }
    await sendTableSnapshotXlsx(res, req.body, sheet);
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('payrollRegistry.export error:', err);
    res.status(500).json({ success: false, error: 'Не удалось выгрузить таблицу' });
  }
};

export const payrollRegistryController = { exportTable };
