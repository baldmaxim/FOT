import { Router } from 'express';
import { scheduleController } from '../controllers/schedule.controller.js';
import { authenticate, requireAnyPageAccess } from '../middleware/auth.js';
import { invalidateCaches } from '../middleware/cacheResponse.js';

const router = Router();

router.use(authenticate);

// Write-through invalidation: любой успешный POST/PUT/PATCH/DELETE на /api/schedules/*
// сбрасывает серверные LRU-кэши табеля. Без этого правка шаблона (например, нового
// weekend_full_day_threshold) не отразится в табеле в течение 5 минут — клиент
// получит закэшированный ответ со старым порогом, и покраска полного дня останется
// прежней даже после F5.
router.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        invalidateCaches(
          'timesheet',
          'timesheet:today',
          'timesheet:overview',
          'timesheet:overview:today',
          'timesheet:search',
        );
      }
    });
  }
  next();
});

// Шаблоны графиков (CRUD) — открыты также менеджерам через виртуальную страницу /admin/schedules/templates
router.get('/', requireAnyPageAccess(['/admin/schedules', '/admin/schedules/templates', '/staff-control'], 'view'), scheduleController.list);
router.post('/', requireAnyPageAccess(['/admin/schedules', '/admin/schedules/templates', '/staff-control'], 'edit'), scheduleController.create);
router.put('/:id', requireAnyPageAccess(['/admin/schedules', '/admin/schedules/templates', '/staff-control'], 'edit'), scheduleController.update);
router.delete('/:id', requireAnyPageAccess(['/admin/schedules', '/admin/schedules/templates', '/staff-control'], 'edit'), scheduleController.remove);

// Назначения сотрудникам / объектам — менеджеру доступны только через автодоступ /staff-control
router.get('/employees', requireAnyPageAccess(['/admin/schedules', '/staff-control'], 'view'), scheduleController.listEmployeeAssignments);
router.get('/objects', requireAnyPageAccess(['/admin/schedules', '/staff-control'], 'view'), scheduleController.listObjectAssignments);
router.put('/employee/:employeeId', requireAnyPageAccess(['/admin/schedules', '/staff-control/schedule'], 'edit'), scheduleController.assignEmployee);
router.patch('/employee/:employeeId/assignment', requireAnyPageAccess(['/admin/schedules', '/staff-control/schedule'], 'edit'), scheduleController.fixEmployeeAssignment);
// История назначений конкретного сотрудника (все строки: открытые, закрытые, будущие).
// Используется блоком «История назначений» в модалке «График работы».
router.get('/employee/:employeeId/history', requireAnyPageAccess(['/admin/schedules', '/staff-control'], 'view'), scheduleController.listEmployeeHistory);
// Удаление одной конкретной записи из истории. Закрытие активной записи делает старый
// router.delete('/employee/:employeeId') — здесь именно DELETE-by-id.
router.delete('/employee/:employeeId/assignment/:assignmentId', requireAnyPageAccess(['/admin/schedules', '/staff-control/schedule'], 'edit'), scheduleController.deleteEmployeeAssignment);
router.put('/object/:objectId', requireAnyPageAccess(['/admin/schedules', '/staff-control/schedule'], 'edit'), scheduleController.assignObject);
router.delete('/employee/:employeeId', requireAnyPageAccess(['/admin/schedules', '/staff-control/schedule'], 'edit'), scheduleController.removeEmployeeAssignment);
router.delete('/object/:objectId', requireAnyPageAccess(['/admin/schedules', '/staff-control/schedule'], 'edit'), scheduleController.removeObjectAssignment);
router.post('/brigades/bulk', requireAnyPageAccess(['/admin/schedules', '/staff-control/schedule'], 'edit'), scheduleController.bulkApplyToBrigades);

// Resolve
router.get('/resolve/:empId', requireAnyPageAccess(['/employee', '/timesheet', '/timesheet-hr', '/staff-control'], 'view'), scheduleController.resolve);
router.get('/resolve-bulk', requireAnyPageAccess(['/timesheet', '/timesheet-hr', '/staff-control'], 'view'), scheduleController.resolveBulk);

export default router;
