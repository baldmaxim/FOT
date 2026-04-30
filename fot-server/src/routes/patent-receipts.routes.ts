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

router.get('/my', patentReceiptsController.getMy);
router.post('/my/upload', upload.single('file'), patentReceiptsController.uploadMy);
router.get('/', requirePageAccess('/admin/patent-receipts', 'view'), patentReceiptsController.list);
router.get('/:id', requirePageAccess('/admin/patent-receipts', 'view'), patentReceiptsController.getOne);
router.patch('/:id', requirePageAccess('/admin/patent-receipts', 'edit'), patentReceiptsController.update);
router.delete('/:id', requirePageAccess('/admin/patent-receipts', 'edit'), patentReceiptsController.remove);
router.post('/:documentId/recognize', requirePageAccess('/admin/patent-receipts', 'edit'), patentReceiptsController.recognize);

export default router;
