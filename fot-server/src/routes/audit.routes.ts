import { Router } from 'express';
import { auditController } from '../controllers/audit.controller.js';
import { authenticate, requirePosition, injectOrganizationFromQuery, requireOrganization } from '../middleware/auth.js';

const router = Router();

// Все роуты требуют аутентификации и позиции admin или super_admin
router.use(authenticate);
router.use(injectOrganizationFromQuery);
router.use(requireOrganization);
router.use(requirePosition('admin', 'super_admin'));

// Запуск полного аудита
router.get('/run', auditController.runFullAudit);

// Запуск конкретной проверки
router.get('/check/:checkType', auditController.runSingleCheck);

export default router;
