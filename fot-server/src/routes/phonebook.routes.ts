import { Router } from 'express';
import { employeeSimController } from '../controllers/employee-sim.controller.js';
import { authenticate, requirePageAccess } from '../middleware/auth.js';
import { noStore } from '../middleware/noStore.js';

// «Телефонная книга» в ЛК: список привязанных номеров активных сотрудников
// (номер/ФИО/должность/отдел). Без карточек и статистики.

const router = Router();

router.use(authenticate);
router.use(noStore);

router.get('/', requirePageAccess('/employee/phonebook', 'view'), employeeSimController.getPhonebook);

export default router;
