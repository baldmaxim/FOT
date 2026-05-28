/**
 * Датированная привязка УДАЛЁНЩИКА к объекту (employee_object_attribution).
 * Управляется из «Управления кадрами» (/staff-control), охват — только remote.
 * См. services/employee-object-attribution.service.ts и миграцию 138.
 */
import { z } from 'zod';
import type { Response } from 'express';
import { query, queryOne } from '../config/postgres.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { canAccessEmployeeInScope } from '../services/data-scope.service.js';
import { auditService } from '../services/audit.service.js';
import { invalidateCaches } from '../middleware/cacheResponse.js';
import { resolveSchedule } from '../services/schedule.service.js';
import {
  getCurrentAttributionForEmployee,
  listAttributionHistoryForEmployee,
  setAttributionForEmployee,
} from '../services/employee-object-attribution.service.js';

const setAttributionSchema = z.object({
  skud_object_id: z.string().uuid({ message: 'Некорректный объект' }),
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Некорректная дата'),
  reason: z.string().trim().max(500).optional().nullable(),
});

function invalidateTimesheetCaches(): void {
  invalidateCaches(
    'timesheet',
    'timesheet:today',
    'timesheet:overview',
    'timesheet:overview:today',
    'timesheet:search',
  );
}

export const employeeObjectAttributionController = {
  /** GET /api/employees/:id/object-attribution — текущая привязка + история. */
  async get(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const employeeId = z.coerce.number().int().positive().parse(req.params.id);

      const employee = await queryOne<{ id: number }>('SELECT id FROM employees WHERE id = $1', [employeeId]);
      if (!employee) {
        res.status(404).json({ success: false, error: 'Сотрудник не найден' });
        return;
      }
      if (!(await canAccessEmployeeInScope(req, employeeId))) {
        res.status(403).json({ success: false, error: 'Сотрудник вне вашей зоны доступа' });
        return;
      }

      const [current, history] = await Promise.all([
        getCurrentAttributionForEmployee(employeeId),
        listAttributionHistoryForEmployee(employeeId),
      ]);
      res.json({ success: true, data: { current, history } });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Get employee object-attribution error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить привязку к объекту' });
    }
  },

  /** PUT /api/employees/:id/object-attribution — задать новую привязку (только remote). */
  async set(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const employeeId = z.coerce.number().int().positive().parse(req.params.id);
      const { skud_object_id, effective_from, reason } = setAttributionSchema.parse(req.body);

      const employee = await queryOne<{ id: number; full_name: string | null }>(
        'SELECT id, full_name FROM employees WHERE id = $1',
        [employeeId],
      );
      if (!employee) {
        res.status(404).json({ success: false, error: 'Сотрудник не найден' });
        return;
      }
      if (!(await canAccessEmployeeInScope(req, employeeId))) {
        res.status(403).json({ success: false, error: 'Сотрудник вне вашей зоны доступа' });
        return;
      }

      // Охват — только удалёнка: привязка имеет смысл лишь для сотрудника без СКУД.
      const schedule = await resolveSchedule(employeeId, null, effective_from);
      if (schedule.schedule_type !== 'remote') {
        res.status(422).json({
          success: false,
          error: 'Привязка к объекту доступна только для режима «удалёнка»',
        });
        return;
      }

      const object = await queryOne<{ id: string; name: string }>(
        'SELECT id, name FROM skud_objects WHERE id = $1::uuid AND is_active = true',
        [skud_object_id],
      );
      if (!object) {
        res.status(400).json({ success: false, error: 'Объект не найден' });
        return;
      }

      await setAttributionForEmployee({
        employeeId,
        skudObjectId: skud_object_id,
        effectiveFrom: effective_from,
        reason: reason ?? null,
        actorUserId: req.user.id,
      });

      await auditService.logFromRequest(req, req.user.id, 'EMPLOYEE_OBJECT_ATTRIBUTION_CHANGED', {
        entityType: 'employee',
        entityId: String(employeeId),
        details: {
          employee_id: employeeId,
          employee_full_name: employee.full_name,
          skud_object_id,
          object_name: object.name,
          effective_from,
        },
      });

      invalidateTimesheetCaches();

      const [current, history] = await Promise.all([
        getCurrentAttributionForEmployee(employeeId),
        listAttributionHistoryForEmployee(employeeId),
      ]);
      res.json({ success: true, data: { current, history } });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      // Нарушение запрета пересечений периодов (триггер БД) или уникальности.
      const pgCode = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code || '')
        : '';
      if (pgCode === '23505' || (error instanceof Error && /Overlapping/.test(error.message))) {
        res.status(409).json({ success: false, error: 'Период привязки пересекается с существующим' });
        return;
      }
      console.error('Set employee object-attribution error:', error);
      res.status(500).json({ success: false, error: 'Не удалось сохранить привязку к объекту' });
    }
  },

  /** GET /api/employees/object-attribution/objects — активные объекты для выбора. */
  async listObjects(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const rows = await query<{ id: string; name: string }>(
        'SELECT id, name FROM skud_objects WHERE is_active = true ORDER BY name',
      );
      res.json({ success: true, data: rows });
    } catch (error) {
      console.error('List skud-objects for attribution error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить объекты' });
    }
  },
};
