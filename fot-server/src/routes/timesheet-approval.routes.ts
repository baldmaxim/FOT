import { Router } from 'express';
import { timesheetApprovalController } from '../controllers/timesheet-approval.controller.js';
import { authenticate, requirePosition, requireOrganization, injectOrganizationFromQuery } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);
router.use(injectOrganizationFromQuery);
router.use(requireOrganization);

// POST /api/timesheet-approvals/submit — header подтверждает
router.post('/submit', requirePosition('header', 'hr', 'admin', 'super_admin'), timesheetApprovalController.submit);

// GET /api/timesheet-approvals/status — статус по отделу + период
router.get('/status', requirePosition('header', 'hr', 'admin', 'super_admin'), timesheetApprovalController.getStatus);

// GET /api/timesheet-approvals/pending — hr: все неутверждённые
router.get('/pending', requirePosition('hr', 'admin', 'super_admin'), timesheetApprovalController.getPending);

// POST /api/timesheet-approvals/:id/approve — hr утверждает
router.post('/:id/approve', requirePosition('hr', 'admin', 'super_admin'), timesheetApprovalController.approve);

// POST /api/timesheet-approvals/:id/reject — hr отклоняет
router.post('/:id/reject', requirePosition('hr', 'admin', 'super_admin'), timesheetApprovalController.reject);

export default router;
