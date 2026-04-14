import { Router } from 'express';
import { timesheetApprovalController } from '../controllers/timesheet-approval.controller.js';
import { authenticate, requireAnyPageAccess, requirePageAccess } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

// GET /api/timesheet-approvals/responsibles — ответственные по отделу
router.get('/responsibles', requirePageAccess('/admin/settings', 'view'), timesheetApprovalController.getResponsibles);

// GET /api/timesheet-approvals/responsibles/candidates — кандидаты из отдела
router.get('/responsibles/candidates', requirePageAccess('/admin/settings', 'view'), timesheetApprovalController.getResponsibleCandidates);

// PUT /api/timesheet-approvals/responsibles — сохранить ответственных по отделу
router.put('/responsibles', requirePageAccess('/admin/settings', 'edit'), timesheetApprovalController.saveResponsibles);

// POST /api/timesheet-approvals/submit — header подтверждает
router.post('/submit', requirePageAccess('/timesheet', 'edit'), timesheetApprovalController.submit);

// GET /api/timesheet-approvals/status — статус по отделу + период
router.get('/status', requirePageAccess('/timesheet', 'view'), timesheetApprovalController.getStatus);

// GET /api/timesheet-approvals/pending — hr: все неутверждённые
router.get('/pending', requirePageAccess('/timesheet-hr', 'view'), timesheetApprovalController.getPending);

// GET /api/timesheet-approvals/list?status=... — hr: список по статусу
router.get('/list', requirePageAccess('/timesheet-hr', 'view'), timesheetApprovalController.getByStatus);

// GET /api/timesheet-approvals/:id/history — hr: история согласования
router.get('/:id/history', requirePageAccess('/timesheet-hr', 'view'), timesheetApprovalController.getHistory);

// POST /api/timesheet-approvals/:id/approve — утверждение табеля ответственным/HR
router.post('/:id/approve', requireAnyPageAccess(['/timesheet', '/timesheet-hr'], 'edit'), timesheetApprovalController.approve);

// POST /api/timesheet-approvals/:id/reject — отклонение табеля ответственным/HR
router.post('/:id/reject', requireAnyPageAccess(['/timesheet', '/timesheet-hr'], 'edit'), timesheetApprovalController.reject);

// POST /api/timesheet-approvals/:id/return-to-rework — возврат табеля на доработку ответственным/HR
router.post('/:id/return-to-rework', requireAnyPageAccess(['/timesheet', '/timesheet-hr'], 'edit'), timesheetApprovalController.returnToRework);

export default router;
