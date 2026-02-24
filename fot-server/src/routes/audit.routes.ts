import { Router } from 'express';
import { auditController } from '../controllers/audit.controller.js';
import { authenticate, requirePosition, injectOrganizationFromQuery, requireOrganization } from '../middleware/auth.js';

const router = Router();

// Все роуты требуют аутентификации и позиции admin или super_admin
router.use(authenticate as any);
router.use(injectOrganizationFromQuery as any);
router.use(requireOrganization as any);
router.use(requirePosition('admin', 'super_admin') as any);

// Запуск полного аудита
router.get('/run', auditController.runFullAudit as any);

// Запуск конкретной проверки
router.get('/check/:checkType', auditController.runSingleCheck as any);

export default router;
