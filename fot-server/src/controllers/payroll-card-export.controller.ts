/**
 * «Экспорт» карточки сотрудника «Зарплаты» («Подробно» и окно «Расчётов»): условия оплаты и история выплат —
 * два листа одной книги. Данные карточка уже получила, сервер только оформляет снимок.
 */
import type { Response } from 'express';

import type { AuthenticatedRequest } from '../types/index.js';
import type { ITableSnapshotSheet } from '../services/table-snapshot-excel.service.js';
import { handlePayrollZodError } from './payroll-dictionary.helpers.js';
import { sendTableSnapshotsXlsx } from './table-snapshot-export.js';

/** Листы в порядке снимка: имя листа ≤ 31 символа, имя умной таблицы — латиница. */
export const PAYROLL_CARD_SHEETS: ReadonlyArray<ITableSnapshotSheet> = [
  { sheetName: 'Условия', tableName: 'PayrollTerms' },
  { sheetName: 'История выплат', tableName: 'PaidHistory' },
];

/** POST /api/payroll/terms/card/export — xlsx карточки: { file_name, sheets: [условия, история выплат] }. */
const exportCard = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    await sendTableSnapshotsXlsx(res, req.body, PAYROLL_CARD_SHEETS);
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('payrollCardExport.export error:', err);
    res.status(500).json({ success: false, error: 'Не удалось выгрузить карточку' });
  }
};

export const payrollCardExportController = { exportCard };
