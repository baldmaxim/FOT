import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { timesheetApprovalController } from '../controllers/timesheet-approval.controller.js';
import { timesheetReviewController } from '../controllers/timesheet-review.controller.js';
import { authenticate, requireAnyPageAccess, requirePageAccess } from '../middleware/auth.js';
import { noStore } from '../middleware/noStore.js';
import { registerCache } from '../middleware/cacheResponse.js';
import { canToggleTimesheetLock, resolveEffectivePageAccess } from '../services/access-control.service.js';
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

// Открыть/закрыть сданный период — админ и кадровая служба. Гейт /timesheet-hr здесь не
// годится: у роли hr этой страницы нет, а выдача открыла бы ей заодно утверждение,
// отклонение и возврат. Предикат вынесен в access-control.service — его же гоняют тесты.
const requireTimesheetLockToggle = () => (
  (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (canToggleTimesheetLock(req.user)) {
      next();
      return;
    }
    res.status(403).json({ success: false, error: 'Insufficient permissions' });
  }
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

router.use(authenticate);

// Весь модуль отдаёт изменяемое состояние: статус подачи, замок периода, история, списки
// на проверку. Глобальный `private, max-age=30` из app.ts заставлял браузер 30 секунд
// отвечать из собственного кэша, не доходя до сервера, — после «Открыть табель» рефетч
// приносил прежний статус и кнопки перерисовывались только по F5.
router.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') {
    noStore(req, res, next);
    return;
  }
  next();
});

router.get('/responsibles', requirePageAccess('/admin/settings', 'view'), timesheetApprovalController.getResponsibles);
router.get('/responsibles/candidates', requirePageAccess('/admin/settings', 'view'), timesheetApprovalController.getResponsibleCandidates);
router.put('/responsibles', requirePageAccess('/admin/settings', 'edit'), timesheetApprovalController.saveResponsibles);

// Подать табель — нужен edit на /timesheet.
router.post('/submit', requirePageAccess('/timesheet', 'edit'), timesheetApprovalController.submit);

// Отозвать табель назад в draft — edit на /timesheet. Из 'submitted' может руководитель,
// из 'approved' — только админ (проверка в контроллере): иначе руководитель снимал бы
// утверждение HR и правил закрытый период сам.
router.post('/recall', requirePageAccess('/timesheet', 'edit'), timesheetApprovalController.recall);

// Временное открытие сданного периода: статус подачи не меняется, снимается только замок
// закрытого табеля. Закрытие возвращает замок.
router.post('/:id/open', requireTimesheetLockToggle(), timesheetApprovalController.openPeriod);
router.post('/:id/close', requireTimesheetLockToggle(), timesheetApprovalController.closePeriod);

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

// Статус выгрузки табелей в 1С — отдельным лёгким запросом, чтобы не задерживать
// основной список согласований. Ключ кэша включает пользователя (у ролей разный
// data-scope) и период; после ACK кэш инвалидируется из публичного контроллера.
const timesheet1CStatusCache = registerCache(
  'timesheet-1c-status',
  (req: Request) => {
    const userId = (req as AuthenticatedRequest).user?.id ?? 'anon';
    return `1c-status:${userId}:${req.query.start_date ?? ''}:${req.query.end_date ?? ''}`;
  },
  30_000,
  { staleMs: 60_000, max: 200 },
);

router.get(
  '/1c-status',
  requirePageAccess('/timesheet-hr', 'view'),
  timesheet1CStatusCache,
  timesheetApprovalController.get1CStatus,
);

// Дашборд HR: статистика подачи/утверждения + карта руководителей.
router.get('/dashboard', requirePageAccess('/timesheet-hr', 'view'), timesheetApprovalController.getDashboard);

export default router;
