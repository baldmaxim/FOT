import { Router } from 'express';
import type { Response, NextFunction } from 'express';
import { correctionApprovalController } from '../controllers/correction-approval.controller.js';
import { authenticate, requirePageAccess, requireAdmin } from '../middleware/auth.js';
import { invalidateCaches } from '../middleware/cacheResponse.js';
import { resolveEffectivePageAccess } from '../services/access-control.service.js';
import { isActiveWeekendResponsible } from '../services/weekend-approval-assignments.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

const router = Router();

router.use(authenticate);

// Доступ к очереди согласований: обычное право /timesheet-hr ЛИБО «по назначению» —
// сотрудник, назначенный ответственным за выходные (decision 10). Контроллер далее
// режет видимость/действия до его строк.
const requireQueueAccess = (action: 'view' | 'edit') => (
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (await resolveEffectivePageAccess(req, '/timesheet-hr', action)) return next();
      if (req.user?.employee_id && await isActiveWeekendResponsible(req.user.employee_id)) return next();
      res.status(403).json({ success: false, error: 'Insufficient permissions' });
    } catch (err) {
      console.error('requireQueueAccess error:', err);
      res.status(500).json({ success: false, error: 'Authorization check failed' });
    }
  }
);

// Любой успешный write на /api/correction-approvals/* меняет состояние корректировок
// табеля → сбрасываем связанные timesheet-LRU, иначе после approve/reject/revert
// /api/timesheet* до 5 минут отдаёт кэш со старым approval_status.
router.use((req, res, next) => {
  res.on('finish', () => {
    const isWrite = req.method === 'POST' || req.method === 'PUT'
      || req.method === 'PATCH' || req.method === 'DELETE';
    if (isWrite && res.statusCode >= 200 && res.statusCode < 300) {
      invalidateCaches(
        'timesheet',
        'timesheet:today',
        'timesheet:overview',
        'timesheet:overview:today',
        'timesheet:search',
      );
    }
  });
  next();
});

router.get(
  '/settings',
  requirePageAccess('/timesheet-hr', 'view'),
  correctionApprovalController.getSettings,
);

router.put(
  '/settings',
  requirePageAccess('/timesheet-hr', 'edit'),
  correctionApprovalController.saveSettings,
);

router.get(
  '/pending-by-department',
  requireQueueAccess('view'),
  correctionApprovalController.getPendingByDepartment,
);

router.get(
  '/history-by-department',
  requireQueueAccess('view'),
  correctionApprovalController.getHistoryByDepartment,
);

// Админ-обзор очереди «глазами ответственных» (read-only). Только админ;
// контроллер дополнительно режет по scope (system-admin — всё, company-admin — свой).
router.get(
  '/all-by-responsible',
  requireAdmin,
  correctionApprovalController.getAllByResponsible,
);

router.post(
  '/:id/approve',
  requireQueueAccess('edit'),
  correctionApprovalController.approveOne,
);

router.post(
  '/:id/reject',
  requireQueueAccess('edit'),
  correctionApprovalController.rejectOne,
);

router.post(
  '/:id/revert',
  requireQueueAccess('edit'),
  correctionApprovalController.revertOne,
);

router.post(
  '/bulk-approve',
  requireQueueAccess('edit'),
  correctionApprovalController.bulkApprove,
);

router.post(
  '/bulk-approve-by-ids',
  requireQueueAccess('edit'),
  correctionApprovalController.bulkApproveByIds,
);

router.post(
  '/bulk-reject-by-ids',
  requireQueueAccess('edit'),
  correctionApprovalController.bulkRejectByIds,
);

router.post(
  '/bulk-revert-by-ids',
  requireQueueAccess('edit'),
  correctionApprovalController.bulkRevertByIds,
);

export default router;
