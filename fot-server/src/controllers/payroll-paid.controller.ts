/**
 * «Оплачено» в карточке «Зарплата → Подробно»: суммы статей «Сводной ведомости» ЗУП по месяцам.
 * Только чтение: суммы приходят из 1С (API или выгрузка), в карточке не вводятся.
 * Скоуп — как у условий оплаты: читает тот, кто видит условия сотрудника.
 */
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import { getPaidAmounts } from '../services/payroll/payroll-paid.service.js';
import { getPaidDebts } from '../services/payroll/payroll-paid-debts.service.js';
import { getPayslipInfo } from '../services/payroll/payroll-payslip.service.js';
import { canReadPayrollEmployee } from '../services/payroll/payroll-scope.service.js';

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Ожидается месяц YYYY-MM');

const rangeQuerySchema = z.object({
  from: monthSchema,
  to: monthSchema,
}).refine(range => range.from <= range.to, 'Начало периода позже конца');

const payslipQuerySchema = z.object({ month: monthSchema });

/** GET /api/payroll/terms/employee/:empId/paid?from=YYYY-MM&to=YYYY-MM — суммы за месяцы периода. */
const getByEmployee = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = Number(req.params.empId);
    if (!Number.isInteger(employeeId) || !(await canReadPayrollEmployee(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    const range = rangeQuerySchema.parse(req.query);
    const data = await getPaidAmounts(employeeId, range.from, range.to);
    res.json({ success: true, data });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ success: false, error: err.errors[0]?.message ?? 'Некорректные данные' });
      return;
    }
    console.error('payrollPaid.getByEmployee error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения сумм «Оплачено»' });
  }
};

/**
 * GET /api/payroll/terms/employee/:empId/paid-debts?from=YYYY-MM&to=YYYY-MM — справочно долги прошлых месяцев
 * из ведомостей бригад за месяцы периода (миграция 332). Доступ — как у сумм «Оплачено».
 */
const getDebtsByEmployee = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = Number(req.params.empId);
    if (!Number.isInteger(employeeId) || !(await canReadPayrollEmployee(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    const range = rangeQuerySchema.parse(req.query);
    const data = await getPaidDebts(employeeId, range.from, range.to);
    res.json({ success: true, data });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ success: false, error: err.errors[0]?.message ?? 'Некорректные данные' });
      return;
    }
    console.error('payrollPaid.getDebtsByEmployee error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения долгов прошлых месяцев' });
  }
};

/**
 * GET /api/payroll/terms/employee/:empId/payslip?month=YYYY-MM — к расчётному листку «Истории выплат»:
 * период, отработанные дни по табелю (рабочие / выходные) и условия оплаты месяца. Суммы — из /paid.
 */
const getPayslip = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = Number(req.params.empId);
    if (!Number.isInteger(employeeId) || !(await canReadPayrollEmployee(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    const { month } = payslipQuerySchema.parse(req.query);
    const data = await getPayslipInfo(employeeId, month, req);
    res.json({ success: true, data });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ success: false, error: err.errors[0]?.message ?? 'Некорректные данные' });
      return;
    }
    console.error('payrollPaid.getPayslip error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения расчётного листка' });
  }
};

export const payrollPaidController = { getByEmployee, getDebtsByEmployee, getPayslip };
