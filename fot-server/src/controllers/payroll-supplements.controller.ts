/**
 * «Доплата» — таблица окна «Справочник» на «Расчётах» (миграция 315): плановые и разовые доплаты.
 *
 * Плановая — та же, что «Плановые доплаты» окна сотрудника (журнал миграции 293): правка в таблице видна
 * в окне, и наоборот. Разовая — месяц, сумма и основание; вносится только здесь.
 */
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import { auditService } from '../services/audit.service.js';
import {
  canWritePayrollRegistryEmployee,
  resolvePayrollStaffScope,
} from '../services/payroll/payroll-registry-scope.service.js';
import { resolvePayrollEditPredicate } from '../services/payroll/payroll-scope.service.js';
import {
  addOneTimeSupplement,
  deleteOneTimeSupplement,
  getOneTimeSupplement,
  listSupplements,
  savePlannedSupplement,
  updateOneTimeSupplement,
  type IOneTimeSupplement,
} from '../services/payroll/payroll-supplements.service.js';
import type { IPlannedSupplementValue } from '../services/payroll/payroll-terms.service.js';
import {
  handlePayrollZodError,
  parsePayrollDictionaryId,
  parsePayrollEmployeeIdParam,
  payrollDateSchema,
  payrollEmployeeIdSchema,
  payrollMonthSchema,
  payrollPositiveMoneySchema,
  withCanEdit,
} from './payroll-dictionary.helpers.js';

const plannedFields = {
  amount: payrollPositiveMoneySchema('Укажите сумму доплаты'),
  date_from: payrollDateSchema('Укажите дату начала'),
  date_to: payrollDateSchema('Укажите дату окончания'),
};
const PLANNED_ORDER = { message: 'Дата окончания раньше даты начала', path: ['date_to'] };
const plannedOrder = (value: { date_from: string; date_to: string }): boolean => value.date_to >= value.date_from;

const plannedSchema = z.object(plannedFields).refine(plannedOrder, PLANNED_ORDER);
const plannedAddSchema = z.object({ employee_id: payrollEmployeeIdSchema, ...plannedFields })
  .refine(plannedOrder, PLANNED_ORDER);

const oneTimeFields = {
  month: payrollMonthSchema('Укажите месяц'),
  amount: payrollPositiveMoneySchema('Укажите сумму доплаты'),
  reason: z.string({ required_error: 'Укажите основание', invalid_type_error: 'Укажите основание' })
    .transform(value => value.replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(1, 'Укажите основание').max(200, 'Основание — не больше 200 символов')),
};
const oneTimeSchema = z.object(oneTimeFields);
const oneTimeAddSchema = z.object({ employee_id: payrollEmployeeIdSchema, ...oneTimeFields });

const NO_ACCESS = { success: false, error: 'Нет доступа к сотруднику' };
const NOT_FOUND = { success: false, error: 'Доплата не найдена' };
const EXISTS = {
  success: false,
  error: 'У сотрудника уже есть плановая доплата — измените её в таблице',
  code: 'SUPPLEMENT_EXISTS',
};

const toPlannedValue = (body: z.infer<typeof plannedSchema>): IPlannedSupplementValue => ({
  amount: body.amount,
  dateFrom: body.date_from,
  dateTo: body.date_to,
});

const plannedAudit = (value: IPlannedSupplementValue | null) => (value && {
  amount: value.amount,
  date_from: value.dateFrom,
  date_to: value.dateTo,
});

const oneTimeAudit = (row: IOneTimeSupplement) => ({
  employee_id: row.employee_id,
  full_name: row.full_name,
  month: row.month,
  amount: row.amount,
  reason: row.reason,
});

/** GET /api/payroll/supplements — плановые (текущие) и разовые доплаты «штата зарплаты». */
const list = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const [scope, canEdit] = await Promise.all([resolvePayrollStaffScope(req), resolvePayrollEditPredicate(req)]);
    res.json({ success: true, data: withCanEdit(await listSupplements(scope), canEdit) });
  } catch (err) {
    console.error('payrollSupplements.list error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения списка' });
  }
};

/** Записать плановую доплату и событие аудита; ответ — изменилась ли. */
const writePlanned = async (
  req: AuthenticatedRequest,
  res: Response,
  employeeId: number,
  value: IPlannedSupplementValue | null,
  onlyIfNone: boolean,
): Promise<void> => {
  if (!(await canWritePayrollRegistryEmployee(req, employeeId))) {
    res.status(403).json(NO_ACCESS);
    return;
  }
  const result = await savePlannedSupplement({ employeeId, value, createdBy: req.user.id, onlyIfNone });
  if (result.status === 'exists') {
    res.status(409).json(EXISTS);
    return;
  }
  if (result.status === 'saved') {
    await auditService.logFromRequest(req, req.user.id, 'PAYROLL_PLANNED_SUPPLEMENT_SET', {
      entityType: 'payroll_planned_supplements',
      entityId: String(employeeId),
      details: {
        source: 'supplement_registry',
        employee_id: employeeId,
        planned_supplement: plannedAudit(value),
        previous: plannedAudit(result.previous),
      },
    });
  }
  res.json({ success: true, data: { changed: result.status === 'saved' } });
};

