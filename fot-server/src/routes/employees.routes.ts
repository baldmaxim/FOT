import { Router } from 'express';
import multer from 'multer';
import { employeesController } from '../controllers/employees.controller.js';
import { employeeEnrichController } from '../controllers/employee-enrich.controller.js';
import { authenticate, requirePosition, requireOrganization, requireCritical2FA, injectOrganizationFromQuery } from '../middleware/auth.js';
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

// Все роуты требуют аутентификации и организации
router.use(authenticate);
router.use(injectOrganizationFromQuery);
router.use(requireOrganization);

// GET /api/employees - получение списка (worker+)
router.get(
  '/',
  requirePosition('worker', 'header', 'hr', 'admin', 'super_admin'),
  employeesController.getAll
);

// POST /api/employees/import - импорт из Excel (header+, требуется 2FA)
router.post(
  '/import',
  requirePosition('header', 'hr', 'admin', 'super_admin'),
  requireCritical2FA,
  importLimiter,
  upload.single('file'),
  employeesController.import
);

// POST /api/employees/enrich - обогащение данных из Excel (header+, требуется 2FA)
router.post(
  '/enrich',
  requirePosition('header', 'hr', 'admin', 'super_admin'),
  requireCritical2FA,
  importLimiter,
  upload.single('file'),
  employeeEnrichController.enrich
);

// DELETE /api/employees/all - удаление ВСЕХ (super_admin, только для разработки)
router.delete(
  '/all',
  requirePosition('super_admin'),
  requireCritical2FA,
  employeesController.deleteAll
);

// GET /api/employees/:id/history - история событий сотрудника (worker+)
router.get(
  '/:id/history',
  requirePosition('worker', 'header', 'hr', 'admin', 'super_admin'),
  employeesController.getHistory
);

// GET /api/employees/:id - получение одного (worker+)
router.get(
  '/:id',
  requirePosition('worker', 'header', 'hr', 'admin', 'super_admin'),
  employeesController.getById
);

// POST /api/employees - создание (header+, требуется 2FA)
router.post(
  '/',
  requirePosition('header', 'hr', 'admin', 'super_admin'),
  requireCritical2FA,
  employeesController.create
);

// PUT /api/employees/:id - обновление (header+, требуется 2FA)
router.put(
  '/:id',
  requirePosition('header', 'hr', 'admin', 'super_admin'),
  requireCritical2FA,
  employeesController.update
);

// DELETE /api/employees/:id - удаление (admin+, требуется 2FA)
router.delete(
  '/:id',
  requirePosition('admin', 'super_admin'),
  requireCritical2FA,
  employeesController.delete
);

// POST /api/employees/:id/archive - архивация (header+)
router.post(
  '/:id/archive',
  requirePosition('header', 'hr', 'admin', 'super_admin'),
  employeesController.archive
);

// POST /api/employees/:id/restore - восстановление (header+)
router.post(
  '/:id/restore',
  requirePosition('header', 'hr', 'admin', 'super_admin'),
  employeesController.restore
);

// POST /api/employees/:id/fire - уволить (header+)
router.post(
  '/:id/fire',
  requirePosition('header', 'hr', 'admin', 'super_admin'),
  employeesController.fire
);

// POST /api/employees/:id/rehire - восстановить на работу (header+)
router.post(
  '/:id/rehire',
  requirePosition('header', 'hr', 'admin', 'super_admin'),
  employeesController.rehire
);

// POST /api/employees/:id/move-department - переместить в отдел (header+)
router.post(
  '/:id/move-department',
  requirePosition('header', 'hr', 'admin', 'super_admin'),
  employeesController.moveDepartment
);

export default router;
