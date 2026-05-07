import { Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../types/index.js';
import {
  assignDirectReport,
  listDirectReports,
  unassignDirectReportById,
} from '../services/employee-direct-reports.service.js';
import { AUDIT_ACTIONS, auditService } from '../services/audit.service.js';

const assignSchema = z.object({
  manager_employee_id: z.number().int().positive(),
  subordinate_employee_id: z.number().int().positive(),
  note: z.string().max(500).nullable().optional(),
});

export const directReportsController = {
  /** GET /api/direct-reports?manager_employee_id=X&include_inactive=1 */
  async list(req: AuthenticatedRequest, res: Response) {
    try {
      const managerParam = typeof req.query.manager_employee_id === 'string'
        ? Number.parseInt(req.query.manager_employee_id, 10)
        : null;
      const includeInactive = req.query.include_inactive === '1';

      let managerEmployeeId: number | undefined;
      if (req.user.is_admin) {
        if (managerParam && Number.isFinite(managerParam) && managerParam > 0) {
          managerEmployeeId = managerParam;
        }
      } else {
        if (!req.user.employee_id) {
          return res.status(403).json({ success: false, error: 'Employee profile is required' });
        }
        managerEmployeeId = req.user.employee_id;
      }

      const data = await listDirectReports({
        managerEmployeeId,
        includeInactive: req.user.is_admin ? includeInactive : false,
      });
      return res.json({ success: true, data });
    } catch (err) {
      console.error('directReports.list error:', err);
      return res.status(500).json({ success: false, error: 'Ошибка загрузки прямых подчинённых' });
    }
  },

  /** POST /api/direct-reports — admin-only */
  async assign(req: AuthenticatedRequest, res: Response) {
    try {
      const parsed = assignSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: 'Некорректные данные', details: parsed.error.flatten() });
      }
      const { manager_employee_id, subordinate_employee_id, note } = parsed.data;
      const result = await assignDirectReport({
        managerEmployeeId: manager_employee_id,
        subordinateEmployeeId: subordinate_employee_id,
        assignedBy: req.user.id,
        note: note ?? null,
      });
      if (result.ok) {
        await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.DIRECT_REPORT_ASSIGN, {
          entityType: 'employee_direct_report',
          entityId: String(result.row.id),
          details: { manager_employee_id, subordinate_employee_id, note: note ?? null },
        });
        return res.status(201).json({ success: true, data: result.row });
      }
      if (result.reason === 'already_assigned') {
        return res.status(409).json({
          success: false,
          error: 'Сотрудник уже назначен другому руководителю',
          existing_manager_employee_id: result.existingManagerEmployeeId,
        });
      }
      if (result.reason === 'self_report') {
        return res.status(400).json({ success: false, error: 'Сотрудник не может быть подчинённым самому себе' });
      }
      return res.status(404).json({ success: false, error: 'Сотрудник не найден' });
    } catch (err) {
      console.error('directReports.assign error:', err);
      return res.status(500).json({ success: false, error: 'Ошибка назначения' });
    }
  },

  /** DELETE /api/direct-reports/:id — admin-only */
  async unassign(req: AuthenticatedRequest, res: Response) {
    try {
      const id = String(req.params.id || '').trim();
      if (!id) {
        return res.status(400).json({ success: false, error: 'id обязателен' });
      }
      const ok = await unassignDirectReportById(id);
      if (!ok) {
        return res.status(404).json({ success: false, error: 'Назначение не найдено или уже снято' });
      }
      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.DIRECT_REPORT_UNASSIGN, {
        entityType: 'employee_direct_report',
        entityId: id,
      });
      return res.json({ success: true });
    } catch (err) {
      console.error('directReports.unassign error:', err);
      return res.status(500).json({ success: false, error: 'Ошибка снятия назначения' });
    }
  },
};
