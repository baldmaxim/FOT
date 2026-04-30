import { Router } from 'express';
import { scheduleController } from '../controllers/schedule.controller.js';
import { authenticate, requireAnyPageAccess } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

// Шаблоны графиков (CRUD) — открыты также менеджерам через виртуальную страницу /admin/schedules/templates
router.get('/', requireAnyPageAccess(['/admin/schedules', '/admin/schedules/templates', '/staff-control'], 'view'), scheduleController.list);
router.post('/', requireAnyPageAccess(['/admin/schedules', '/admin/schedules/templates', '/staff-control'], 'edit'), scheduleController.create);
router.put('/:id', requireAnyPageAccess(['/admin/schedules', '/admin/schedules/templates', '/staff-control'], 'edit'), scheduleController.update);
router.delete('/:id', requireAnyPageAccess(['/admin/schedules', '/admin/schedules/templates', '/staff-control'], 'edit'), scheduleController.remove);

// Назначения сотрудникам / объектам — менеджеру доступны только через автодоступ /staff-control
router.get('/employees', requireAnyPageAccess(['/admin/schedules', '/staff-control'], 'view'), scheduleController.listEmployeeAssignments);
router.get('/objects', requireAnyPageAccess(['/admin/schedules', '/staff-control'], 'view'), scheduleController.listObjectAssignments);
router.put('/employee/:employeeId', requireAnyPageAccess(['/admin/schedules', '/staff-control'], 'edit'), scheduleController.assignEmployee);
router.put('/object/:objectId', requireAnyPageAccess(['/admin/schedules', '/staff-control'], 'edit'), scheduleController.assignObject);
router.delete('/employee/:employeeId', requireAnyPageAccess(['/admin/schedules', '/staff-control'], 'edit'), scheduleController.removeEmployeeAssignment);
router.delete('/object/:objectId', requireAnyPageAccess(['/admin/schedules', '/staff-control'], 'edit'), scheduleController.removeObjectAssignment);
router.post('/brigades/bulk', requireAnyPageAccess(['/admin/schedules', '/staff-control'], 'edit'), scheduleController.bulkApplyToBrigades);

// Resolve
router.get('/resolve/:empId', requireAnyPageAccess(['/employee', '/timesheet', '/timesheet-hr', '/staff-control'], 'view'), scheduleController.resolve);
router.get('/resolve-bulk', requireAnyPageAccess(['/timesheet', '/timesheet-hr', '/staff-control'], 'view'), scheduleController.resolveBulk);

export default router;
