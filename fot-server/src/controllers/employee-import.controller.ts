import { Response } from 'express';
import { supabase } from '../config/database.js';
import { auditService } from '../services/audit.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * DELETE /api/employees/all
 */
export async function deleteAll(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { count: beforeCount } = await supabase
      .from('employees')
      .select('*', { count: 'exact', head: true });

    const { error } = await supabase
      .from('employees')
      .delete()
      .neq('id', 0);

    if (error) {
      console.error('Delete all employees error:', error);
      res.status(500).json({ success: false, error: 'Failed to delete employees' });
      return;
    }

    await auditService.logFromRequest(req, req.user.id, 'DELETE_ALL_EMPLOYEES', {
      details: { deleted: beforeCount || 0 },
    });

    res.json({
      success: true,
      data: { deleted: beforeCount || 0 },
      message: `Удалено ${beforeCount || 0} сотрудников`,
    });
  } catch (error) {
    console.error('Delete all employees error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete employees' });
  }
}
