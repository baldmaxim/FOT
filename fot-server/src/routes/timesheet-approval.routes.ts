import { Router } from 'express';
import multer from 'multer';
import { timesheetApprovalController } from '../controllers/timesheet-approval.controller.js';
import { authenticate, requirePageAccess } from '../middleware/auth.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

router.use(authenticate);

router.get('/responsibles', requirePageAccess('/admin/settings', 'view'), timesheetApprovalController.getResponsibles);
router.get('/responsibles/candidates', requirePageAccess('/admin/settings', 'view'), timesheetApprovalController.getResponsibleCandidates);
router.put('/responsibles', requirePageAccess('/admin/settings', 'edit'), timesheetApprovalController.saveResponsibles);

// Подать табель — нужен edit на /timesheet.
router.post('/submit', requirePageAccess('/timesheet', 'edit'), timesheetApprovalController.submit);

// Отозвать поданный табель назад в draft (только из 'submitted') — edit на /timesheet.
router.post('/recall', requirePageAccess('/timesheet', 'edit'), timesheetApprovalController.recall);

router.get('/status', requirePageAccess('/timesheet', 'view'), timesheetApprovalController.getStatus);
router.get('/department', requirePageAccess('/timesheet', 'view'), timesheetApprovalController.listDepartmentApprovals);

// Мониторинг очереди — view на /timesheet-hr.
router.get('/pending', requirePageAccess('/timesheet-hr', 'view'), timesheetApprovalController.getPending);
router.get('/list', requirePageAccess('/timesheet-hr', 'view'), timesheetApprovalController.getByStatus);
router.get('/:id/history', requirePageAccess('/timesheet-hr', 'view'), timesheetApprovalController.getHistory);
router.get('/:id/employees', requirePageAccess('/timesheet-hr', 'view'), timesheetApprovalController.getSubmittedEmployees);

// Утверждение/отклонение/возврат — edit на /timesheet-hr.
router.post('/:id/approve', requirePageAccess('/timesheet-hr', 'edit'), timesheetApprovalController.approve);
router.post('/:id/reject', requirePageAccess('/timesheet-hr', 'edit'), timesheetApprovalController.reject);
router.post('/:id/return-to-rework', requirePageAccess('/timesheet-hr', 'edit'), timesheetApprovalController.returnToRework);

// Вложения к подаче табеля (подтверждения работы в выходные).
// Загрузка — multipart через бэкенд (файл идёт в R2 серверно, без браузерного PUT).
router.post('/attachments', requirePageAccess('/timesheet', 'edit'), upload.single('file'), timesheetApprovalController.uploadAttachment);
router.get('/attachments', requirePageAccess('/timesheet', 'view'), timesheetApprovalController.listAttachments);
router.get('/attachments/:document_id/download', requirePageAccess('/timesheet', 'view'), timesheetApprovalController.getAttachmentDownloadUrl);
router.delete('/attachments/:document_id', requirePageAccess('/timesheet', 'edit'), timesheetApprovalController.deleteAttachment);

// Объединённый review-list для админской страницы согласований.
router.get('/review-list', requirePageAccess('/timesheet-hr', 'view'), timesheetApprovalController.getReviewList);

export default router;
