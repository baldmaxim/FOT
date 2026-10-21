/**
 * «Удержания» (миграция 318): вкладка «Управления кадрами» (право /staff-control/deductions) — удержания
 * сотрудников по месяцам и справочник видов, общий с «Зарплатой» (payroll_deduction_kinds).
 *
 * Охват — как у «Проживания»: список — как список кадров (resolveStaffRosterEmployeeIds), запись —
 * canWriteEmployeeInScope; уволенного (его назначения отделов сняты) правит тот, кто видит его в «Уволенных».
 */
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import { auditService } from '../services/audit.service.js';
import { canWriteEmployeeInScope } from '../services/data-scope.service.js';
import { getEmployeeState, searchCandidates } from '../services/dormitory-stays.service.js';
import {
  canSeeEmployeeInStaffList,
  resolveStaffRosterEmployeeIds,
} from '../services/employee-scope-filter.service.js';
import {
  addDeductionKindWithDefault,
  deleteDeductionKind,
  listDeductionKindsWithDefaults,
  updateDeductionKind,
  type IDeductionKindWithDefault,
} from '../services/payroll/payroll-deduction-kinds.service.js';
import {
  addDeduction,
  deleteDeduction,
  getDeduction,
  listDeductions,
  updateDeduction,
  type IStaffDeduction,
} from '../services/staff-deductions.service.js';
import {
  handlePayrollZodError,
  parsePayrollDictionaryId,
  payrollDictionaryNameSchema,
  payrollEmployeeIdSchema,
  payrollMonthSchema,
  payrollPositiveMoneySchema,
} from './payroll-dictionary.helpers.js';
import { sendTableSnapshotXlsx } from './table-snapshot-export.js';

const DEDUCTIONS_SHEET = { sheetName: 'Удержания', tableName: 'Deductions' } as const;

const deductionFields = {
  kind_id: z.number({ required_error: 'Выберите вид удержания', invalid_type_error: 'Выберите вид удержания' })
    .int('Выберите вид удержания').positive('Выберите вид удержания'),
  month: payrollMonthSchema('Укажите месяц'),
  amount: payrollPositiveMoneySchema('Укажите сумму'),
};
const addSchema = z.object({ employee_id: payrollEmployeeIdSchema, ...deductionFields });
const updateSchema = z.object(deductionFields);

/** Сумма по умолчанию не задана — null (или поле не прислали). */
const kindSchema = z.object({
  name: payrollDictionaryNameSchema('Введите название вида'),
  default_amount: payrollPositiveMoneySchema('Сумма должна быть числом')
    .nullable()
    .optional()
    .transform(value => value ?? null),
});

const NOT_FOUND = { success: false, error: 'Удержание не найдено' };
const NO_ACCESS = { success: false, error: 'Нет доступа к сотруднику' };
const KIND_MISSING = { success: false, error: 'Вид удержания не найден — обновите список видов', code: 'KIND_MISSING' };
const KIND_NOT_FOUND = { success: false, error: 'Вид удержания не найден' };
const DUPLICATE_KIND = { success: false, error: 'Такой вид удержания уже есть', code: 'DUPLICATE_KIND' };

/** Охват списка кадров набором id; 'all' — null (без ограничения). */
const rosterEmployeeIds = async (req: AuthenticatedRequest): Promise<number[] | null> => {
  const roster = await resolveStaffRosterEmployeeIds(req);
  return roster === 'all' ? null : [...roster];
};

/**
 * Можно ли менять удержание сотрудника. Уволенного увольнение выводит из назначений отделов,
 * и canWriteEmployeeInScope админу компании откажет — тогда решает «виден ли в списке кадров».
 */
const canWriteDeduction = async (req: AuthenticatedRequest, employeeId: number): Promise<boolean> => {
  if (await canWriteEmployeeInScope(req, employeeId)) return true;
  const employee = await getEmployeeState(employeeId);
  if (!employee || employee.employment_status === 'active') return false;
  return canSeeEmployeeInStaffList(req, employeeId);
};

const auditDetails = (deduction: IStaffDeduction) => ({
  employee_id: deduction.employee_id,
  full_name: deduction.full_name,
  kind_id: deduction.kind_id,
  kind_name: deduction.kind_name,
  month: deduction.month,
  amount: deduction.amount,
});

