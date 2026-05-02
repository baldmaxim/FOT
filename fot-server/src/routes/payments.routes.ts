import { Router } from 'express';
import { paymentsController } from '../controllers/payments.controller.js';
import { authenticate, requireAdmin, requireAnyPageAccess, requirePageAccess } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

router.get('/my', requirePageAccess('/employee', 'view'), paymentsController.getMy);
router.get('/employee/:empId', requireAnyPageAccess(['/employee', '/staff-control'], 'view'), paymentsController.getByEmployee);
router.post('/', requireAdmin, paymentsController.create);
router.post('/import', requireAdmin, paymentsController.importBatch);

export default router;
