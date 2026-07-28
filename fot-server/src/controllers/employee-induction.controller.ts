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
import {
  OT_EMPLOYEE_KINDS,
  otTrainingsFor,
  type OtTrainingKind,
} from '../services/ot-training.service.js';
import {
  listEmployeeTrainings,
  setEmployeeTraining,
  EmployeeOtTrainingError,
  OT_NOTE_MAX_LENGTH,
} from '../services/employee-ot-training.service.js';

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(100),
  department_id: z.string().uuid().optional(),
  status: z.enum(['all', 'missing', 'passed']).default('all'),
  search: z.string().trim().max(100).optional(),
});

// Патч частичный: переданное поле правим, остальные сохраняются как есть. Старое тело
// { inducted_on } продолжает работать — фронт мог остаться от предыдущего релиза.
const setDateSchema = z.object({
  inducted_on: z.string().date('Некорректная дата').nullable().optional(),
  program_a_on: z.string().date('Некорректная дата').nullable().optional(),
}).refine(
  v => v.inducted_on !== undefined || v.program_a_on !== undefined,
  'Нечего сохранять',
);

const employeeIdSchema = z.coerce.number().int().positive();

/**
 * Патч одного вида обучения. Отсутствие поля — «не менять», null — очистить:
 * профессия сохраняется отдельным запросом по уходу фокуса и не должна стирать дату.
 */
const trainingPatchSchema = z.object({
  kind: z.enum(OT_EMPLOYEE_KINDS as [OtTrainingKind, ...OtTrainingKind[]]),
  passed_on: z.string().date('Некорректная дата').nullable().optional(),
  note: z.string().trim().max(OT_NOTE_MAX_LENGTH, 'Слишком длинное значение').nullable().optional(),
}).refine(
  v => v.passed_on !== undefined || v.note !== undefined,
  'Нечего сохранять',
);

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
   * Body: { inducted_on?: 'YYYY-MM-DD' | null, program_a_on?: 'YYYY-MM-DD' | null }.
   */
  async setDate(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const employeeId = z.coerce.number().int().positive().parse(req.params.id);
      const patch = setDateSchema.parse(req.body);

      const today = moscowTodayIso();
      const future = [patch.inducted_on, patch.program_a_on].some(v => !!v && v > today);
      if (future) {
        res.status(400).json({ success: false, error: 'Дата обучения не может быть в будущем' });
        return;
      }

      const scopeIds = await resolveInductionScopeIds(req);
      const result = await setInduction({
        employeeId,
        patch,
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
          details: { current: result.current, previous: result.previous },
        });
      }

      res.json({
        success: true,
        data: {
          employee_id: employeeId,
          inducted_on: result.current.inducted_on,
          program_a_on: result.current.program_a_on,
          changed: result.changed,
        },
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

  /** GET /api/employees/induction/catalog — виды обучения для своих сотрудников. */
  async trainingCatalog(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      res.json({ success: true, data: otTrainingsFor('employee') });
    } catch (error) {
      console.error('Induction catalog error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить виды обучения' });
    }
  },

  /** GET /api/employees/:id/induction/trainings — состояния всех видов обучения сотрудника. */
  async trainings(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const employeeId = employeeIdSchema.parse(req.params.id);
      const scopeIds = await resolveInductionScopeIds(req);
      const data = await listEmployeeTrainings(employeeId, scopeIds, moscowTodayIso());

      // Уволенный/архивный/чужой — одинаковый 404: не раскрываем факт существования.
      if (!data) {
        res.status(404).json({ success: false, error: 'Сотрудник не найден' });
        return;
      }
      res.json({ success: true, data });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Induction trainings error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить обучение' });
    }
  },

  /**
   * PATCH /api/employees/:id/induction/trainings — дата и/или профессия по одному виду.
   * Body: { kind, passed_on?: 'YYYY-MM-DD' | null, note?: string | null }.
   */
  async setTraining(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const employeeId = employeeIdSchema.parse(req.params.id);
      const body = trainingPatchSchema.parse(req.body);

      if (body.passed_on && body.passed_on > moscowTodayIso()) {
        res.status(400).json({ success: false, error: 'Дата обучения не может быть в будущем' });
        return;
      }

      const scopeIds = await resolveInductionScopeIds(req);
      const result = await setEmployeeTraining({
        employeeId,
        kind: body.kind,
        passedOn: body.passed_on,
        note: body.note,
        userId: req.user.id,
        scopeIds,
      });

      if (!result.found) {
        res.status(404).json({ success: false, error: 'Сотрудник не найден' });
        return;
      }

      if (result.changed) {
        await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.EMPLOYEE_INDUCTION_CHANGED, {
          entityType: 'employee',
          entityId: String(employeeId),
          details: { changed: { [body.kind]: result.diff } },
        });
      }

      const data = await listEmployeeTrainings(employeeId, scopeIds, moscowTodayIso());
      res.json({ success: true, data: data ?? [], changed: result.changed });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      if (error instanceof EmployeeOtTrainingError) {
        res.status(400).json({ success: false, error: error.message });
        return;
      }
      console.error('Induction setTraining error:', error);
      res.status(500).json({ success: false, error: 'Не удалось сохранить обучение' });
    }
  },
};
