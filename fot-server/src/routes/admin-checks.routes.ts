import { Router } from 'express';
import { adminChecksController } from '../controllers/admin-checks.controller.js';
import { authenticate, requirePageAccess, requireCritical2FA } from '../middleware/auth.js';
import { noStore } from '../middleware/noStore.js';

const router = Router();

router.use(authenticate);
router.use(noStore); // модуль работает с ПДн — не кэшируем

const view = requirePageAccess('/admin/checks', 'view');
const edit = requirePageAccess('/admin/checks', 'edit');

router.get('/connection-settings', view, adminChecksController.getConnectionSettings);
router.put('/connection-settings', edit, requireCritical2FA, adminChecksController.saveConnectionSettings);
router.post('/connection-settings/validate', edit, adminChecksController.validateConnection);

router.get('/orgs', view, adminChecksController.listOrgs);
router.get('/passes', view, adminChecksController.listPasses);
router.post('/run', edit, adminChecksController.run);
router.post('/run-bulk', edit, adminChecksController.runBulk);
router.get('/results', view, adminChecksController.getResults);
router.get('/results/:id/raw', edit, adminChecksController.getRaw);

export default router;
