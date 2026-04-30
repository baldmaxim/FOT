import { Router } from 'express';
import { rolesController } from '../controllers/roles.controller.js';
import { authenticate, requirePageAccess, requireAnyPageAccess } from '../middleware/auth.js';
import { registerCache, invalidateCaches } from '../middleware/cacheResponse.js';

const router = Router();

router.use(authenticate);

const rolesLabelsCache = registerCache('roles:labels', () => 'roles:labels', 15 * 60_000);
const rolesListCache = registerCache('roles:list', () => 'roles:list', 15 * 60_000);
const rolesCatalogCache = registerCache('roles:catalog', () => 'roles:catalog', 15 * 60_000);

// Write-through invalidation: любой POST/PUT/DELETE сбрасывает кэши ролей.
router.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        invalidateCaches('roles:labels', 'roles:list', 'roles:catalog');
      }
    });
  }
  next();
});

// Минимальный список ролей (code, name, is_admin) — нужен AuthContext всем
// authenticated, чтобы рендерить подписи ролей в чате и UI.
router.get('/labels', rolesLabelsCache, rolesController.getLabels); // audit:public

router.get('/catalog', requirePageAccess('/admin/roles', 'view'), rolesCatalogCache, rolesController.getCatalog);
router.get('/:code/access-profile', requirePageAccess('/admin/roles', 'view'), rolesController.getAccessProfile);
router.put('/:code/access-profile', requirePageAccess('/admin/roles', 'edit'), rolesController.updateAccessProfile);
router.post('/:code/clone', requirePageAccess('/admin/roles', 'edit'), rolesController.cloneRole);

// Полный список ролей (со всеми полями) нужен страницам /admin/users и /admin/roles
// (для approve-формы и редактирования). Минимум — view одного из этих разделов.
router.get('/', requireAnyPageAccess(['/admin/users', '/admin/roles'], 'view'), rolesListCache, rolesController.getRoles);
router.post('/', requirePageAccess('/admin/roles', 'edit'), rolesController.createRole);
router.put('/:code', requirePageAccess('/admin/roles', 'edit'), rolesController.updateRole);
router.delete('/:code', requirePageAccess('/admin/roles', 'edit'), rolesController.deleteRole);

export default router;
