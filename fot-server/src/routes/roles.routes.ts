import { Router } from 'express';
import { rolesController } from '../controllers/roles.controller.js';
import { authenticate, requirePageAccess, requireAnyPageAccess } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

// Минимальный список ролей (code, name, is_admin) — нужен AuthContext всем
// authenticated, чтобы рендерить подписи ролей в чате и UI.
router.get('/labels', rolesController.getLabels); // audit:public

router.get('/catalog', requirePageAccess('/admin/roles', 'view'), rolesController.getCatalog);
router.get('/:code/access-profile', requirePageAccess('/admin/roles', 'view'), rolesController.getAccessProfile);
router.put('/:code/access-profile', requirePageAccess('/admin/roles', 'edit'), rolesController.updateAccessProfile);
router.post('/:code/clone', requirePageAccess('/admin/roles', 'edit'), rolesController.cloneRole);

// Полный список ролей (со всеми полями) нужен страницам /admin/users и /admin/roles
// (для approve-формы и редактирования). Минимум — view одного из этих разделов.
router.get('/', requireAnyPageAccess(['/admin/users', '/admin/roles'], 'view'), rolesController.getRoles);
router.post('/', requirePageAccess('/admin/roles', 'edit'), rolesController.createRole);
router.put('/:code', requirePageAccess('/admin/roles', 'edit'), rolesController.updateRole);
router.delete('/:code', requirePageAccess('/admin/roles', 'edit'), rolesController.deleteRole);

export default router;
