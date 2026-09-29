import { Router } from 'express';
import { authenticate, requireAnyPageAccess, requirePageAccess } from '../middleware/auth.js';
import { noStore } from '../middleware/noStore.js';
import { timesheetObjectController } from '../controllers/timesheet-object.controller.js';

const router = Router();

router.use(authenticate);
// Выбор меняется на лету: ни браузер, ни прокси не должны отдавать старое состояние.
router.use(noStore);

// Сам сотрудник в ЛК. Сотрудник берётся из JWT (req.user.employee_id), чужого не передать;
// у '/employee' нет права edit (supports_edit: false), поэтому гейт — просмотр ЛК.
router.get('/me', requirePageAccess('/employee', 'view'), timesheetObjectController.getMine);
router.put('/me', requirePageAccess('/employee', 'view'), timesheetObjectController.updateMine);

// Тот, кто ведёт табель сотрудника (табельщица, руководитель отдела): гейт — как у правок
// табеля, сотрудник — canEditEmployeeTimesheetInScope в контроллере.
router.get(
  '/employees/:id',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr'], 'edit'),
  timesheetObjectController.getForEmployee,
);
router.put(
  '/employees/:id',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr'], 'edit'),
  timesheetObjectController.updateForEmployee,
);

export default router;
