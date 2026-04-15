import { Router } from 'express';
import { rolesController } from '../controllers/roles.controller.js';
import { authenticate, requirePageAccess } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

router.get('/catalog', requirePageAccess('/admin/roles', 'view'), rolesController.getCatalog);
router.get('/:code/access-profile', requirePageAccess('/admin/roles', 'view'), rolesController.getAccessProfile);
router.put('/:code/access-profile', requirePageAccess('/admin/roles', 'edit'), rolesController.updateAccessProfile);
router.post('/:code/clone', requirePageAccess('/admin/roles', 'edit'), rolesController.cloneRole);

// GET доступен всем аутентифицированным — фронт загружает для canAccess
router.get('/', rolesController.getRoles);
router.post('/', requirePageAccess('/admin/roles', 'edit'), rolesController.createRole);
router.put('/:code', requirePageAccess('/admin/roles', 'edit'), rolesController.updateRole);
router.delete('/:code', requirePageAccess('/admin/roles', 'edit'), rolesController.deleteRole);

export default router;
