/**
 * «Доплата за проживание» — таблица окна «Справочник» на «Расчётах» (миграция 315).
 *
 * Те же суммы, что «Компенсация → Проживание» окна сотрудника (housing_compensation условий оплаты):
 * правка в таблице видна в окне, и наоборот. Без условий оплаты (оклада) доплату не записать.
 */
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import { withTransaction } from '../config/postgres.js';
import { auditService } from '../services/audit.service.js';
import { DormitoryAllowanceConflictError } from '../services/payroll/payroll-dormitory-allowances.service.js';
import { listHousingAllowances, setHousingFrom } from '../services/payroll/payroll-housing.service.js';
import {
  canWritePayrollRegistryEmployee,
  resolvePayrollStaffScope,
} from '../services/payroll/payroll-registry-scope.service.js';
import { resolvePayrollEditPredicate } from '../services/payroll/payroll-scope.service.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import {
  handlePayrollZodError,
  parsePayrollEmployeeIdParam,
  payrollDateSchema,
  payrollPositiveMoneySchema,
  payrollRegistryTermsPeriod,
  withCanEdit,
} from './payroll-dictionary.helpers.js';

/** amount null — снять доплату с effective_from. */
const setSchema = z.object({
  amount: payrollPositiveMoneySchema('Укажите сумму доплаты').nullable(),
  effective_from: payrollDateSchema('Укажите дату «Действует с»'),
});

const NO_ACCESS = { success: false, error: 'Нет доступа к сотруднику' };
const NO_TERMS = {
  success: false,
  error: 'У сотрудника нет оклада на эту дату — сначала внесите оклад в окне сотрудника',
  code: 'NO_TERMS',
};

/**
 * GET /api/payroll/housing-allowances[?months=…] — у кого доплата за проживание: без months — в условиях
 * на сегодня (старый клиент), months=all — за весь период, список — в этих месяцах.
 */
const list = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const period = payrollRegistryTermsPeriod(req.query.months, moscowTodayIso());
    const [scope, canEdit] = await Promise.all([resolvePayrollStaffScope(req), resolvePayrollEditPredicate(req)]);
    const rows = await listHousingAllowances({ ...scope, period });
    res.json({ success: true, data: withCanEdit(rows, canEdit) });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('payrollHousing.list error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения списка' });
  }
};

/**
 * PUT /api/payroll/housing-allowances/employee/:empId { amount, effective_from } — доплата за
 * проживание с даты (null — снять). Меняется только проживание: версия условий на дату делится,
 * поздние версии получают ту же сумму.
 */
const set = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = parsePayrollEmployeeIdParam(req);
    if (employeeId === null || !(await canWritePayrollRegistryEmployee(req, employeeId))) {
      res.status(403).json(NO_ACCESS);
      return;
    }
    const body = setSchema.parse(req.body);
    const result = await withTransaction(client => setHousingFrom(client, {
      employeeId,
      amount: body.amount,
      from: body.effective_from,
      createdBy: req.user.id,
    }));
    if (result.status === 'no_terms') {
      res.status(409).json(NO_TERMS);
      return;
    }
    if (result.status === 'saved') {
      // Правка условий — тем же событием, что из окна сотрудника; source отличает таблицу.
      await auditService.logFromRequest(req, req.user.id, 'PAYROLL_TERMS_ASSIGNED', {
        entityType: 'payroll_compensation_terms',
        entityId: String(result.termsId),
        details: {
          source: 'housing_registry',
          employee_id: employeeId,
          effective_from: body.effective_from,
          housing_compensation: body.amount,
          previous_housing_compensation: result.previousAmount,
          previous_terms_id: result.previousTermsId,
          later_versions_updated: result.laterUpdated,
        },
      });
    }
    res.json({ success: true, data: { changed: result.status === 'saved' } });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    // Одна доплата из двух: в эти дни у сотрудника доплата за общежитие (запись откачена).
    if (err instanceof DormitoryAllowanceConflictError) {
      res.status(409).json({ success: false, error: err.message, code: err.code });
      return;
    }
    console.error('payrollHousing.set error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения доплаты' });
  }
};

export const payrollHousingController = { list, set };