const kindAudit = (kind: IDeductionKindWithDefault) => ({ name: kind.name, default_amount: kind.default_amount });

/** GET /api/staff-deductions — все удержания в охвате списка кадров. */
const list = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    res.json({ success: true, data: await listDeductions({ employeeIds: await rosterEmployeeIds(req) }) });
  } catch (err) {
    console.error('staffDeductions.list error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения списка' });
  }
};

/** GET /api/staff-deductions/employees/search?q= — кого добавить: работающие в охвате, от 2 символов. */
const searchEmployees = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const search = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (search.length < 2) {
      res.json({ success: true, data: [] });
      return;
    }
    res.json({ success: true, data: await searchCandidates(search, await rosterEmployeeIds(req)) });
  } catch (err) {
    console.error('staffDeductions.searchEmployees error:', err);
    res.status(500).json({ success: false, error: 'Ошибка поиска' });
  }
};

/** POST /api/staff-deductions { employee_id, kind_id, month, amount } — добавить удержание. */
const add = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { employee_id: employeeId, ...input } = addSchema.parse(req.body);
    // Поиск отдаёт только работающих и не подрядчиков, но тело запроса могут собрать и руками.
    const employee = await getEmployeeState(employeeId);
    if (!employee) {
      res.status(404).json({ success: false, error: 'Сотрудник не найден' });
      return;
    }
    if (employee.employment_status !== 'active' || employee.is_archived) {
      res.status(400).json({ success: false, error: 'Добавить можно только работающего сотрудника' });
      return;
    }
    if (employee.is_contractor) {
      res.status(400).json({ success: false, error: 'Подрядчика добавить нельзя' });
      return;
    }
    if (!(await canWriteEmployeeInScope(req, employeeId))) {
      res.status(403).json(NO_ACCESS);
      return;
    }
    const deduction = await addDeduction(employeeId, input);
    if (deduction === 'kind_missing') {
      res.status(409).json(KIND_MISSING);
      return;
    }
    await auditService.logFromRequest(req, req.user.id, 'STAFF_DEDUCTION_ADDED', {
      entityType: 'staff_deductions',
      entityId: String(deduction.id),
      details: auditDetails(deduction),
    });
    res.json({ success: true, data: deduction });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('staffDeductions.add error:', err);
    res.status(500).json({ success: false, error: 'Ошибка добавления' });
  }
};

/** PATCH /api/staff-deductions/:id { kind_id, month, amount } — вид, месяц и сумма; сотрудник не меняется. */
const update = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parsePayrollDictionaryId(req);
    if (id === null) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    const input = updateSchema.parse(req.body);
    const current = await getDeduction(id);
    if (!current) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    if (!(await canWriteDeduction(req, current.employee_id))) {
      res.status(403).json(NO_ACCESS);
      return;
    }
    const updated = await updateDeduction(id, input);
    if (updated === null) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    if (updated === 'kind_missing') {
      res.status(409).json(KIND_MISSING);
      return;
    }
    const { before, after } = updated;
    if (before.kind_id !== after.kind_id || before.month !== after.month || before.amount !== after.amount) {
      await auditService.logFromRequest(req, req.user.id, 'STAFF_DEDUCTION_UPDATED', {
        entityType: 'staff_deductions',
        entityId: String(id),
        details: { from: auditDetails(before), to: auditDetails(after) },
      });
    }
    res.json({ success: true, data: after });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('staffDeductions.update error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения' });
  }
};

/** DELETE /api/staff-deductions/:id — удалить удержание. */
const remove = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parsePayrollDictionaryId(req);
    const current = id === null ? null : await getDeduction(id);
    if (id === null || !current) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    if (!(await canWriteDeduction(req, current.employee_id))) {
      res.status(403).json(NO_ACCESS);
      return;
    }
    const deleted = await deleteDeduction(id);
    if (!deleted) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    await auditService.logFromRequest(req, req.user.id, 'STAFF_DEDUCTION_DELETED', {
      entityType: 'staff_deductions',
      entityId: String(id),
      details: auditDetails(deleted),
    });
    res.json({ success: true, data: deleted });
  } catch (err) {
    console.error('staffDeductions.remove error:', err);
    res.status(500).json({ success: false, error: 'Ошибка удаления' });
  }
};

