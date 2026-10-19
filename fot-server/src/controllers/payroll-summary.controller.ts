/**
 * «Свод» на «Расчётах» — суммы «Оплачено» (ЗУП) по объектам и категориям за выбранные месяцы. Только
 * чтение; xlsx — через POST /payroll/registry/summary/export (снимок экрана).
 */
import type { Response } from 'express';

import type { AuthenticatedRequest } from '../types/index.js';
import { resolvePayrollStaffScope } from '../services/payroll/payroll-registry-scope.service.js';
import { listPayrollSummaryMonths, loadPayrollSummary } from '../services/payroll/payroll-summary.service.js';
import { handlePayrollZodError, parsePayrollMonthsQuery, payrollMonthStarts } from './payroll-dictionary.helpers.js';

/** GET /api/payroll/summary/months — месяцы, за которые в охвате пользователя есть «Оплачено». */
const months = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const scope = await resolvePayrollStaffScope(req);
    res.json({ success: true, data: await listPayrollSummaryMonths(scope) });
  } catch (err) {
    console.error('payrollSummary.months error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения месяцев' });
  }
};

/**
 * GET /api/payroll/summary?months=2026-07,2026-08 — строки «Свода»: сотрудник × объект × категория,
 * суммы статей за месяцы. months=all или без параметра — все месяцы с суммами.
 */
const get = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const selection = parsePayrollMonthsQuery(req.query.months);
    const monthStarts = selection === null || selection === 'all' ? null : payrollMonthStarts(selection);
    const scope = await resolvePayrollStaffScope(req);
    res.json({ success: true, data: await loadPayrollSummary({ scope, monthStarts }) });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('payrollSummary.get error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения свода' });
  }
};

export const payrollSummaryController = { months, get };
