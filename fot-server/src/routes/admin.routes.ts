import { Router } from 'express';
import multer from 'multer';
import { adminController } from '../controllers/admin.controller.js';
import { authenticate, requirePageAccess } from '../middleware/auth.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    const allowedMimes = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
    ];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Недопустимый формат файла. Разрешены только .xlsx и .xls'));
    }
  },
});

router.use(authenticate);

// Пользователи — доступно admin + super_admin
router.get('/users', requirePageAccess('/admin/users', 'view'), adminController.getAllUsers);
router.get('/users/pending', requirePageAccess('/admin/users', 'view'), adminController.getPendingUsers);
router.get('/employees/department-access', requirePageAccess('/admin/users', 'view'), adminController.getEmployeeDepartmentAssignments);
router.post(
  '/users/department-access-import/preview',
  requirePageAccess('/admin/users', 'view'),
  upload.single('file'),
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
router.patch('/users/:id/department', requirePageAccess('/admin/users', 'edit'), adminController.updateEmployeeDepartment);
router.put('/users/:id/department-access', requirePageAccess('/admin/users', 'edit'), adminController.updateUserDepartmentAccess);
router.put('/employees/:id/department-access', requirePageAccess('/admin/users', 'edit'), adminController.updateEmployeeDepartmentAccess);

// 2FA управление
router.post('/users/:id/generate-2fa', requirePageAccess('/admin/users', 'edit'), adminController.generate2FA);
router.post('/users/:id/disable-2fa', requirePageAccess('/admin/users', 'edit'), adminController.disable2FA);

// Поиск сотрудников (для привязки при одобрении)
router.get('/employees/search', requirePageAccess('/admin/users', 'view'), adminController.searchUnlinkedEmployees);

// Аудит логи
router.get('/audit-logs', requirePageAccess('/admin/audit', 'view'), adminController.getAuditLogs);

export default router;
