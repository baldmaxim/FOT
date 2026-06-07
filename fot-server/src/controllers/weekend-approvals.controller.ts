import type { Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../types/index.js';
import {
  listActiveByResponsible,
  loadAssignmentMaps,
  setTargetsForResponsible,
  listEligibleTargetEmployees,
} from '../services/weekend-approval-assignments.service.js';
import { AUDIT_ACTIONS, auditService } from '../services/audit.service.js';

const setSchema = z.object({
  department_ids: z.array(z.string().uuid()).default([]),
  employee_ids: z.array(z.number().int().positive()).default([]),
});

export const weekendApprovalsController = {
  /**
   * GET /api/admin/weekend-approvals/:responsibleId
   * Активные таргеты ответственного + карта всех назначений (для подсветки
   * «уже назначен другому»).
   */
  async getByResponsible(req: AuthenticatedRequest, res: Response) {
    try {
      const responsibleId = Number.parseInt(String(req.params.responsibleId), 10);
      if (!Number.isInteger(responsibleId) || responsibleId <= 0) {
        return res.status(400).json({ success: false, error: 'responsibleId обязателен' });
      }
      const [own, maps] = await Promise.all([
        listActiveByResponsible(responsibleId),
        loadAssignmentMaps(),
      ]);
      return res.json({
        success: true,
        data: {
          department_ids: own.department_ids,
          employee_ids: own.employee_ids,
          assignments: {
            departments: Object.fromEntries(maps.byDepartment),
            employees: Object.fromEntries([...maps.byEmployee].map(([k, v]) => [String(k), v])),
          },
        },
      });
    } catch (err) {
      console.error('weekendApprovals.getByResponsible error:', err);
      return res.status(500).json({ success: false, error: 'Ошибка загрузки назначений' });
    }
  },

  /**
   * PUT /api/admin/weekend-approvals/:responsibleId
   * Полная замена активных таргетов ответственного.
   */
  async setByResponsible(req: AuthenticatedRequest, res: Response) {
    try {
      const responsibleId = Number.parseInt(String(req.params.responsibleId), 10);
      if (!Number.isInteger(responsibleId) || responsibleId <= 0) {
        return res.status(400).json({ success: false, error: 'responsibleId обязателен' });
      }
      const parsed = setSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: 'Некорректные данные', details: parsed.error.flatten() });
      }
      const result = await setTargetsForResponsible({
        responsibleEmployeeId: responsibleId,
        departmentIds: parsed.data.department_ids,
        employeeIds: parsed.data.employee_ids,
        actorUserId: req.user.id,
      });
      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.WEEKEND_APPROVAL_TARGETS_SET, {
        entityType: 'weekend_approval_assignment',
        entityId: String(responsibleId),
        details: {
          department_ids: parsed.data.department_ids,
          employee_ids: parsed.data.employee_ids,
          conflicts: result.conflicts,
        },
      });
      return res.json({ success: true, data: { conflicts: result.conflicts } });
    } catch (err) {
      console.error('weekendApprovals.setByResponsible error:', err);
      return res.status(500).json({ success: false, error: 'Ошибка сохранения назначений' });
    }
  },

  /**
   * GET /api/admin/weekend-approvals/eligible?unassigned=1
   * Сотрудники подходящих ролей в whitelist-отделах. unassigned=1 → «Свободные».
   */
  async listEligible(req: AuthenticatedRequest, res: Response) {
    try {
      const onlyUnassigned = req.query.unassigned === '1';
      const data = await listEligibleTargetEmployees(onlyUnassigned);
      return res.json({ success: true, data });
    } catch (err) {
      console.error('weekendApprovals.listEligible error:', err);
      return res.status(500).json({ success: false, error: 'Ошибка загрузки сотрудников' });
    }
  },
};
