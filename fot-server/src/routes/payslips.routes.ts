import { Router } from 'express';
import { payslipsController } from '../controllers/payslips.controller.js';
import { authenticate, requirePageAccess } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

router.get('/my', requirePageAccess('/employee', 'view'), payslipsController.getMy);
router.get('/employee/:empId', requirePageAccess('/admin/payslips', 'view'), payslipsController.getByEmployee);
router.post('/', requirePageAccess('/admin/payslips', 'edit'), payslipsController.create);
router.post('/import', requirePageAccess('/admin/payslips', 'edit'), payslipsController.importBatch);
router.post('/generate', requirePageAccess('/admin/payslips', 'edit'), payslipsController.generate);

export default router;
