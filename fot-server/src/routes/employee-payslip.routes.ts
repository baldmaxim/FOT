import { Router } from 'express';
import { employeePayslipController } from '../controllers/employee-payslip.controller.js';
import { authenticate, requirePageAccess } from '../middleware/auth.js';
import { noStore } from '../middleware/noStore.js';

// ЛК сотрудника «Расчётный лист» (миграция 353): только СВОЙ листок (req.user.employee_id), без HTTP-кэша.
// Страницу открывает только список employee_payslip_access или настройка «всем» — роль не даёт.

const router = Router();

router.use(authenticate);
router.use(noStore);

router.get('/', requirePageAccess('/employee/payslip', 'view'), employeePayslipController.getSummary);
router.get('/:month', requirePageAccess('/employee/payslip', 'view'), employeePayslipController.getMonth);

export default router;
