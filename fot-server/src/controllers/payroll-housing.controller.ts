/**
 * «Доплата за проживание» — таблица окна «Справочник» на «Расчётах» (миграции 315, 320).
 *
 * Строки — квартиры «Проживания» (employee_dormitory_stays kind = apartment): те же записи, что во вкладке
 * кадров «Проживание»; правка здесь видна там, и наоборот. Запись — через сервис проживаний (замок сотрудника,
 * «одна доплата из двух» с «Доплатой за общежитие»), аудит — те же события DORMITORY_STAY_* с source.
 */
import type { Response } from 'express';

import type { AuthenticatedRequest } from '../types/index.js';
import { auditService } from '../services/audit.service.js';
import { addStay, deleteStay, getStay, updateStay } from '../services/dormitory-stays.service.js';
import { DormitoryAllowanceConflictError } from '../services/payroll/payroll-dormitory-allowances.service.js';
import { listHousingAllowances } from '../services/payroll/payroll-housing.service.js';
import {
  canWritePayrollRegistryEmployee,
  resolvePayrollStaffScope,
} from '../services/payroll/payroll-registry-scope.service.js';
import { resolvePayrollEditPredicate } from '../services/payroll/payroll-scope.service.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import { dormitoryStayAuditDetails, dormitoryStayChanged, parseStayFields } from './dormitory-stay-input.js';
import {
  handlePayrollZodError,
  parsePayrollDictionaryId,
  payrollEmployeeIdSchema,
  payrollRegistryTermsPeriod,
  withCanEdit,
} from './payroll-dictionary.helpers.js';

const NO_ACCESS = { success: false, error: 'Нет доступа к сотруднику' };
const NOT_FOUND = { success: false, error: 'Запись не найдена' };
const OVERLAP = {
  success: false,
  error: 'В эти даты у сотрудника уже есть проживание — в общежитии или квартире',
  code: 'DORMITORY_OVERLAP',
};
const AUDIT_SOURCE = 'housing_registry';

/** Ошибка проверки или правило «одна доплата из двух» — ответ отправлен. */
const handleWriteError = (error: unknown, res: Response): boolean => {
  if (handlePayrollZodError(error, res)) return true;
  if (error instanceof DormitoryAllowanceConflictError) {
    res.status(409).json({ success: false, error: error.message, code: error.code });
    return true;
  }
  return false;
};

/** Квартира по :id, которую можно править из «Зарплаты»; иначе ответ отправлен и null. */
const writableApartment = async (req: AuthenticatedRequest, res: Response) => {
  const id = parsePayrollDictionaryId(req);
  const current = id === null ? null : await getStay(id);
  if (id === null || !current || current.kind !== 'apartment') {
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
 * GET /api/payroll/housing-allowances[?months=…] — квартиры «штата зарплаты»: без months — живущие сегодня
 * (старый клиент), months=all — все с историей, список — задевающие эти месяцы.
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

/** POST /api/payroll/housing-allowances { employee_id, check_in, check_out?, amount, address? } — квартира. */
const add = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = payrollEmployeeIdSchema.parse((req.body as { employee_id?: unknown } | undefined)?.employee_id);
    const fields = parseStayFields('apartment', req.body);
    if (!(await canWritePayrollRegistryEmployee(req, employeeId))) {
      res.status(403).json(NO_ACCESS);
      return;
    }
    const stay = await addStay(employeeId, { kind: 'apartment', ...fields });
    if (stay === 'overlap') {
      res.status(409).json(OVERLAP);
      return;
    }
    await auditService.logFromRequest(req, req.user.id, 'DORMITORY_STAY_ADDED', {
      entityType: 'employee_dormitory_stays',
      entityId: String(stay.id),
      details: { source: AUDIT_SOURCE, ...dormitoryStayAuditDetails(stay) },
    });
    res.json({ success: true, data: stay });
  } catch (err) {
    if (handleWriteError(err, res)) return;
    console.error('payrollHousing.add error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения доплаты' });
  }
};

/** PATCH /api/payroll/housing-allowances/:id { check_in, check_out?, amount, address? } — сотрудник не меняется. */
const update = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const fields = parseStayFields('apartment', req.body);
    const target = await writableApartment(req, res);
    if (!target) return;
    const updated = await updateStay(target.id, fields);
    if (updated === null) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    if (updated === 'overlap') {
      res.status(409).json(OVERLAP);
      return;
    }
    const { before, after } = updated;
    if (dormitoryStayChanged(before, after)) {
      await auditService.logFromRequest(req, req.user.id, 'DORMITORY_STAY_UPDATED', {
        entityType: 'employee_dormitory_stays',
        entityId: String(target.id),
        details: { source: AUDIT_SOURCE, from: dormitoryStayAuditDetails(before), to: dormitoryStayAuditDetails(after) },
      });
    }
    res.json({ success: true, data: after });
  } catch (err) {
    if (handleWriteError(err, res)) return;
    console.error('payrollHousing.update error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения доплаты' });
  }
};

/** DELETE /api/payroll/housing-allowances/:id — удалить ошибочную запись (убрать с 1-го числа — PATCH выезда). */
const remove = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const target = await writableApartment(req, res);
    if (!target) return;
    const deleted = await deleteStay(target.id);
    if (!deleted) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    await auditService.logFromRequest(req, req.user.id, 'DORMITORY_STAY_DELETED', {
      entityType: 'employee_dormitory_stays',
      entityId: String(target.id),
      details: { source: AUDIT_SOURCE, ...dormitoryStayAuditDetails(deleted) },
    });
    res.json({ success: true, data: deleted });
  } catch (err) {
    console.error('payrollHousing.remove error:', err);
    res.status(500).json({ success: false, error: 'Ошибка удаления доплаты' });
  }
};

export const payrollHousingController = { list, add, update, remove };
