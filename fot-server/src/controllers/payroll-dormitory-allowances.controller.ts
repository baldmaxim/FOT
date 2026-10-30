/**
 * «Доплата за общежитие» — таблица окна «Справочник» на «Расчётах» (миграция 317): кому платят за то, что
 * он не живёт в общежитии компании, период «с — по». Сумма — значение ставки, одна на всех.
 * С миграции 339 доплата считается автоматически (членам бригад вне «Общежития», payroll-payslip.rules.ts), ручной
 * список расчёт не читает: добавить и изменить — 409 DORMITORY_ALLOWANCE_AUTO (старый фронт во время выкладки
 * не создаст запись, которая ни на что не влияет); список и удаление прежние.
 *
 * Удаление и аудит — одной транзакцией: не записался аудит — нет и удаления.
 */
import type { Response } from 'express';

import type { AuthenticatedRequest } from '../types/index.js';
import { withTransaction } from '../config/postgres.js';
import { auditService } from '../services/audit.service.js';
import {
  deleteDormitoryAllowance,
  getDormitoryAllowance,
  listDormitoryAllowances,
  type IDormitoryAllowance,
} from '../services/payroll/payroll-dormitory-allowances.service.js';
import {
  canWritePayrollRegistryEmployee,
  resolvePayrollStaffScope,
} from '../services/payroll/payroll-registry-scope.service.js';
import { resolvePayrollEditPredicate } from '../services/payroll/payroll-scope.service.js';
import { parsePayrollDictionaryId, withCanEdit } from './payroll-dictionary.helpers.js';

const NO_ACCESS = { success: false, error: 'Нет доступа к сотруднику' };
const NOT_FOUND = { success: false, error: 'Запись не найдена' };

const auditDetails = (allowance: IDormitoryAllowance) => ({
  employee_id: allowance.employee_id,
  full_name: allowance.full_name,
  date_from: allowance.date_from,
  date_to: allowance.date_to,
});

/** GET /api/payroll/dormitory-allowances — все периоды (история) «штата зарплаты». */
const list = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const [scope, canEdit] = await Promise.all([resolvePayrollStaffScope(req), resolvePayrollEditPredicate(req)]);
    res.json({ success: true, data: withCanEdit(await listDormitoryAllowances(scope), canEdit) });
  } catch (err) {
    console.error('payrollDormitoryAllowances.list error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения списка' });
  }
};

const AUTO_ALLOWANCE = {
  success: false,
  error: 'Доплата за общежитие считается автоматически: всем членам бригад, кроме живущих в «Общежитии»',
  code: 'DORMITORY_ALLOWANCE_AUTO',
};

/** POST и PATCH /api/payroll/dormitory-allowances — с миграции 339 не принимаются (см. шапку). */
const rejectManual = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  res.status(409).json(AUTO_ALLOWANCE);
};

/** DELETE /api/payroll/dormitory-allowances/:id — удалить ошибочный период. */
const remove = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parsePayrollDictionaryId(req);
    const current = id === null ? null : await getDormitoryAllowance(id);
    if (id === null || !current) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    if (!(await canWritePayrollRegistryEmployee(req, current.employee_id))) {
      res.status(403).json(NO_ACCESS);
      return;
    }
    const deleted = await withTransaction(async client => {
      const before = await deleteDormitoryAllowance(client, id);
      if (before) {
        await auditService.logFromRequestWithClient(client, req, req.user.id, 'PAYROLL_DORMITORY_ALLOWANCE_DELETED', {
          entityType: 'payroll_dormitory_allowances',
          entityId: String(id),
          details: auditDetails(before),
        });
      }
      return before;
    });
    if (!deleted) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    res.json({ success: true, data: deleted });
  } catch (err) {
    console.error('payrollDormitoryAllowances.remove error:', err);
    res.status(500).json({ success: false, error: 'Ошибка удаления' });
  }
};

export const payrollDormitoryAllowancesController = { list, add: rejectManual, update: rejectManual, remove };
