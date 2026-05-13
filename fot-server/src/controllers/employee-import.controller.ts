import { Response } from 'express';
import { execute, queryOne } from '../config/postgres.js';
import { auditService } from '../services/audit.service.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { resolveRequestDataScope } from '../services/data-scope.service.js';

/**
 * DELETE /api/employees/all
 */
export async function deleteAll(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const scope = await resolveRequestDataScope(req);
    if (scope !== 'all') {
      res.status(403).json({ success: false, error: 'Эта операция доступна только для all-scope ролей' });
      return;
    }

    const countRow = await queryOne<{ total: number }>(
      'SELECT count(*)::int AS total FROM employees',
    );
    const beforeCount = countRow?.total ?? 0;

    try {
      await execute('DELETE FROM employees WHERE id <> 0');
    } catch (deleteError) {
      console.error('Delete all employees error:', deleteError);
      res.status(500).json({ success: false, error: 'Failed to delete employees' });
      return;
    }

    await auditService.logFromRequest(req, req.user.id, 'DELETE_ALL_EMPLOYEES', {
      details: { deleted: beforeCount },
    });

    res.json({
      success: true,
      data: { deleted: beforeCount },
      message: `Удалено ${beforeCount} сотрудников`,
    });
  } catch (error) {
    console.error('Delete all employees error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete employees' });
  }
}
