/**
 * «Доплата» — таблица окна «Справочник» на «Расчётах» (миграция 315): плановые и разовые доплаты.
 *
 * Плановая — та же, что «Плановые доплаты» окна сотрудника (журнал миграции 293): правка в таблице видна
 * в окне, и наоборот. Разовая — месяц, сумма и основание; вносится только здесь, с файлами (миграция 354) —
 * обработчики в payroll-one-time-supplements.controller.ts.
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
  getPlannedPeriodEmployeeId,
  listSupplements,
  rewritePlannedPeriod,
  savePlannedSupplement,
} from '../services/payroll/payroll-supplements.service.js';
import type { IPlannedSupplementValue } from '../services/payroll/payroll-terms.service.js';
import {
  handlePayrollZodError,
  parsePayrollDictionaryId,
  parsePayrollEmployeeIdParam,
  payrollDateSchema,
  payrollEmployeeIdSchema,
  payrollPositiveMoneySchema,
  withCanEdit,
} from './payroll-dictionary.helpers.js';
import { oneTimeSupplementHandlers } from './payroll-one-time-supplements.controller.js';

const plannedFields = {
  amount: payrollPositiveMoneySchema('Укажите сумму доплаты'),
  date_from: payrollDateSchema('Укажите дату начала'),
  // Пусто — бессрочно (миграция 322).
  date_to: payrollDateSchema('Такой даты нет').nullable().optional(),
};
const PLANNED_ORDER = { message: 'Дата окончания раньше даты начала', path: ['date_to'] };
const plannedOrder = (value: { date_from: string; date_to?: string | null }): boolean => (
  !value.date_to || value.date_to >= value.date_from
);

const plannedSchema = z.object(plannedFields).refine(plannedOrder, PLANNED_ORDER);
const plannedAddSchema = z.object({ employee_id: payrollEmployeeIdSchema, ...plannedFields })
  .refine(plannedOrder, PLANNED_ORDER);

const NO_ACCESS = { success: false, error: 'Нет доступа к сотруднику' };
const NOT_FOUND = { success: false, error: 'Доплата не найдена' };
const EXISTS = {
  success: false,
  error: 'У сотрудника уже есть плановая доплата в эти даты — измените её в таблице',
  code: 'SUPPLEMENT_EXISTS',
};
const STALE = {
  success: false,
  error: 'Доплата уже изменилась — обновите таблицу',
  code: 'SUPPLEMENT_STALE',
};

const toPlannedValue = (body: z.infer<typeof plannedSchema>): IPlannedSupplementValue => ({
  amount: body.amount,
  dateFrom: body.date_from,
  dateTo: body.date_to ?? null,
});

const plannedAudit = (value: IPlannedSupplementValue | null) => (value && {
  amount: value.amount,
  date_from: value.dateFrom,
  date_to: value.dateTo,
});

/** GET /api/payroll/supplements — плановые (текущие и прошлые периоды) и разовые доплаты «штата зарплаты». */
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

/**
 * Поправить (value) или снять (null) один период плановой доплаты по id строки журнала — любой, не только
 * последний (миграция 337). Аудит — тем же событием, что запись по сотруднику, с period_id.
 */
const writePlannedPeriod = async (
  req: AuthenticatedRequest,
  res: Response,
  periodId: number | null,
  value: IPlannedSupplementValue | null,
): Promise<void> => {
  const employeeId = periodId === null ? null : await getPlannedPeriodEmployeeId(periodId);
  if (periodId === null || employeeId === null) {
    res.status(404).json(NOT_FOUND);
    return;
  }
  if (!(await canWritePayrollRegistryEmployee(req, employeeId))) {
    res.status(403).json(NO_ACCESS);
    return;
  }
  const result = await rewritePlannedPeriod({ employeeId, periodId, value, createdBy: req.user.id });
  if (result.status === 'stale') {
    res.status(409).json(STALE);
    return;
  }
  if (result.status === 'exists') {
    res.status(409).json(EXISTS);
    return;
  }
  if (result.status === 'saved') {
    await auditService.logFromRequest(req, req.user.id, 'PAYROLL_PLANNED_SUPPLEMENT_SET', {
      entityType: 'payroll_planned_supplements',
      entityId: String(employeeId),
      details: {
        source: 'supplement_registry_period',
        employee_id: employeeId,
        period_id: periodId,
        planned_supplement: plannedAudit(value),
        previous: plannedAudit(result.previous),
      },
    });
  }
  res.json({ success: true, data: { changed: result.status === 'saved' } });
};

/** PUT /api/payroll/supplements/planned/:id { amount, date_from, date_to } — изменить период. */
const updatePlannedPeriod = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const value = toPlannedValue(plannedSchema.parse(req.body));
    await writePlannedPeriod(req, res, parsePayrollDictionaryId(req), value);
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('payrollSupplements.updatePlannedPeriod error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения доплаты' });
  }
};

/** DELETE /api/payroll/supplements/planned/:id — снять период. */
const removePlannedPeriod = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    await writePlannedPeriod(req, res, parsePayrollDictionaryId(req), null);
  } catch (err) {
    console.error('payrollSupplements.removePlannedPeriod error:', err);
    res.status(500).json({ success: false, error: 'Ошибка снятия доплаты' });
  }
};

export const payrollSupplementsController = {
  list,
  addPlanned,
  setPlanned,
  removePlanned,
  updatePlannedPeriod,
  removePlannedPeriod,
  ...oneTimeSupplementHandlers,
};
