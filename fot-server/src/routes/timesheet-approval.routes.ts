import { Router } from 'express';
import type { Response, NextFunction } from 'express';
import multer from 'multer';
import { timesheetApprovalController } from '../controllers/timesheet-approval.controller.js';
import { timesheetReviewController } from '../controllers/timesheet-review.controller.js';
import { authenticate, requireAnyPageAccess, requirePageAccess } from '../middleware/auth.js';
import { resolveEffectivePageAccess } from '../services/access-control.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

const router = Router();

// Утверждение/отклонение/возврат табеля: обычное право /timesheet-hr ЛИБО табельщица
// (её скоуп уже ограничен своими бригадами через resolveTimekeeperDepartmentSeeds внутри
// ensureApprovalAccess в контроллере — здесь только пропускаем дальше). Требуем ещё и
// /timesheet-hr view, чтобы бай-пас действовал, только пока роли вообще разрешён экран
// «Согласования» — симметрично фронтовому permission timesheet.workflow.reviewTimesheets.
const requireTimesheetReviewAccess = (action: 'view' | 'edit') => (
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (await resolveEffectivePageAccess(req, '/timesheet-hr', action)) return next();
      if (
        req.user?.role_code === 'timekeeper'
        && await resolveEffectivePageAccess(req, '/timesheet-hr', 'view')
      ) return next();
      res.status(403).json({ success: false, error: 'Insufficient permissions' });
    } catch (err) {
      console.error('requireTimesheetReviewAccess error:', err);
      res.status(500).json({ success: false, error: 'Authorization check failed' });
    }
  }
);

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

// Отметка табельщицы «Проверено» по табелю бригады за период.
// Чтение — любой со страницей табеля; запись — внутри контроллера только табельщица/админ.
router.get('/review', requirePageAccess('/timesheet', 'view'), timesheetReviewController.getReviewStatus);
router.post('/review', requirePageAccess('/timesheet', 'edit'), timesheetReviewController.setReviewStatus);
// Список проверенных бригад за период — для дерева «Табели HR → По отделам».
router.get('/reviewed-departments', requireAnyPageAccess(['/timesheet', '/timesheet-hr'], 'view'), timesheetReviewController.listReviewedDepartments);

router.get('/status', requirePageAccess('/timesheet', 'view'), timesheetApprovalController.getStatus);
router.get('/department', requirePageAccess('/timesheet', 'view'), timesheetApprovalController.listDepartmentApprovals);

// Мониторинг очереди — view на /timesheet-hr.
router.get('/pending', requirePageAccess('/timesheet-hr', 'view'), timesheetApprovalController.getPending);
router.get('/list', requirePageAccess('/timesheet-hr', 'view'), timesheetApprovalController.getByStatus);
router.get('/:id/history', requirePageAccess('/timesheet-hr', 'view'), timesheetApprovalController.getHistory);
router.get('/:id/employees', requirePageAccess('/timesheet-hr', 'view'), timesheetApprovalController.getSubmittedEmployees);

// Утверждение/отклонение/возврат — edit на /timesheet-hr, либо табельщица (см. requireTimesheetReviewAccess).
router.post('/:id/approve', requireTimesheetReviewAccess('edit'), timesheetApprovalController.approve);
router.post('/:id/reject', requireTimesheetReviewAccess('edit'), timesheetApprovalController.reject);
router.post('/:id/return-to-rework', requireTimesheetReviewAccess('edit'), timesheetApprovalController.returnToRework);

// Вложения к подаче табеля (подтверждения работы в выходные).
// Загрузка — multipart через бэкенд (файл идёт в R2 серверно, без браузерного PUT).
router.post('/attachments', requirePageAccess('/timesheet', 'edit'), upload.single('file'), timesheetApprovalController.uploadAttachment);
router.get('/attachments', requirePageAccess('/timesheet', 'view'), timesheetApprovalController.listAttachments);
router.get('/attachments/:document_id/download', requirePageAccess('/timesheet', 'view'), timesheetApprovalController.getAttachmentDownloadUrl);
router.delete('/attachments/:document_id', requirePageAccess('/timesheet', 'edit'), timesheetApprovalController.deleteAttachment);

// Объединённый review-list для админской страницы согласований.
router.get('/review-list', requirePageAccess('/timesheet-hr', 'view'), timesheetApprovalController.getReviewList);

// Дашборд HR: статистика подачи/утверждения + карта руководителей.
router.get('/dashboard', requirePageAccess('/timesheet-hr', 'view'), timesheetApprovalController.getDashboard);

export default router;