/**
 * POST /api/staff-deductions/export — xlsx ровно как на экране: сортировка и фильтры применены
 * на клиенте, сервер только оформляет лист (до 1000 строк).
 */
const exportTable = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    await sendTableSnapshotXlsx(res, req.body, DEDUCTIONS_SHEET);
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('staffDeductions.export error:', err);
    res.status(500).json({ success: false, error: 'Не удалось выгрузить таблицу' });
  }
};

/** GET /api/staff-deductions/kinds — виды удержаний с суммой по умолчанию, в порядке справочника. */
const listKinds = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    res.json({ success: true, data: await listDeductionKindsWithDefaults() });
  } catch (err) {
    console.error('staffDeductions.listKinds error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения видов удержаний' });
  }
};

/** POST /api/staff-deductions/kinds { name, default_amount? } — добавить вид; такой уже есть — 409. */
const addKind = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { name, default_amount: defaultAmount } = kindSchema.parse(req.body);
    const kind = await addDeductionKindWithDefault(name, defaultAmount);
    if (!kind) {
      res.status(409).json(DUPLICATE_KIND);
      return;
    }
    await auditService.logFromRequest(req, req.user.id, 'PAYROLL_DEDUCTION_KIND_ADDED', {
      entityType: 'payroll_deduction_kinds',
      entityId: String(kind.id),
      details: kindAudit(kind),
    });
    res.json({ success: true, data: kind });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('staffDeductions.addKind error:', err);
    res.status(500).json({ success: false, error: 'Ошибка добавления вида удержания' });
  }
};

/** PATCH /api/staff-deductions/kinds/:id { name, default_amount? } — название и сумма по умолчанию. */
const updateKind = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parsePayrollDictionaryId(req);
    if (id === null) {
      res.status(404).json(KIND_NOT_FOUND);
      return;
    }
    const { name, default_amount: defaultAmount } = kindSchema.parse(req.body);
    const updated = await updateDeductionKind(id, name, defaultAmount);
    if (updated === null) {
      res.status(404).json(KIND_NOT_FOUND);
      return;
    }
    if (updated === 'duplicate') {
      res.status(409).json(DUPLICATE_KIND);
      return;
    }
    const { before, after } = updated;
    if (before.name !== after.name || before.default_amount !== after.default_amount) {
      await auditService.logFromRequest(req, req.user.id, 'PAYROLL_DEDUCTION_KIND_UPDATED', {
        entityType: 'payroll_deduction_kinds',
        entityId: String(id),
        details: { from: kindAudit(before), to: kindAudit(after) },
      });
    }
    res.json({ success: true, data: after });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('staffDeductions.updateKind error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения вида удержания' });
  }
};

/** DELETE /api/staff-deductions/kinds/:id — удалить вид; назначен сотрудникам — 409 с их числом. */
const deleteKind = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parsePayrollDictionaryId(req);
    const deleted = id === null ? null : await deleteDeductionKind(id);
    if (id === null || deleted === null) {
      res.status(404).json(KIND_NOT_FOUND);
      return;
    }
    if ('inUse' in deleted) {
      res.status(409).json({
        success: false,
        error: `Вид назначен сотрудникам: ${deleted.inUse}`,
        code: 'KIND_IN_USE',
        employees: deleted.inUse,
      });
      return;
    }
    await auditService.logFromRequest(req, req.user.id, 'PAYROLL_DEDUCTION_KIND_DELETED', {
      entityType: 'payroll_deduction_kinds',
      entityId: String(id),
      details: { name: deleted.name },
    });
    res.json({ success: true, data: deleted });
  } catch (err) {
    console.error('staffDeductions.deleteKind error:', err);
    res.status(500).json({ success: false, error: 'Ошибка удаления вида удержания' });
  }
};

export const staffDeductionsController = {
  list,
  searchEmployees,
  add,
  update,
  remove,
  exportTable,
  listKinds,
  addKind,
  updateKind,
  deleteKind,
};
