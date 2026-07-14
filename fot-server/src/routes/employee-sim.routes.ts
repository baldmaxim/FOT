import { Router } from 'express';
import { employeeSimController } from '../controllers/employee-sim.controller.js';
import { authenticate, requirePageAccess } from '../middleware/auth.js';
import { noStore } from '../middleware/noStore.js';
import { forwardingLimiter } from '../middleware/rateLimit.js';

// ЛК сотрудника «Моя SIM»: данные только по СВОИМ номерам (req.user.employee_id),
// телефонные данные не кэшируются (noStore).

const router = Router();

router.use(authenticate);
router.use(noStore);

// Телефон в блоке «Информация» на главной ЛК — всем, у кого есть сам ЛК.
router.get('/numbers', requirePageAccess('/employee', 'view'), employeeSimController.getMyNumbers);
router.get('/', requirePageAccess('/employee/sim', 'view'), employeeSimController.getMySim);
router.get('/usage', requirePageAccess('/employee/sim', 'view'), employeeSimController.getMyUsage);

// Переадресация: чтение — под view, запись (write-вызов в МТС) — под edit
// (право edit = рубильник самообслуживания) + лимит 5/час на пользователя.
router.get('/forwarding', requirePageAccess('/employee/sim', 'view'), employeeSimController.getMyForwarding);
router.get('/forwarding/status', requirePageAccess('/employee/sim', 'view'), employeeSimController.getMyForwardingStatus);
router.post('/forwarding', requirePageAccess('/employee/sim', 'edit'), forwardingLimiter, employeeSimController.setMyForwarding);
router.post('/forwarding/delete', requirePageAccess('/employee/sim', 'edit'), forwardingLimiter, employeeSimController.deleteMyForwarding);

export default router;