/** POST /api/payroll/supplements/planned { employee_id, amount, date_from, date_to } — добавить. */
const addPlanned = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { employee_id: employeeId, ...body } = plannedAddSchema.parse(req.body);
    await writePlanned(req, res, employeeId, toPlannedValue(body), true);
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('payrollSupplements.addPlanned error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения доплаты' });
  }
};

/** PUT /api/payroll/supplements/planned/employee/:empId { amount, date_from, date_to } — изменить. */
const setPlanned = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = parsePayrollEmployeeIdParam(req);
    if (employeeId === null) {
      res.status(403).json(NO_ACCESS);
      return;
    }
    await writePlanned(req, res, employeeId, toPlannedValue(plannedSchema.parse(req.body)), false);
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('payrollSupplements.setPlanned error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения доплаты' });
  }
};

/** DELETE /api/payroll/supplements/planned/employee/:empId — снять плановую доплату. */
const removePlanned = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = parsePayrollEmployeeIdParam(req);
    if (employeeId === null) {
      res.status(403).json(NO_ACCESS);
      return;
    }
    await writePlanned(req, res, employeeId, null, false);
  } catch (err) {
    console.error('payrollSupplements.removePlanned error:', err);
    res.status(500).json({ success: false, error: 'Ошибка снятия доплаты' });
  }
};

/** POST /api/payroll/supplements/one-time { employee_id, month, amount, reason } — разовая доплата. */
const addOneTime = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { employee_id: employeeId, ...input } = oneTimeAddSchema.parse(req.body);
    if (!(await canWritePayrollRegistryEmployee(req, employeeId))) {
      res.status(403).json(NO_ACCESS);
      return;
    }
    const created = await addOneTimeSupplement(employeeId, input);
    await auditService.logFromRequest(req, req.user.id, 'PAYROLL_ONE_TIME_SUPPLEMENT_ADDED', {
      entityType: 'payroll_one_time_supplements',
      entityId: String(created.id),
      details: oneTimeAudit(created),
    });
    res.json({ success: true, data: created });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('payrollSupplements.addOneTime error:', err);
    res.status(500).json({ success: false, error: 'Ошибка добавления доплаты' });
  }
};

/** PATCH /api/payroll/supplements/one-time/:id { month, amount, reason } — сотрудник не меняется. */
const updateOneTime = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parsePayrollDictionaryId(req);
    const current = id === null ? null : await getOneTimeSupplement(id);
    if (id === null || !current) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    const input = oneTimeSchema.parse(req.body);
    if (!(await canWritePayrollRegistryEmployee(req, current.employee_id))) {
      res.status(403).json(NO_ACCESS);
      return;
    }
    const updated = await updateOneTimeSupplement(id, input);
    if (!updated) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    const { before, after } = updated;
    if (before.month !== after.month || before.amount !== after.amount || before.reason !== after.reason) {
      await auditService.logFromRequest(req, req.user.id, 'PAYROLL_ONE_TIME_SUPPLEMENT_UPDATED', {
        entityType: 'payroll_one_time_supplements',
        entityId: String(id),
        details: { from: oneTimeAudit(before), to: oneTimeAudit(after) },
      });
    }
    res.json({ success: true, data: after });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('payrollSupplements.updateOneTime error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения доплаты' });
  }
};

/** DELETE /api/payroll/supplements/one-time/:id — удалить разовую доплату. */
const removeOneTime = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parsePayrollDictionaryId(req);
    const current = id === null ? null : await getOneTimeSupplement(id);
    if (id === null || !current) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    if (!(await canWritePayrollRegistryEmployee(req, current.employee_id))) {
      res.status(403).json(NO_ACCESS);
      return;
    }
    const deleted = await deleteOneTimeSupplement(id);
    if (!deleted) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    await auditService.logFromRequest(req, req.user.id, 'PAYROLL_ONE_TIME_SUPPLEMENT_DELETED', {
      entityType: 'payroll_one_time_supplements',
      entityId: String(id),
      details: oneTimeAudit(deleted),
    });
    res.json({ success: true, data: deleted });
  } catch (err) {
    console.error('payrollSupplements.removeOneTime error:', err);
    res.status(500).json({ success: false, error: 'Ошибка удаления доплаты' });
  }
};

export const payrollSupplementsController = {
  list,
  addPlanned,
  setPlanned,
  removePlanned,
  addOneTime,
  updateOneTime,
  removeOneTime,
};
