/**
 * «Связь» в карточке «Зарплата → Подробно»: сверхтраты сотрудника по МТС Бизнес за месяц (только чтение).
 * Скоуп — как у «Оплачено»: видит тот, кто видит условия оплаты сотрудника. Отдельного права на
 * «МТС Бизнес» не нужно — отдаётся одна сумма, без номеров и детализации.
 */
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import { getCommunicationExpense } from '../services/payroll/payroll-communication.service.js';
import { canReadPayrollEmployee } from '../services/payroll/payroll-scope.service.js';

const querySchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Ожидается месяц YYYY-MM'),
});

/** GET /api/payroll/terms/employee/:empId/communication?month=YYYY-MM */
const getByEmployee = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = Number(req.params.empId);
    if (!Number.isInteger(employeeId) || !(await canReadPayrollEmployee(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    const { month } = querySchema.parse(req.query);
    const data = await getCommunicationExpense(employeeId, month);
    res.json({ success: true, data });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ success: false, error: err.errors[0]?.message ?? 'Некорректные данные' });
      return;
    }
    console.error('payrollCommunication.getByEmployee error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения расхода на связь' });
  }
};

export const payrollCommunicationController = { getByEmployee };
