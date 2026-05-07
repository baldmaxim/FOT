import { Router } from 'express';
import { correctionApprovalController } from '../controllers/correction-approval.controller.js';
import { authenticate, requirePageAccess } from '../middleware/auth.js';
import { invalidateCaches } from '../middleware/cacheResponse.js';

const router = Router();

router.use(authenticate);

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
  '/pending-by-department',
  requirePageAccess('/timesheet-hr', 'view'),
  correctionApprovalController.getPendingByDepartment,
);

router.get(
  '/history-by-department',
  requirePageAccess('/timesheet-hr', 'view'),
  correctionApprovalController.getHistoryByDepartment,
);

router.post(
  '/:id/approve',
  requirePageAccess('/timesheet-hr', 'edit'),
  correctionApprovalController.approveOne,
);

router.post(
  '/:id/reject',
  requirePageAccess('/timesheet-hr', 'edit'),
  correctionApprovalController.rejectOne,
);

router.post(
  '/:id/revert',
  requirePageAccess('/timesheet-hr', 'edit'),
  correctionApprovalController.revertOne,
);

router.post(
  '/bulk-approve',
  requirePageAccess('/timesheet-hr', 'edit'),
  correctionApprovalController.bulkApprove,
);

router.post(
  '/bulk-approve-by-ids',
  requirePageAccess('/timesheet-hr', 'edit'),
  correctionApprovalController.bulkApproveByIds,
);

router.post(
  '/bulk-reject-by-ids',
  requirePageAccess('/timesheet-hr', 'edit'),
  correctionApprovalController.bulkRejectByIds,
);

export default router;
