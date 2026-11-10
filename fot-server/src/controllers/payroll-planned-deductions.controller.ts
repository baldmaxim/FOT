/**
 * «Плановые удержания» «Зарплаты» (миграция 357): вкладка окна «Удержания» в «Справочнике» на «Расчётах» и окно
 * сотрудника (список и история). Те же записи — у кадров («Удержания» → «Плановые удержания»).
 *
 * Охват таблиц — «штат зарплаты» (работающие, не подрядчики), запись — canWritePayrollRegistryEmployee, как у
 * помесячных удержаний «Зарплаты». Окно сотрудника — canReadPayrollEmployee, без фильтра штата: уволенный видит свои.
 */
import type { Response } from 'express';

import type { AuthenticatedRequest } from '../types/index.js';
import {
  listEmployeePlannedDeductions,
  listPlannedDeductionChanges,
} from '../services/payroll/payroll-planned-deductions.service.js';
import {
  canWritePayrollRegistryEmployee,
  resolvePayrollStaffScope,
} from '../services/payroll/payroll-registry-scope.service.js';
import { canReadPayrollEmployee, resolvePayrollEditPredicate } from '../services/payroll/payroll-scope.service.js';
import { parsePayrollEmployeeIdParam } from './payroll-dictionary.helpers.js';
import { createPlannedDeductionHandlers } from './planned-deduction-handlers.js';

const handlers = createPlannedDeductionHandlers({
  source: 'deduction_registry',
  scope: async req => ({ kind: 'payroll', ...(await resolvePayrollStaffScope(req)) }),
  canWrite: canWritePayrollRegistryEmployee,
  editPredicate: resolvePayrollEditPredicate,
});

/** Сотрудник из :empId, которого можно читать; иначе ответ 403 отправлен и null. */
const readableEmployee = async (req: AuthenticatedRequest, res: Response): Promise<number | null> => {
  const employeeId = parsePayrollEmployeeIdParam(req);
  if (employeeId === null || !(await canReadPayrollEmployee(req, employeeId))) {
    res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
    return null;
  }
  return employeeId;
};

/** GET /api/payroll/deductions/employee/:empId/planned — плановые удержания сотрудника (окно сотрудника). */
const listByEmployee = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = await readableEmployee(req, res);
    if (employeeId === null) return;
    res.json({ success: true, data: await listEmployeePlannedDeductions(employeeId) });
  } catch (err) {
    console.error('payrollPlannedDeductions.listByEmployee error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения плановых удержаний сотрудника' });
  }
};

/** GET /api/payroll/deductions/employee/:empId/planned/changes — история для «Истории изменений» карточки. */
const listChanges = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = await readableEmployee(req, res);
    if (employeeId === null) return;
    res.json({ success: true, data: await listPlannedDeductionChanges(employeeId) });
  } catch (err) {
    console.error('payrollPlannedDeductions.listChanges error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения истории плановых удержаний' });
  }
};

export const payrollPlannedDeductionsController = { ...handlers, listByEmployee, listChanges };
