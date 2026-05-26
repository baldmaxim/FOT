import { Router } from 'express';
import multer from 'multer';
import { contractorController } from '../controllers/contractor.controller.js';
import { authenticate, requirePageAccess } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

const view = requirePageAccess('/contractor', 'view');
const edit = requirePageAccess('/contractor', 'edit');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

router.get('/me/org', view, contractorController.getMyOrg);
router.get('/roster', view, contractorController.getRoster);
router.post('/roster/person', edit, contractorController.addPerson);
router.post('/roster/:id/remove', edit, contractorController.markPersonRemoval);
router.post('/roster/:id/unmark', edit, contractorController.unmarkPerson);
router.get('/passes', view, contractorController.getPasses);
router.post('/passes/:id/holder', edit, contractorController.setPassHolder);
router.post('/passes/:id/change-holder', edit, contractorController.changeHolder);
router.get('/passes/:id/history', view, contractorController.getPassHistory);
router.post('/passes/:id/assign', edit, contractorController.assignPass);
router.post('/submit', edit, contractorController.submit);
router.get('/submissions', view, contractorController.getSubmissions);

// Документы организации подрядчика (привязаны к org_department_id, не к submission).
router.get('/documents', view, contractorController.getDocuments);
router.post('/documents', edit, upload.single('file'), contractorController.uploadDocument);
router.delete('/documents/:id', edit, contractorController.deleteDocument);
router.get('/documents/:id/download', view, contractorController.getDocumentDownloadUrl);

export default router;
