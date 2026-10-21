/**
 * Удержания «Зарплаты»: справочник видов и виды удержаний сотрудника.
 *
 * Виды сотруднику отмечаются в окне его карточки на «Расчётах» и сохраняются вместе с ней.
 * Справочник правится в окне «Справочник» на «Расчётах»: добавить, переименовать, удалить вид.
 * Удержания, внесённые кадрами («Управление кадрами» → «Удержания», миграция 318), окно сотрудника показывает
 * только для чтения.
 */
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import { withTransaction } from '../config/postgres.js';
import { auditService } from '../services/audit.service.js';
import {
  addDeductionKind,
  allDeductionKindsExist,
  deleteDeductionKind,
  getEmployeeDeductionKindIds,
  listDeductionKinds,
  renameDeductionKind,
  setEmployeeDeductionKinds,
} from '../services/payroll/payroll-deduction-kinds.service.js';
import { canEditPayrollEmployee, canReadPayrollEmployee } from '../services/payroll/payroll-scope.service.js';
import { lockPayrollEmployee } from '../services/payroll/payroll-terms.service.js';
import { listDeductions } from '../services/staff-deductions.service.js';
import { handlePayrollZodError, parsePayrollDictionaryId, payrollDictionaryNameSchema } from './payroll-dictionary.helpers.js';

const kindNameSchema = z.object({ name: payrollDictionaryNameSchema('Введите название вида') });

const saveKindsSchema = z.object({
  kind_ids: z.array(z.coerce.number().int().positive()).max(100),
});

const parseEmployeeId = (req: AuthenticatedRequest): number | null => {
  const employeeId = Number(req.params.empId);
  return Number.isInteger(employeeId) && employeeId > 0 ? employeeId : null;
};

/** GET /api/payroll/deductions/employee/:empId — виды удержаний сотрудника (для окна карточки). */
const getByEmployee = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = parseEmployeeId(req);
    if (employeeId === null || !(await canReadPayrollEmployee(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    res.json({ success: true, data: { kind_ids: await getEmployeeDeductionKindIds(employeeId) } });
  } catch (err) {
    console.error('payrollDeductions.getByEmployee error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения удержаний сотрудника' });
  }
};

/**
 * GET /api/payroll/deductions/employee/:empId/staff — удержания сотрудника, внесённые кадрами (вид, месяц, сумма):
 * в окне сотрудника на «Расчётах» только для чтения.
 */
const getStaffByEmployee = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = parseEmployeeId(req);
    if (employeeId === null || !(await canReadPayrollEmployee(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    res.json({ success: true, data: await listDeductions({ employeeIds: [employeeId] }) });
  } catch (err) {
    console.error('payrollDeductions.getStaffByEmployee error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения удержаний из кадров' });
  }
};

/** PUT /api/payroll/deductions/employee/:empId { kind_ids } — заменить виды удержаний сотрудника. */
const saveByEmployee = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = parseEmployeeId(req);
    if (employeeId === null || !(await canEditPayrollEmployee(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    const { kind_ids: kindIds } = saveKindsSchema.parse(req.body);
    if (!(await allDeductionKindsExist(kindIds))) {
      res.status(400).json({ success: false, error: 'Вид удержания не найден в справочнике' });
      return;
    }
    // Та же блокировка, что у «Удержаний» «Справочника»: правка видов из окна и из таблицы не перемешивается.
    const { added, removed } = await withTransaction(async client => {
      await lockPayrollEmployee(client, employeeId);
      return setEmployeeDeductionKinds(client, employeeId, kindIds);
    });
    if (added.length > 0 || removed.length > 0) {
      await auditService.logFromRequest(req, req.user.id, 'PAYROLL_EMPLOYEE_DEDUCTIONS_SAVED', {
        entityType: 'payroll_employee_deductions',
        entityId: String(employeeId),
        details: { employee_id: employeeId, added, removed },
      });
    }
    res.json({ success: true, data: { kind_ids: await getEmployeeDeductionKindIds(employeeId) } });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('payrollDeductions.saveByEmployee error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения удержаний сотрудника' });
  }
};

/** GET /api/payroll/deduction-kinds — справочник видов удержаний в порядке списка. */
const listKinds = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    res.json({ success: true, data: await listDeductionKinds() });
  } catch (err) {
    console.error('payrollDeductions.listKinds error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения видов удержаний' });
  }
};

/** POST /api/payroll/deduction-kinds { name } — добавить вид; такой уже есть — 409. */
const addKind = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { name } = kindNameSchema.parse(req.body);
    const kind = await addDeductionKind(name);
    if (!kind) {
      res.status(409).json({ success: false, error: 'Такой вид удержания уже есть', code: 'DUPLICATE_KIND' });
      return;
    }
    await auditService.logFromRequest(req, req.user.id, 'PAYROLL_DEDUCTION_KIND_ADDED', {
      entityType: 'payroll_deduction_kinds',
      entityId: String(kind.id),
      details: { name: kind.name },
    });
    res.json({ success: true, data: kind });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('payrollDeductions.addKind error:', err);
    res.status(500).json({ success: false, error: 'Ошибка добавления вида удержания' });
  }
};

/** PATCH /api/payroll/deduction-kinds/:id { name } — переименовать вид; название занято — 409. */
const renameKind = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parsePayrollDictionaryId(req);
    if (id === null) {
      res.status(404).json({ success: false, error: 'Вид удержания не найден' });
      return;
    }
    const { name } = kindNameSchema.parse(req.body);
    const renamed = await renameDeductionKind(id, name);
    if (renamed === null) {
      res.status(404).json({ success: false, error: 'Вид удержания не найден' });
      return;
    }
    if (renamed === 'duplicate') {
      res.status(409).json({ success: false, error: 'Такой вид удержания уже есть', code: 'DUPLICATE_KIND' });
      return;
    }
    if (renamed.previousName !== renamed.kind.name) {
      await auditService.logFromRequest(req, req.user.id, 'PAYROLL_DEDUCTION_KIND_RENAMED', {
        entityType: 'payroll_deduction_kinds',
        entityId: String(id),
        details: { from: renamed.previousName, to: renamed.kind.name },
      });
    }
    res.json({ success: true, data: renamed.kind });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('payrollDeductions.renameKind error:', err);
    res.status(500).json({ success: false, error: 'Ошибка переименования вида удержания' });
  }
};

/** DELETE /api/payroll/deduction-kinds/:id — удалить вид; отмечен у сотрудников — 409 с их числом. */
const deleteKind = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parsePayrollDictionaryId(req);
    const deleted = id === null ? null : await deleteDeductionKind(id);
    if (id === null || deleted === null) {
      res.status(404).json({ success: false, error: 'Вид удержания не найден' });
      return;
    }
    if ('inUse' in deleted) {
      res.status(409).json({
        success: false,
        error: `Вид отмечен у сотрудников: ${deleted.inUse}`,
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
    console.error('payrollDeductions.deleteKind error:', err);
    res.status(500).json({ success: false, error: 'Ошибка удаления вида удержания' });
  }
};

export const payrollDeductionsController = {
  getByEmployee,
  getStaffByEmployee,
  saveByEmployee,
  listKinds,
  addKind,
  renameKind,
  deleteKind,
};
