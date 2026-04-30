import { Router } from 'express';
import { patentReceiptsController } from '../controllers/patent-receipts.controller.js';
import { authenticate, requirePageAccess } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

router.get('/my', patentReceiptsController.getMy);
router.get('/', requirePageAccess('/admin/patent-receipts', 'view'), patentReceiptsController.list);
router.get('/:id', requirePageAccess('/admin/patent-receipts', 'view'), patentReceiptsController.getOne);
router.patch('/:id', requirePageAccess('/admin/patent-receipts', 'edit'), patentReceiptsController.update);
router.post('/:documentId/recognize', requirePageAccess('/admin/patent-receipts', 'edit'), patentReceiptsController.recognize);

export default router;
