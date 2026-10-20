/**
 * «Доплата за общежитие» — таблица окна «Справочник» на «Расчётах» (миграция 317): кому платят за то, что
 * он не живёт в общежитии компании, период «с — по». Сумма — значение ставки, одна на всех.
 * Пока это список: в расчёт (его ещё нет) не подставляется.
 *
 * Запись и аудит — одной транзакцией: не записался аудит — нет и записи; повтор того же запроса
 * (тот же период) ничего не пишет и аудит не дублирует.
 */
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import { withTransaction } from '../config/postgres.js';
import { auditService } from '../services/audit.service.js';
import {
  addDormitoryAllowance,
  deleteDormitoryAllowance,
  DormitoryAllowanceConflictError,
  getDormitoryAllowance,
  listDormitoryAllowances,
  PG_EXCLUSION_VIOLATION,
  updateDormitoryAllowance,
  type IDormitoryAllowance,
} from '../services/payroll/payroll-dormitory-allowances.service.js';
import { hasPgCode } from '../services/payroll/payroll-pg-errors.js';
import {
  canWritePayrollRegistryEmployee,
  resolvePayrollStaffScope,
} from '../services/payroll/payroll-registry-scope.service.js';
import { resolvePayrollEditPredicate } from '../services/payroll/payroll-scope.service.js';
import {
  handlePayrollZodError,
  parsePayrollDictionaryId,
  payrollDateSchema,
  payrollEmployeeIdSchema,
  withCanEdit,
} from './payroll-dictionary.helpers.js';

const allowanceFields = {
  date_from: payrollDateSchema('Укажите дату «Доплата с»'),
  date_to: payrollDateSchema('Неверная дата «по»').nullable().optional().transform(value => value ?? null),
};
/** «По» включительно: один день (с = по) — допустимый период. */
const datesInOrder = (value: { date_from: string; date_to: string | null }): boolean =>
  value.date_to === null || value.date_to >= value.date_from;
const DATES_ORDER = { message: 'Дата «по» раньше даты «с»', path: ['date_to'] };

const addSchema = z.object({ employee_id: payrollEmployeeIdSchema, ...allowanceFields }).refine(datesInOrder, DATES_ORDER);
const updateSchema = z.object(allowanceFields).refine(datesInOrder, DATES_ORDER);

const NO_ACCESS = { success: false, error: 'Нет доступа к сотруднику' };
const NOT_FOUND = { success: false, error: 'Запись не найдена' };
const OVERLAP = {
  success: false,
  error: 'У сотрудника уже есть доплата за общежитие в эти даты',
  code: 'ALLOWANCE_OVERLAP',
};

const auditDetails = (allowance: IDormitoryAllowance) => ({
  employee_id: allowance.employee_id,
  full_name: allowance.full_name,
  date_from: allowance.date_from,
  date_to: allowance.date_to,
});

/** Отказ правила или пересечения периодов — 409 с понятным текстом; иное — false (500 у вызывающего). */
const handleConflict = (err: unknown, res: Response): boolean => {
  if (err instanceof DormitoryAllowanceConflictError) {
    res.status(409).json({ success: false, error: err.message, code: err.code });
    return true;
  }
  if (hasPgCode(err, PG_EXCLUSION_VIOLATION)) {
    res.status(409).json(OVERLAP);
    return true;
  }
  return false;
};

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

/** POST /api/payroll/dormitory-allowances { employee_id, date_from, date_to? } — добавить период. */
const add = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { employee_id: employeeId, ...input } = addSchema.parse(req.body);
    if (!(await canWritePayrollRegistryEmployee(req, employeeId))) {
      res.status(403).json(NO_ACCESS);
      return;
    }
    const result = await withTransaction(async client => {
      const saved = await addDormitoryAllowance(client, employeeId, input);
      if (saved.status === 'saved') {
        await auditService.logFromRequestWithClient(client, req, req.user.id, 'PAYROLL_DORMITORY_ALLOWANCE_ADDED', {
          entityType: 'payroll_dormitory_allowances',
          entityId: String(saved.allowance.id),
          details: auditDetails(saved.allowance),
        });
      }
      return saved;
    });
    res.json({ success: true, data: result.allowance });
  } catch (err) {
    if (handlePayrollZodError(err, res) || handleConflict(err, res)) return;
    console.error('payrollDormitoryAllowances.add error:', err);
    res.status(500).json({ success: false, error: 'Ошибка добавления' });
  }
};

/** PATCH /api/payroll/dormitory-allowances/:id { date_from, date_to? } — даты; сотрудник не меняется. */
const update = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parsePayrollDictionaryId(req);
    const current = id === null ? null : await getDormitoryAllowance(id);
    if (id === null || !current) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    const input = updateSchema.parse(req.body);
    if (!(await canWritePayrollRegistryEmployee(req, current.employee_id))) {
      res.status(403).json(NO_ACCESS);
      return;
    }
    const result = await withTransaction(async client => {
      const saved = await updateDormitoryAllowance(client, id, input);
      if (saved?.status === 'saved') {
        await auditService.logFromRequestWithClient(client, req, req.user.id, 'PAYROLL_DORMITORY_ALLOWANCE_UPDATED', {
          entityType: 'payroll_dormitory_allowances',
          entityId: String(id),
          details: { from: auditDetails(saved.before), to: auditDetails(saved.allowance) },
        });
      }
      return saved;
    });
    if (!result) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    res.json({ success: true, data: result.allowance });
  } catch (err) {
    if (handlePayrollZodError(err, res) || handleConflict(err, res)) return;
    console.error('payrollDormitoryAllowances.update error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения' });
  }
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

export const payrollDormitoryAllowancesController = { list, add, update, remove };
