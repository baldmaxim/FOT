import { Router } from 'express';
import { rolesController } from '../controllers/roles.controller.js';
import { authenticate, requireMinPosition, requireSuperAdmin } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

router.get('/available-pages', requireMinPosition('admin'), rolesController.getAvailablePages);
router.get('/page-access', requireMinPosition('admin'), rolesController.getPageAccess);
router.put('/page-access', requireSuperAdmin, rolesController.updatePageAccess);

// GET доступен всем аутентифицированным — фронт загружает для canAccess
router.get('/', rolesController.getRoles);
router.post('/', requireSuperAdmin, rolesController.createRole);
router.put('/:code', requireSuperAdmin, rolesController.updateRole);
router.delete('/:code', requireSuperAdmin, rolesController.deleteRole);

export default router;
