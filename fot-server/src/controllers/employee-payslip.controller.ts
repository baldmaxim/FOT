/**
 * Расчётный лист в личном кабинете (миграция 353): только свой — сотрудник берётся из сессии (req.user.employee_id),
 * параметра id нет. Учётка без сотрудника — 403 до обращения к данным (страница её и так не пускает).
 */
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import {
  getEmployeePayslip,
  getEmployeeVacationLeft,
  listEmployeePayslipMonths,
} from '../services/payroll/employee-payslip.service.js';
import { moscowTodayIso } from '../utils/date.utils.js';

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Ожидается месяц YYYY-MM');

const NO_EMPLOYEE = 'Учётная запись не связана с сотрудником';

/** GET /api/my-payslip — месяцы листка (новые первыми) и остаток отпуска на сегодня. */
const getSummary = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const employeeId = req.user.employee_id;
  if (!employeeId) {
    res.status(403).json({ success: false, error: NO_EMPLOYEE });
    return;
  }
  try {
    const [months, vacation] = await Promise.all([
      listEmployeePayslipMonths(employeeId),
      getEmployeeVacationLeft(employeeId, moscowTodayIso()),
    ]);
    res.json({ success: true, data: { months, vacation } });
  } catch (err) {
    console.error('employeePayslip.getSummary error:', err);
    res.status(500).json({ success: false, error: 'Ошибка загрузки расчётного листа' });
  }
};

/** GET /api/my-payslip/:month — листок за месяц YYYY-MM: ready или not_ready; месяца нет в списке — 404. */
const getMonth = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const employeeId = req.user.employee_id;
  if (!employeeId) {
    res.status(403).json({ success: false, error: NO_EMPLOYEE });
    return;
  }
  const parsed = monthSchema.safeParse(req.params.month);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.errors[0]?.message ?? 'Некорректный месяц' });
    return;
  }
  try {
    const data = await getEmployeePayslip(employeeId, parsed.data, req);
    if (!data) {
      res.status(404).json({ success: false, error: 'Расчётного листа за этот месяц нет' });
      return;
    }
    res.json({ success: true, data });
  } catch (err) {
    console.error('employeePayslip.getMonth error:', err);
    res.status(500).json({ success: false, error: 'Ошибка загрузки расчётного листа' });
  }
};

export const employeePayslipController = { getSummary, getMonth };
