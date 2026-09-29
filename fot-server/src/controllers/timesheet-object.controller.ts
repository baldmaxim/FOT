/**
 * Объект табелирования: выбор сотрудником (ЛК) и тем, кто ведёт его табель (миграция 288).
 */
import { z } from 'zod';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';
import { canEditEmployeeTimesheetInScope } from '../services/data-scope.service.js';
import {
  TimesheetObjectError,
  getTimesheetObjectState,
  setTimesheetObject,
  type TimesheetObjectActor,
} from '../services/employee-timesheet-object-choice.service.js';

const bodySchema = z.object({
  value: z.string().trim().min(1).max(64),
});

function handleError(res: Response, err: unknown, context: string): void {
  if (err instanceof TimesheetObjectError) {
    res.status(err.status).json({ success: false, code: err.code, error: err.message });
    return;
  }
  console.error(`timesheetObject.${context} error:`, err);
  res.status(500).json({ success: false, error: 'Не удалось обработать объект табелирования' });
}

function parseEmployeeId(raw: unknown): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Для себя — всегда как сотрудник: только в окне последних 3 дней. */
const actorFor = (req: AuthenticatedRequest, employeeId: number): TimesheetObjectActor =>
  req.user.employee_id === employeeId ? 'employee' : 'manager';

export const timesheetObjectController = {
  /** GET /api/timesheet-object/me */
  async getMine(req: AuthenticatedRequest, res: Response): Promise<void> {
    const employeeId = req.user.employee_id;
    if (!employeeId) {
      res.status(400).json({ success: false, error: 'Учётная запись не привязана к сотруднику' });
      return;
    }
    try {
      res.json({ success: true, data: await getTimesheetObjectState(employeeId, 'employee') });
    } catch (err) {
      handleError(res, err, 'getMine');
    }
  },

  /** PUT /api/timesheet-object/me { value } */
  async updateMine(req: AuthenticatedRequest, res: Response): Promise<void> {
    const employeeId = req.user.employee_id;
    if (!employeeId) {
      res.status(400).json({ success: false, error: 'Учётная запись не привязана к сотруднику' });
      return;
    }
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Некорректные данные', details: parsed.error.issues });
      return;
    }
    try {
      const result = await setTimesheetObject(req, employeeId, parsed.data.value, 'employee');
      res.json({ success: true, changed: result.changed, data: result.state });
    } catch (err) {
      handleError(res, err, 'updateMine');
    }
  },

  /** GET /api/timesheet-object/employees/:id — для того, кто ведёт табель сотрудника. */
  async getForEmployee(req: AuthenticatedRequest, res: Response): Promise<void> {
    const employeeId = parseEmployeeId(req.params.id);
    if (!employeeId) {
      res.status(400).json({ success: false, error: 'Некорректный id сотрудника' });
      return;
    }
    try {
      if (!(await canEditEmployeeTimesheetInScope(req, employeeId))) {
        res.status(403).json({ success: false, error: 'Нет доступа к табелю сотрудника' });
        return;
      }
      res.json({ success: true, data: await getTimesheetObjectState(employeeId, actorFor(req, employeeId)) });
    } catch (err) {
      handleError(res, err, 'getForEmployee');
    }
  },

  /** PUT /api/timesheet-object/employees/:id { value } */
  async updateForEmployee(req: AuthenticatedRequest, res: Response): Promise<void> {
    const employeeId = parseEmployeeId(req.params.id);
    if (!employeeId) {
      res.status(400).json({ success: false, error: 'Некорректный id сотрудника' });
      return;
    }
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Некорректные данные', details: parsed.error.issues });
      return;
    }
    try {
      if (!(await canEditEmployeeTimesheetInScope(req, employeeId))) {
        res.status(403).json({ success: false, error: 'Нет доступа к табелю сотрудника' });
        return;
      }
      const result = await setTimesheetObject(req, employeeId, parsed.data.value, actorFor(req, employeeId));
      res.json({ success: true, changed: result.changed, data: result.state });
    } catch (err) {
      handleError(res, err, 'updateForEmployee');
    }
  },
};
