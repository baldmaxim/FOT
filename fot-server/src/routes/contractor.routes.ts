import { Router } from 'express';
import { contractorController } from '../controllers/contractor.controller.js';
import { authenticate, requirePageAccess } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

const view = requirePageAccess('/contractor', 'view');
const edit = requirePageAccess('/contractor', 'edit');

router.get('/me/org', view, contractorController.getMyOrg);
router.get('/roster', view, contractorController.getRoster);
router.post('/roster/person', edit, contractorController.addPerson);
router.post('/roster/:id/remove', edit, contractorController.markPersonRemoval);
router.post('/roster/:id/unmark', edit, contractorController.unmarkPerson);
router.get('/passes', view, contractorController.getPasses);
router.post('/passes/:id/holder', edit, contractorController.setPassHolder);
router.post('/passes/:id/assign', edit, contractorController.assignPass);
router.post('/submit', edit, contractorController.submit);
router.get('/submissions', view, contractorController.getSubmissions);

export default router;
