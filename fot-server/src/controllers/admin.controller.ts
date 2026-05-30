import { Response } from 'express';
import { auditService } from '../services/audit.service.js';
import { adminUsersController } from './admin-users.controller.js';
import { admin2faController } from './admin-2fa.controller.js';
import { objectAssignmentController } from './object-assignment.controller.js';
import type { AuthenticatedRequest } from '../types/index.js';

export const adminController = {
  ...adminUsersController,
  ...admin2faController,
  ...objectAssignmentController,

  async getAuditLogs(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
      const offset = parseInt(req.query.offset as string) || 0;

      const { data, count } = await auditService.getAll(limit, offset);

      res.json({
        success: true,
        data,
        pagination: {
          limit,
          offset,
          total: count,
        },
      });
    } catch (error) {
      console.error('Get audit logs error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch audit logs' });
    }
  },
};
