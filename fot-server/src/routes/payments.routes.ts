import { Router } from 'express';
import { paymentsController } from '../controllers/payments.controller.js';
import { authenticate, requirePageAccess } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

router.get('/my', requirePageAccess('/employee', 'view'), paymentsController.getMy);
router.get('/employee/:empId', requirePageAccess('/admin/payments', 'view'), paymentsController.getByEmployee);
router.post('/', requirePageAccess('/admin/payments', 'edit'), paymentsController.create);
router.post('/import', requirePageAccess('/admin/payments', 'edit'), paymentsController.importBatch);

export default router;
