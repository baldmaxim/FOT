/**
 * Вкладка «Управление кадрами → Вводный инструктаж»: список своих сотрудников
 * (СУ-10 + Служба Механизации) с датой вводного инструктажа. Дату проставляет ОТиТБ.
 * Реестр — employee_inductions (миграция 231), логика в services/employee-induction.service.ts.
 */
import { z } from 'zod';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';
import { auditService, AUDIT_ACTIONS } from '../services/audit.service.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import {
  listInduction,
  listInductionDepartments,
  resolveInductionScopeIds,
  setInduction,
} from '../services/employee-induction.service.js';

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(100),
  department_id: z.string().uuid().optional(),
  status: z.enum(['all', 'missing', 'passed']).default('all'),
  search: z.string().trim().max(100).optional(),
});

const setDateSchema = z.object({
  inducted_on: z.string().date('Некорректная дата').nullable(),
});

export const employeeInductionController = {
  /** GET /api/employees/induction — список сотрудников с датой инструктажа. */
  async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const params = listQuerySchema.parse(req.query);
      const scopeIds = await resolveInductionScopeIds(req);

      const { rows, total, passed } = await listInduction({
        scopeIds,
        departmentId: params.department_id ?? null,
        search: params.search ?? null,
        status: params.status,
        page: params.page,
        pageSize: params.pageSize,
      });

      res.json({
        success: true,
        data: rows,
        meta: {
          page: params.page,
          pageSize: params.pageSize,
          total,
          totalPages: Math.ceil(total / params.pageSize),
          passed,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Induction list error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить список' });
    }
  },

  /** GET /api/employees/induction/departments — отделы селектора (в пределах скоупа). */
  async departments(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const scopeIds = await resolveInductionScopeIds(req);
      const data = await listInductionDepartments(scopeIds);
      res.json({ success: true, data });
    } catch (error) {
      console.error('Induction departments error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить отделы' });
    }
  },

  /**
   * PATCH /api/employees/:id/induction — проставить или снять дату.
   * Body: { inducted_on: 'YYYY-MM-DD' | null }.
   */
  async setDate(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const employeeId = z.coerce.number().int().positive().parse(req.params.id);
      const { inducted_on } = setDateSchema.parse(req.body);

      if (inducted_on !== null && inducted_on > moscowTodayIso()) {
        res.status(400).json({ success: false, error: 'Дата инструктажа не может быть в будущем' });
        return;
      }

      const scopeIds = await resolveInductionScopeIds(req);
      const result = await setInduction({
        employeeId,
        inductedOn: inducted_on,
        userId: req.user.id,
        scopeIds,
      });

      // Уволенный/архивный/чужой — одинаковый 404: не раскрываем сам факт существования.
      if (!result.found) {
        res.status(404).json({ success: false, error: 'Сотрудник не найден' });
        return;
      }

      if (result.changed) {
        await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.EMPLOYEE_INDUCTION_CHANGED, {
          entityType: 'employee',
          entityId: String(employeeId),
          details: { inducted_on: result.current, previous: result.previous },
        });
      }

      res.json({
        success: true,
        data: { employee_id: employeeId, inducted_on: result.current, changed: result.changed },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Induction setDate error:', error);
      res.status(500).json({ success: false, error: 'Не удалось сохранить дату инструктажа' });
    }
  },
};
