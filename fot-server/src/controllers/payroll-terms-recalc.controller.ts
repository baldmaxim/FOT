/**
 * Блок «Пересчёт» карточки «Зарплаты» (миграция 348): чтение суммы к доплате и отметка «Доплачено».
 * Скоуп — как у условий оплаты: читает тот, кто видит условия сотрудника, отмечает тот, кто может их править.
 */
import type { Response } from 'express';
import { z } from 'zod';

import { resolveEffectivePageAccess } from '../services/access-control.service.js';
import { auditService } from '../services/audit.service.js';
import { canEditPayrollEmployee, canReadPayrollEmployee } from '../services/payroll/payroll-scope.service.js';
import { getEmployeeRecalc, settleEmployeeRecalc } from '../services/payroll/payroll-terms-recalc.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

const settleBodySchema = z.object({
  record_ids: z.array(z.number().int().positive()).min(1, 'Нет записей пересчёта').max(500),
});

/** GET /api/payroll/terms/employee/:empId/recalc — месяцы, итог, записи и можно ли отметить «Доплачено». */
const getByEmployee = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = Number(req.params.empId);
    if (!Number.isInteger(employeeId) || !(await canReadPayrollEmployee(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    const recalc = await getEmployeeRecalc(employeeId, req);
    // Ключ страницы тоже: GET доступен и с правом только на просмотр.
    const canSettle = recalc.months.length > 0
      && await resolveEffectivePageAccess(req, '/salary/terms', 'edit')
      && await canEditPayrollEmployee(req, employeeId);
    res.json({ success: true, data: { ...recalc, can_settle: canSettle } });
  } catch (err) {
    console.error('payrollTermsRecalc.getByEmployee error:', err);
    res.status(500).json({ success: false, error: 'Ошибка расчёта пересчёта' });
  }
};

/**
 * POST /api/payroll/terms/employee/:empId/recalc/settle — «Доплачено». Закрывает только присланные записи: правка,
 * сделанная пока карточка была открыта, останется. Сумма в аудите — посчитанная сервером до закрытия.
 */
const settle = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = Number(req.params.empId);
    if (!Number.isInteger(employeeId) || !(await canEditPayrollEmployee(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    const body = settleBodySchema.parse(req.body);
    const recalc = await getEmployeeRecalc(employeeId, req);
    const settled = await settleEmployeeRecalc(employeeId, body.record_ids, req.user.id);
    if (settled.length > 0) {
      await auditService.logFromRequest(req, req.user.id, 'PAYROLL_TERMS_RECALC_SETTLED', {
        entityType: 'payroll_terms_recalcs',
        entityId: String(employeeId),
        details: { employee_id: employeeId, record_ids: settled, total: recalc.total, months: recalc.months },
      });
    }
    res.json({ success: true, data: { settled: settled.length } });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ success: false, error: err.errors[0]?.message ?? 'Некорректные данные' });
      return;
    }
    console.error('payrollTermsRecalc.settle error:', err);
    res.status(500).json({ success: false, error: 'Не удалось отметить доплату' });
  }
};

export const payrollTermsRecalcController = { getByEmployee, settle };
