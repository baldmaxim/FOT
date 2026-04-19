import { Router } from 'express';
import multer from 'multer';
import { employeesController } from '../controllers/employees.controller.js';
import { employeeEnrichController } from '../controllers/employee-enrich.controller.js';
import { employeeSalaryEnrichController } from '../controllers/employee-enrich-salary.controller.js';
import { employeeSalaryHistoryController } from '../controllers/employee-enrich-salary-history.controller.js';
import { authenticate, requireAnyPageAccess, requireCritical2FA } from '../middleware/auth.js';
import { importLimiter } from '../middleware/rateLimit.js';

const router = Router();

// Настройка multer для загрузки файлов в память
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB max
  },
  fileFilter: (_req, file, cb) => {
    const allowedMimes = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
      'application/vnd.ms-excel', // xls
    ];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Недопустимый формат файла. Разрешены только .xlsx и .xls'));
    }
  },
});

// Все роуты требуют аутентификации
router.use(authenticate);

// GET /api/employees - получение списка (worker+)
router.get(
  '/',
  requireAnyPageAccess(['/employees', '/staff-control'], 'view'),
  employeesController.getAll
);

// POST /api/employees/enrich - обогащение данных из Excel (header+, требуется 2FA)
router.post(
  '/enrich',
  requireAnyPageAccess(['/employees', '/staff-control'], 'edit'),
  requireCritical2FA,
  importLimiter,
  upload.single('file'),
  employeeEnrichController.enrich
);

// POST /api/employees/enrich-salary - импорт окладов и ставок из Excel (header+, требуется 2FA)
router.post(
  '/enrich-salary',
  requireAnyPageAccess(['/employees', '/staff-control'], 'edit'),
  requireCritical2FA,
  importLimiter,
  upload.single('file'),
  employeeSalaryEnrichController.enrichSalary
);

// POST /api/employees/enrich-salary-history - импорт истории окладов из Excel (header+, требуется 2FA)
router.post(
  '/enrich-salary-history',
  requireAnyPageAccess(['/employees', '/staff-control'], 'edit'),
  requireCritical2FA,
  importLimiter,
  upload.single('file'),
  employeeSalaryHistoryController.enrichSalaryHistory
);

// DELETE /api/employees/all - удаление ВСЕХ (super_admin, только для разработки)
router.delete(
  '/all',
  requireAnyPageAccess(['/employees'], 'edit'),
  requireCritical2FA,
  employeesController.deleteAll
);

// GET /api/employees/counts - счётчики по отделам + статусам (worker+, кэш 60с)
router.get(
  '/counts',
  requireAnyPageAccess(['/employees', '/staff-control'], 'view'),
  employeesController.getCounts
);

// GET /api/employees/:id/history - история событий сотрудника (worker+)
router.get(
  '/:id/history',
  requireAnyPageAccess(['/employee', '/employees', '/staff-control'], 'view'),
  employeesController.getHistory
);

// PUT /api/employees/:id/history/:eventId - редактирование записи истории (admin+, 2FA)
router.put(
  '/:id/history/:eventId',
  requireAnyPageAccess(['/employees', '/staff-control'], 'edit'),
  requireCritical2FA,
  employeesController.updateHistoryEvent
);

// DELETE /api/employees/:id/history/:eventId - удаление записи истории (admin+, 2FA)
router.delete(
  '/:id/history/:eventId',
  requireAnyPageAccess(['/employees', '/staff-control'], 'edit'),
  requireCritical2FA,
  employeesController.deleteHistoryEvent
);

// GET /api/employees/:id - получение одного (worker+)
router.get(
  '/:id',
  requireAnyPageAccess(['/employee', '/employees', '/staff-control'], 'view'),
  employeesController.getById
);

// POST /api/employees - создание (header+, требуется 2FA)
router.post(
  '/',
  requireAnyPageAccess(['/employees', '/staff-control'], 'edit'),
  requireCritical2FA,
  employeesController.create
);

// POST /api/employees/batch-move - массовый перевод в отдел (header+, требуется 2FA)
router.post(
  '/batch-move',
  requireAnyPageAccess(['/employees', '/staff-control'], 'edit'),
  requireCritical2FA,
  employeesController.batchMoveEmployees
);

// PUT /api/employees/:id - обновление (header+, требуется 2FA)
router.put(
  '/:id',
  requireAnyPageAccess(['/employees', '/staff-control'], 'edit'),
  requireCritical2FA,
  employeesController.update
);

// DELETE /api/employees/:id - удаление (admin+, требуется 2FA)
router.delete(
  '/:id',
  requireAnyPageAccess(['/employees', '/staff-control'], 'edit'),
  requireCritical2FA,
  employeesController.delete
);

// POST /api/employees/:id/archive - архивация (header+)
router.post(
  '/:id/archive',
  requireAnyPageAccess(['/employees', '/staff-control'], 'edit'),
  employeesController.archive
);

// POST /api/employees/:id/restore - восстановление (header+)
router.post(
  '/:id/restore',
  requireAnyPageAccess(['/employees', '/staff-control'], 'edit'),
  employeesController.restore
);

// POST /api/employees/:id/fire - уволить (header+)
router.post(
  '/:id/fire',
  requireAnyPageAccess(['/employees', '/staff-control'], 'edit'),
  requireCritical2FA,
  employeesController.fire
);

// POST /api/employees/:id/rehire - восстановить на работу (header+)
router.post(
  '/:id/rehire',
  requireAnyPageAccess(['/employees', '/staff-control'], 'edit'),
  employeesController.rehire
);

// POST /api/employees/:id/move-department - переместить в отдел (header+)
router.post(
  '/:id/move-department',
  requireAnyPageAccess(['/employees', '/staff-control'], 'edit'),
  requireCritical2FA,
  employeesController.moveDepartment
);

// POST /api/employees/:id/change-salary - изменить оклад (admin+, требуется 2FA)
router.post(
  '/:id/change-salary',
  requireAnyPageAccess(['/employees', '/staff-control'], 'edit'),
  requireCritical2FA,
  employeesController.changeSalary
);

// POST /api/employees/:id/change-position - сменить должность (admin+, требуется 2FA)
router.post(
  '/:id/change-position',
  requireAnyPageAccess(['/employees', '/staff-control'], 'edit'),
  requireCritical2FA,
  employeesController.changePosition
);

// POST /api/employees/:id/change-category - изменить категорию труда (header+)
router.post(
  '/:id/change-category',
  requireAnyPageAccess(['/employees', '/staff-control'], 'edit'),
  employeesController.changeCategory
);

export default router;
