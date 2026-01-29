import { Router } from 'express';
import { adminController } from '../controllers/admin.controller.js';
import { authenticate, requireSuperAdmin } from '../middleware/auth.js';

const router = Router();

// Все роуты требуют аутентификации и super_admin роль
router.use(authenticate as any);
router.use(requireSuperAdmin as any);

// Пользователи
router.get('/users', adminController.getAllUsers as any);
router.get('/users/pending', adminController.getPendingUsers as any);
router.post('/users/:id/approve', adminController.approveUser as any);
router.post('/users/:id/reject', adminController.rejectUser as any);
router.delete('/users/:id', adminController.deleteUser as any);
router.post('/users/:id/confirm-email', adminController.confirmUserEmail as any);
router.patch('/users/:id/position', adminController.updateUserPosition as any);
router.patch('/users/:id/organization', adminController.assignOrganization as any);
router.patch('/users/:id/name', adminController.updateUserName as any);

// 2FA управление
router.post('/users/:id/generate-2fa', adminController.generate2FA as any);
router.post('/users/:id/disable-2fa', adminController.disable2FA as any);

// Организации
router.get('/organizations', adminController.getOrganizations as any);
router.post('/organizations', adminController.createOrganization as any);
router.patch('/organizations/:id', adminController.updateOrganization as any);
router.delete('/organizations/:id', adminController.deleteOrganization as any);

// Аудит логи
router.get('/audit-logs', adminController.getAuditLogs as any);

export default router;
