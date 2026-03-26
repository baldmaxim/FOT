import { Router } from 'express';
import { paymentsController } from '../controllers/payments.controller.js';
import { authenticate, requirePosition, requireOrganization, injectOrganizationFromQuery } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);
router.use(injectOrganizationFromQuery);
router.use(requireOrganization);

router.get('/my', requirePosition('worker', 'header', 'hr', 'admin', 'super_admin'), paymentsController.getMy);
router.get('/employee/:empId', requirePosition('hr', 'admin', 'super_admin'), paymentsController.getByEmployee);
router.post('/', requirePosition('hr', 'admin', 'super_admin'), paymentsController.create);
router.post('/import', requirePosition('hr', 'admin', 'super_admin'), paymentsController.importBatch);

export default router;
