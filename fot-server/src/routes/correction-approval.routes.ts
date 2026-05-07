import { Router } from 'express';
import { correctionApprovalController } from '../controllers/correction-approval.controller.js';
import { authenticate, requirePageAccess } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

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
