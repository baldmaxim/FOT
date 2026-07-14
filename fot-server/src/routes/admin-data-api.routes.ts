import { Router } from 'express';
import { adminDataApiController } from '../controllers/admin-data-api.controller.js';
import { authenticate, requirePageAccess } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

const view = requirePageAccess('/admin/data-api', 'view');
const edit = requirePageAccess('/admin/data-api', 'edit');

router.get('/keys', view, adminDataApiController.listKeys);
router.post('/keys', edit, adminDataApiController.createKey);
router.patch('/keys/:id', edit, adminDataApiController.updateKey);
router.delete('/keys/:id', edit, adminDataApiController.revokeKey);
// Безвозвратное удаление (только отозванный/истёкший ключ) — вместе с логами и доступами.
router.delete('/keys/:id/purge', edit, adminDataApiController.deleteKey);

router.get('/keys/:id/tables', view, adminDataApiController.getKeyTables);
router.put('/keys/:id/tables', edit, adminDataApiController.updateKeyTables);
router.get('/keys/:id/logs', view, adminDataApiController.getKeyLogs);

router.get('/db-schema', view, adminDataApiController.getDbSchema);

export default router;
