/**
 * Кому доступен раздел «Зарплата» (список payroll_section_access, миграция 310). Список ведётся
 * в БД; в окне «Справочник» на «Расчётах» только показывается.
 */
import type { Response } from 'express';

import type { AuthenticatedRequest } from '../types/index.js';
import { listPayrollSectionUsers } from '../services/payroll/payroll-access.service.js';

/** GET /api/payroll/section-access — учётки с доступом к разделу, по алфавиту. */
const list = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    res.json({ success: true, data: await listPayrollSectionUsers() });
  } catch (err) {
    console.error('payrollSectionAccess.list error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения списка доступа' });
  }
};

export const payrollSectionAccessController = { list };
