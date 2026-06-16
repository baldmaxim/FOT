import { Router } from 'express';
import multer from 'multer';
import { patentReceiptsController } from '../controllers/patent-receipts.controller.js';
import { authenticate, requirePageAccess } from '../middleware/auth.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

router.use(authenticate);

// Self-scope: контроллер фильтрует patent_payment_receipts по req.user.employee_id.
router.get('/my', patentReceiptsController.getMy); // audit:self-scoped
router.post('/my/upload', upload.single('file'), patentReceiptsController.uploadMy); // audit:self-scoped
router.get('/', requirePageAccess('/admin/patent-receipts', 'view'), patentReceiptsController.list);
router.get('/missing', requirePageAccess('/admin/patent-receipts', 'view'), patentReceiptsController.listMissing);
router.get('/missing/export', requirePageAccess('/admin/patent-receipts', 'view'), patentReceiptsController.exportMissing);
router.get('/su10-departments', requirePageAccess('/admin/patent-receipts', 'view'), patentReceiptsController.su10Departments);
router.get('/:id', requirePageAccess('/admin/patent-receipts', 'view'), patentReceiptsController.getOne);
router.patch('/:id', requirePageAccess('/admin/patent-receipts', 'edit'), patentReceiptsController.update);
router.patch('/:id/verify', requirePageAccess('/admin/patent-receipts', 'edit'), patentReceiptsController.setVerified);
router.delete('/by-document/:documentId', requirePageAccess('/admin/patent-receipts', 'edit'), patentReceiptsController.remove);
router.post('/:documentId/recognize', requirePageAccess('/admin/patent-receipts', 'edit'), patentReceiptsController.recognize);

export default router;
