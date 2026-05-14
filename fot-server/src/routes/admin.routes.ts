import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { adminController } from '../controllers/admin.controller.js';
import { adminSystemResourcesController } from '../controllers/admin-system-resources.controller.js';
import { authenticate, requirePageAccess } from '../middleware/auth.js';
import { isExcelBuffer, sanitizeFileName } from '../utils/file-validation.utils.js';

const router = Router();

const ACCEPTED_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  // Windows/Chrome нередко отдают .xlsx так — считаем валидным,
  // если расширение совпадает.
  'application/octet-stream',
  '',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    const hasExcelExtension = /\.(xlsx|xls)$/i.test(file.originalname || '');
    if (ACCEPTED_MIMES.has(file.mimetype) || hasExcelExtension) {
      cb(null, true);
      return;
    }
    cb(new Error(
      `Недопустимый формат файла (${file.mimetype || 'unknown'}). Разрешены .xlsx и .xls`,
    ));
  },
});

/**
 * Оборачивает multer так, чтобы его ошибки (лимит размера, отклонённый
 * mime, невалидный form-data) превращались в 400 JSON, а не голый 500.
 * После успешной загрузки — magic-bytes проверка + sanitize originalname.
 */
function uploadSingleFile(field: string) {
  const middleware = upload.single(field);
  return (req: Request, res: Response, next: NextFunction) => {
    middleware(req, res, err => {
      if (err) {
        const message = err instanceof Error ? err.message : 'Ошибка загрузки файла';
        res.status(400).json({ success: false, error: message });
        return;
      }
      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (file) {
        if (!isExcelBuffer(file.buffer)) {
          res.status(400).json({
            success: false,
            error: 'Файл не является корректным Excel-документом (.xlsx/.xls).',
          });
          return;
        }
        file.originalname = sanitizeFileName(file.originalname);
      }
      next();
    });
  };
}

router.use(authenticate);

// Пользователи — доступно admin + super_admin
router.get('/users', requirePageAccess('/admin/users', 'view'), adminController.getAllUsers);
router.get('/users/pending', requirePageAccess('/admin/users', 'view'), adminController.getPendingUsers);
router.get('/employees/department-access', requirePageAccess('/admin/users', 'view'), adminController.getEmployeeDepartmentAssignments);
router.post(
  '/users/department-access-import/preview',
  requirePageAccess('/admin/users', 'view'),
  uploadSingleFile('file'),
  adminController.previewDepartmentAccessImport,
);
router.post(
  '/users/department-access-import/apply',
  requirePageAccess('/admin/users', 'edit'),
  adminController.applyDepartmentAccessImport,
);
router.post(
  '/users/department-access-import/apply-worker-transfers',
  requirePageAccess('/admin/users', 'edit'),
  adminController.applyBrigadeWorkerTransfers,
);
router.delete(
  '/users/department-access-assignments',
  requirePageAccess('/admin/users', 'edit'),
  adminController.clearDepartmentAssignments,
);
router.post('/users/:id/approve', requirePageAccess('/admin/users', 'edit'), adminController.approveUser);
router.post('/users/:id/reject', requirePageAccess('/admin/users', 'edit'), adminController.rejectUser);
router.delete('/users/:id', requirePageAccess('/admin/users', 'edit'), adminController.deleteUser);
router.post('/users/:id/confirm-email', requirePageAccess('/admin/users', 'edit'), adminController.confirmUserEmail);
router.patch('/users/:id/position', requirePageAccess('/admin/users', 'edit'), adminController.updateUserPosition);
router.patch('/users/:id/name', requirePageAccess('/admin/users', 'edit'), adminController.updateUserName);
router.patch('/users/:id/chat-inbound-mode', requirePageAccess('/admin/users', 'edit'), adminController.updateUserChatInboundMode);
router.patch('/users/:id/employee', requirePageAccess('/admin/users', 'edit'), adminController.updateUserEmployee);
router.put('/users/:id/department-access', requirePageAccess('/admin/users', 'edit'), adminController.updateUserDepartmentAccess);
router.put('/employees/:id/department-access', requirePageAccess('/admin/users', 'edit'), adminController.updateEmployeeDepartmentAccess);

// Приписка сотрудника к объектам строительства (миграция 092).
router.get('/skud-objects', requirePageAccess('/admin/users', 'view'), adminController.listSkudObjectsForAssignment);
router.get('/employees/:id/skud-objects', requirePageAccess('/admin/users', 'view'), adminController.getEmployeeSkudObjects);
router.put('/employees/:id/skud-objects', requirePageAccess('/admin/users', 'edit'), adminController.updateEmployeeSkudObjectAccess);

// Начальник участка: флаг + прямые назначения сотрудников (миграция 090).
router.patch('/users/:id/site-supervisor', requirePageAccess('/admin/users', 'edit'), adminController.setSiteSupervisor);
router.put('/users/:id/employee-access', requirePageAccess('/admin/users', 'edit'), adminController.updateUserEmployeeAccess);

// Привязка администраторов к «компаниям» (корневым узлам Sigur). Только системный админ.
router.get('/companies', requirePageAccess('/admin/users', 'view'), adminController.listCompanies);
router.get('/users/:id/companies', requirePageAccess('/admin/users', 'view'), adminController.getUserCompanies);
router.put('/users/:id/companies', requirePageAccess('/admin/users', 'edit'), adminController.replaceUserCompanies);

// 2FA управление
router.post('/users/:id/generate-2fa', requirePageAccess('/admin/users', 'edit'), adminController.generate2FA);
router.post('/users/:id/disable-2fa', requirePageAccess('/admin/users', 'edit'), adminController.disable2FA);

// Поиск сотрудников (для привязки при одобрении)
router.get('/employees/search', requirePageAccess('/admin/users', 'view'), adminController.searchUnlinkedEmployees);

// Аудит логи
router.get('/audit-logs', requirePageAccess('/admin/audit', 'view'), adminController.getAuditLogs);

// Мини-монитор ресурсов сервера (CPU/RAM/uptime + статус фоновых сервисов)
router.get('/system-resources', requirePageAccess('/admin/settings', 'view'), adminSystemResourcesController.getSystemResources);

export default router;
