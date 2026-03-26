import { Router } from 'express';
import { adminController } from '../controllers/admin.controller.js';
import { authenticate, requireSuperAdmin, requireMinPosition } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

// Пользователи — доступно admin + super_admin
router.get('/users', requireMinPosition('admin'), adminController.getAllUsers);
router.get('/users/pending', requireMinPosition('admin'), adminController.getPendingUsers);
router.post('/users/:id/approve', requireMinPosition('admin'), adminController.approveUser);
router.post('/users/:id/reject', requireMinPosition('admin'), adminController.rejectUser);
router.delete('/users/:id', requireSuperAdmin, adminController.deleteUser);
router.post('/users/:id/confirm-email', requireMinPosition('admin'), adminController.confirmUserEmail);
router.patch('/users/:id/position', requireMinPosition('admin'), adminController.updateUserPosition);
router.patch('/users/:id/organization', requireSuperAdmin, adminController.assignOrganization);
router.patch('/users/:id/name', requireMinPosition('admin'), adminController.updateUserName);
router.patch('/users/:id/employee', requireMinPosition('admin'), adminController.updateUserEmployee);

// 2FA управление
router.post('/users/:id/generate-2fa', requireSuperAdmin, adminController.generate2FA);
router.post('/users/:id/disable-2fa', requireSuperAdmin, adminController.disable2FA);

// Поиск сотрудников (для привязки при одобрении)
router.get('/employees/search', requireMinPosition('admin'), adminController.searchUnlinkedEmployees);

// Организации — только super_admin
router.get('/organizations', requireSuperAdmin, adminController.getOrganizations);
router.post('/organizations', requireSuperAdmin, adminController.createOrganization);
router.patch('/organizations/:id', requireSuperAdmin, adminController.updateOrganization);
router.delete('/organizations/:id', requireSuperAdmin, adminController.deleteOrganization);

// Аудит логи
router.get('/audit-logs', requireSuperAdmin, adminController.getAuditLogs);

export default router;
