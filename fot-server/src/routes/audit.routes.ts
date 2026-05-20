import { Router } from 'express';
import { auditController } from '../controllers/audit.controller.js';
import { authenticate, requirePageAccess } from '../middleware/auth.js';

const router = Router();

// Все роуты требуют аутентификации и позиции admin
router.use(authenticate);
router.use(requirePageAccess('/admin/audit', 'view'));

// История действий пользователей
router.get('/logs', requirePageAccess('/admin/action-history', 'view'), auditController.getActionLogs);

// Запуск полного аудита
router.get('/run', auditController.runFullAudit);

// Запуск конкретной проверки
router.get('/check/:checkType', auditController.runSingleCheck);

export default router;
