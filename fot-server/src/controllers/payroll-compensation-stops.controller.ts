/**
 * «Не выплачивать» — таблица окна «Справочник» на «Расчётах» (миграция 315): кому не выплачивать
 * компенсацию, период «с — по». Возобновили выплату — ставят «по»; удаляют только ошибочную строку.
 * Пока это список: в расчёт (его ещё нет) не подставляется.
 */
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import { auditService } from '../services/audit.service.js';
import {
  addCompensationStop,
  deleteCompensationStop,
  getCompensationStop,
  listCompensationStops,
  updateCompensationStop,
  type ICompensationStop,
} from '../services/payroll/payroll-compensation-stops.service.js';
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

const stopFields = {
  date_from: payrollDateSchema('Укажите дату «Не выплачивать с»'),
  date_to: payrollDateSchema('Неверная дата «по»').nullable().optional().transform(value => value ?? null),
};
/** «По» включительно: один день (с = по) — допустимый период. */
const datesInOrder = (value: { date_from: string; date_to: string | null }): boolean =>
  value.date_to === null || value.date_to >= value.date_from;
const DATES_ORDER = { message: 'Дата «по» раньше даты «с»', path: ['date_to'] };

const addSchema = z.object({ employee_id: payrollEmployeeIdSchema, ...stopFields }).refine(datesInOrder, DATES_ORDER);
const updateSchema = z.object(stopFields).refine(datesInOrder, DATES_ORDER);

const NO_ACCESS = { success: false, error: 'Нет доступа к сотруднику' };
const NOT_FOUND = { success: false, error: 'Запись не найдена' };
const OVERLAP = {
  success: false,
  error: 'У сотрудника уже есть период «Не выплачивать» в эти даты',
  code: 'STOP_OVERLAP',
};

const auditDetails = (stop: ICompensationStop) => ({
  employee_id: stop.employee_id,
  full_name: stop.full_name,
  date_from: stop.date_from,
  date_to: stop.date_to,
});

/** GET /api/payroll/compensation-stops — все периоды (история) «штата зарплаты». */
const list = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const [scope, canEdit] = await Promise.all([resolvePayrollStaffScope(req), resolvePayrollEditPredicate(req)]);
    res.json({ success: true, data: withCanEdit(await listCompensationStops(scope), canEdit) });
  } catch (err) {
    console.error('payrollCompensationStops.list error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения списка' });
  }
};

/** POST /api/payroll/compensation-stops { employee_id, date_from, date_to? } — добавить период. */
const add = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { employee_id: employeeId, ...input } = addSchema.parse(req.body);
    if (!(await canWritePayrollRegistryEmployee(req, employeeId))) {
      res.status(403).json(NO_ACCESS);
      return;
    }
    const stop = await addCompensationStop(employeeId, input);
    if (stop === 'overlap') {
      res.status(409).json(OVERLAP);
      return;
    }
    await auditService.logFromRequest(req, req.user.id, 'PAYROLL_COMPENSATION_STOP_ADDED', {
      entityType: 'payroll_compensation_stops',
      entityId: String(stop.id),
      details: auditDetails(stop),
    });
    res.json({ success: true, data: stop });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('payrollCompensationStops.add error:', err);
    res.status(500).json({ success: false, error: 'Ошибка добавления' });
  }
};

/** PATCH /api/payroll/compensation-stops/:id { date_from, date_to? } — даты; сотрудник не меняется. */
const update = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parsePayrollDictionaryId(req);
    const current = id === null ? null : await getCompensationStop(id);
    if (id === null || !current) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    const input = updateSchema.parse(req.body);
    if (!(await canWritePayrollRegistryEmployee(req, current.employee_id))) {
      res.status(403).json(NO_ACCESS);
      return;
    }
    const updated = await updateCompensationStop(id, input);
    if (updated === null) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    if (updated === 'overlap') {
      res.status(409).json(OVERLAP);
      return;
    }
    const { before, after } = updated;
    if (before.date_from !== after.date_from || before.date_to !== after.date_to) {
      await auditService.logFromRequest(req, req.user.id, 'PAYROLL_COMPENSATION_STOP_UPDATED', {
        entityType: 'payroll_compensation_stops',
        entityId: String(id),
        details: { from: auditDetails(before), to: auditDetails(after) },
      });
    }
    res.json({ success: true, data: after });
  } catch (err) {
    if (handlePayrollZodError(err, res)) return;
    console.error('payrollCompensationStops.update error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения' });
  }
};

/** DELETE /api/payroll/compensation-stops/:id — удалить ошибочный период. */
const remove = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = parsePayrollDictionaryId(req);
    const current = id === null ? null : await getCompensationStop(id);
    if (id === null || !current) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    if (!(await canWritePayrollRegistryEmployee(req, current.employee_id))) {
      res.status(403).json(NO_ACCESS);
      return;
    }
    const deleted = await deleteCompensationStop(id);
    if (!deleted) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    await auditService.logFromRequest(req, req.user.id, 'PAYROLL_COMPENSATION_STOP_DELETED', {
      entityType: 'payroll_compensation_stops',
      entityId: String(id),
      details: auditDetails(deleted),
    });
    res.json({ success: true, data: deleted });
  } catch (err) {
    console.error('payrollCompensationStops.remove error:', err);
    res.status(500).json({ success: false, error: 'Ошибка удаления' });
  }
};

export const payrollCompensationStopsController = { list, add, update, remove };
