/**
 * Окно «Режим табелирования» в «Управлении кадрами» (миграция 291): «Офис» отделу,
 * сотруднику — «Офис» или объект. Право — /staff-control/timesheet-office (admin, hr_admin); логика —
 * timesheet-office.service.ts (запись) и timesheet-office-read.service.ts (чтение).
 */
import { z } from 'zod';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';
import {
  TIMESHEET_OFFICE_BATCH_LIMIT,
  TimesheetOfficeError,
  updateTimesheetOffice,
} from '../services/timesheet-office.service.js';
import {
  getTimesheetOfficeDepartmentMembers,
  getTimesheetOfficeEmployee,
  getTimesheetOfficeState,
  searchTimesheetOfficeEmployees,
} from '../services/timesheet-office-read.service.js';

const idList = <T extends z.ZodTypeAny>(item: T) => z.array(item).max(TIMESHEET_OFFICE_BATCH_LIMIT).default([]);

const updateSchema = z.object({
  departments: z.object({
    add: idList(z.string().uuid()),
    remove: idList(z.string().uuid()),
  }).default({ add: [], remove: [] }),
  employees: z.object({
    add: idList(z.number().int().positive()),
    remove: idList(z.number().int().positive()),
    objects: idList(z.object({ id: z.number().int().positive(), object_id: z.string().uuid() })),
  }).default({ add: [], remove: [], objects: [] }),
});

const searchSchema = z.object({
  search: z.string().trim().max(64).default(''),
});

const departmentParamsSchema = z.object({
  id: z.string().uuid(),
});

const employeeParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

function handleError(res: Response, err: unknown, context: string): void {
  if (err instanceof TimesheetOfficeError) {
    res.status(err.status).json({ success: false, code: err.code, error: err.message, details: err.details });
    return;
  }
  console.error(`timesheetOffice.${context} error:`, err);
  res.status(500).json({ success: false, error: 'Не удалось обработать режим табелирования' });
}

export const timesheetOfficeController = {
  /** GET /api/admin/timesheet-office */
  async getState(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      res.json({ success: true, data: await getTimesheetOfficeState(req) });
    } catch (err) {
      handleError(res, err, 'getState');
    }
  },

  /** GET /api/admin/timesheet-office/employees?search= */
  async searchEmployees(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = searchSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Некорректный поиск', details: parsed.error.issues });
      return;
    }
    try {
      res.json({ success: true, data: await searchTimesheetOfficeEmployees(req, parsed.data.search) });
    } catch (err) {
      handleError(res, err, 'searchEmployees');
    }
  },

  /** GET /api/admin/timesheet-office/departments/:id/employees */
  async getDepartmentMembers(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = departmentParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Некорректный id отдела', details: parsed.error.issues });
      return;
    }
    try {
      res.json({ success: true, data: await getTimesheetOfficeDepartmentMembers(req, parsed.data.id) });
    } catch (err) {
      handleError(res, err, 'getDepartmentMembers');
    }
  },

  /** GET /api/admin/timesheet-office/employees/:id */
  async getEmployee(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = employeeParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Некорректный id сотрудника', details: parsed.error.issues });
      return;
    }
    try {
      res.json({ success: true, data: await getTimesheetOfficeEmployee(req, parsed.data.id) });
    } catch (err) {
      handleError(res, err, 'getEmployee');
    }
  },

  /** PUT /api/admin/timesheet-office { departments: { add, remove }, employees: { add, remove, objects } } */
  async update(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Некорректные данные', details: parsed.error.issues });
      return;
    }
    try {
      const result = await updateTimesheetOffice(req, parsed.data);
      res.json({ success: true, changed: result.changed, data: result });
    } catch (err) {
      handleError(res, err, 'update');
    }
  },
};
