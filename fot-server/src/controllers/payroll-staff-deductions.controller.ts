/**
 * «Удержания» — таблица окна «Справочник» на «Расчётах» (миграция 321).
 *
 * Строки — удержания staff_deductions (вид, подвид, месяц, сумма): те же записи, что во вкладке кадров
 * «Удержания»; правка здесь видна там, и наоборот. Охват — «штат зарплаты» (работающие, не подрядчики): прошлые
 * строки уволенного правят кадры. Аудит — те же события STAFF_DEDUCTION_* с source.
 */
import type { Response } from 'express';

import type { AuthenticatedRequest } from '../types/index.js';
import { auditService } from '../services/audit.service.js';
import {
  canWritePayrollRegistryEmployee,
  resolvePayrollStaffScope,
} from '../services/payroll/payroll-registry-scope.service.js';
import { resolvePayrollEditPredicate } from '../services/payroll/payroll-scope.service.js';
import {
  addDeduction,
  deleteDeduction,
  getDeduction,
  listPayrollDeductions,
  updateDeduction,
} from '../services/staff-deductions.service.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import {
  handlePayrollZodError,
  parsePayrollDictionaryId,
  payrollRegistryTermsPeriod,
  withCanEdit,
} from './payroll-dictionary.helpers.js';
import {
  STAFF_DEDUCTION_REF_MISSING,
  staffDeductionAddRefusal,
  staffDeductionAddSchema,
  staffDeductionAuditDetails,
  staffDeductionChanged,
  staffDeductionFieldsSchema,
} from './staff-deduction-input.js';

const NO_ACCESS = { success: false, error: 'Нет доступа к сотруднику' };
const NOT_FOUND = { success: false, error: 'Удержание не найдено' };
const AUDIT_SOURCE = 'deduction_registry';

/** Удержание по :id, которое можно править из «Зарплаты»; иначе ответ отправлен и null. */
const writableDeduction = async (req: AuthenticatedRequest, res: Response) => {
  const id = parsePayrollDictionaryId(req);
  const current = id === null ? null : await getDeduction(id);
  if (id === null || !current) {
    res.status(404).json(NOT_FOUND);
    return null;
  }
  if (!(await canWritePayrollRegistryEmployee(req, current.employee_id))) {
    res.status(403).json(NO_ACCESS);
    return null;
  }
  return { id, current };
};

/**
 * GET /api/payroll/staff-deductions[?months=…] — удержания «штата зарплаты»: без months — текущего месяца,
 * months=all — все, список — этих месяцев.
 */
const list = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const period = payrollRegistryTermsPeriod(req.query.months, moscowTodayIso());
    const [scope, canEdit] = await Promise.all([resolvePayrollStaffScope(req), resolvePayrollEditPredicate(req)]);
    const rows = await listPayrollDeductions({ ...scope, period });
    res.json({ success: true, data: withCanEdit(rows, canEdit) });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('payrollStaffDeductions.list error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения списка' });
  }
};

/** POST /api/payroll/staff-deductions { employee_id, kind_id, subkind_id?, month, amount } — добавить удержание. */
const add = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { employee_id: employeeId, ...input } = staffDeductionAddSchema.parse(req.body);
    const refusal = await staffDeductionAddRefusal(employeeId);
    if (refusal) {
      res.status(refusal.status).json(refusal.body);
      return;
    }
    if (!(await canWritePayrollRegistryEmployee(req, employeeId))) {
      res.status(403).json(NO_ACCESS);
      return;
    }
    const deduction = await addDeduction(employeeId, input);
    if (typeof deduction === 'string') {
      res.status(409).json(STAFF_DEDUCTION_REF_MISSING[deduction]);
      return;
    }
    await auditService.logFromRequest(req, req.user.id, 'STAFF_DEDUCTION_ADDED', {
      entityType: 'staff_deductions',
      entityId: String(deduction.id),
      details: { source: AUDIT_SOURCE, ...staffDeductionAuditDetails(deduction) },
    });
    res.json({ success: true, data: deduction });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('payrollStaffDeductions.add error:', err);
    res.status(500).json({ success: false, error: 'Ошибка добавления удержания' });
  }
};

/** PATCH /api/payroll/staff-deductions/:id { kind_id, subkind_id?, month, amount } — сотрудник не меняется. */
const update = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const input = staffDeductionFieldsSchema.parse(req.body);
    const target = await writableDeduction(req, res);
    if (!target) return;
    const updated = await updateDeduction(target.id, input);
    if (updated === null) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    if (typeof updated === 'string') {
      res.status(409).json(STAFF_DEDUCTION_REF_MISSING[updated]);
      return;
    }
    const { before, after } = updated;
    if (staffDeductionChanged(before, after)) {
      await auditService.logFromRequest(req, req.user.id, 'STAFF_DEDUCTION_UPDATED', {
        entityType: 'staff_deductions',
        entityId: String(target.id),
        details: { source: AUDIT_SOURCE, from: staffDeductionAuditDetails(before), to: staffDeductionAuditDetails(after) },
      });
    }
    res.json({ success: true, data: after });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('payrollStaffDeductions.update error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения удержания' });
  }
};

/** DELETE /api/payroll/staff-deductions/:id — удалить удержание. */
const remove = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const target = await writableDeduction(req, res);
    if (!target) return;
    const deleted = await deleteDeduction(target.id);
    if (!deleted) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    await auditService.logFromRequest(req, req.user.id, 'STAFF_DEDUCTION_DELETED', {
      entityType: 'staff_deductions',
      entityId: String(target.id),
      details: { source: AUDIT_SOURCE, ...staffDeductionAuditDetails(deleted) },
    });
    res.json({ success: true, data: deleted });
  } catch (err) {
    console.error('payrollStaffDeductions.remove error:', err);
    res.status(500).json({ success: false, error: 'Ошибка удаления удержания' });
  }
};

export const payrollStaffDeductionsController = { list, add, update, remove };
