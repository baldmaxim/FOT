/**
 * Отпуск сотрудника для карточки «Зарплата → Условия оплаты»: только чтение.
 * Скоуп — как у истории условий: видеть сотрудника должен тот, кто видит его условия.
 */
import type { Response } from 'express';

import type { AuthenticatedRequest } from '../types/index.js';
import { canAccessEmployeeInScope } from '../services/data-scope.service.js';
import { getVacationHistory, getVacationSummary } from '../services/payroll/payroll-vacation.service.js';
import { moscowTodayIso } from '../utils/date.utils.js';

/** GET /api/payroll/vacation/employee/:empId — сколько отгулено и история отпусков. */
const getByEmployee = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = Number(req.params.empId);
    if (!Number.isInteger(employeeId) || !(await canAccessEmployeeInScope(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    const [summary, history] = await Promise.all([
      getVacationSummary(employeeId, moscowTodayIso()),
      getVacationHistory(employeeId),
    ]);
    res.json({ success: true, data: { summary, history } });
  } catch (err) {
    console.error('payrollVacation.getByEmployee error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения отпусков сотрудника' });
  }
};

export const payrollVacationController = { getByEmployee };
