/**
 * Таблицы окна «Справочник» на «Расчётах» (миграция 315): «Удержания» (только просмотр — вносят в окне
 * сотрудника) и «Экспорт» видимых строк любой из таблиц.
 */
import type { Response } from 'express';

import type { AuthenticatedRequest } from '../types/index.js';
import { listDeductionRegistry } from '../services/payroll/payroll-deduction-kinds.service.js';
import { resolvePayrollStaffScope } from '../services/payroll/payroll-registry-scope.service.js';
import type { ITableSnapshotSheet } from '../services/table-snapshot-excel.service.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import { handlePayrollZodError } from './payroll-dictionary.helpers.js';
import { sendTableSnapshotXlsx } from './table-snapshot-export.js';

/** Лист xlsx у каждой таблицы: имя листа ≤ 31 символа, имя умной таблицы — латиница. */
const REGISTRY_SHEETS = new Map<string, ITableSnapshotSheet>([
  ['housing', { sheetName: 'Доплата за проживание', tableName: 'HousingAllowance' }],
  ['supplements', { sheetName: 'Доплата', tableName: 'Supplements' }],
  ['compensation-stops', { sheetName: 'Не выплачивать', tableName: 'CompensationStops' }],
  ['deductions', { sheetName: 'Удержания', tableName: 'Deductions' }],
]);

/** GET /api/payroll/deduction-registry — у кого в условиях на сегодня есть вид или сумма удержания. */
const listDeductions = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const scope = await resolvePayrollStaffScope(req);
    res.json({ success: true, data: await listDeductionRegistry({ ...scope, onDate: moscowTodayIso() }) });
  } catch (err) {
    console.error('payrollRegistry.listDeductions error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения списка' });
  }
};

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

export const payrollRegistryController = { listDeductions, exportTable };
