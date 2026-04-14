import { Router } from 'express';
import { rolesController } from '../controllers/roles.controller.js';
import { authenticate, requireSuperAdminOrPageAccess } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

router.get('/available-pages', requireSuperAdminOrPageAccess('/admin/roles', 'view'), rolesController.getAvailablePages);
router.get('/page-access', requireSuperAdminOrPageAccess('/admin/roles', 'view'), rolesController.getPageAccess);
router.put('/page-access', requireSuperAdminOrPageAccess('/admin/roles', 'edit'), rolesController.updatePageAccess);
router.get('/permission-catalog', requireSuperAdminOrPageAccess('/admin/roles', 'view'), rolesController.getPermissionCatalog);

// GET доступен всем аутентифицированным — фронт загружает для canAccess
router.get('/', rolesController.getRoles);
router.post('/', requireSuperAdminOrPageAccess('/admin/roles', 'edit'), rolesController.createRole);
router.put('/:code', requireSuperAdminOrPageAccess('/admin/roles', 'edit'), rolesController.updateRole);
router.delete('/:code', requireSuperAdminOrPageAccess('/admin/roles', 'edit'), rolesController.deleteRole);

export default router;
