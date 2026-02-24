import { Router } from 'express';
import multer from 'multer';
import { employeesController } from '../controllers/employees.controller.js';
import { authenticate, requirePosition, requireOrganization, require2FA, injectOrganizationFromQuery } from '../middleware/auth.js';

const router = Router();

// Настройка multer для загрузки файлов в память
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB max
  },
  fileFilter: (req, file, cb) => {
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
router.use(authenticate as any);
router.use(injectOrganizationFromQuery as any);
router.use(requireOrganization as any);

// GET /api/employees - получение списка (worker+)
router.get(
  '/',
  requirePosition('worker', 'header', 'admin', 'super_admin') as any,
  employeesController.getAll as any
);

// POST /api/employees/import - импорт из Excel (header+, требуется 2FA)
router.post(
  '/import',
  requirePosition('header', 'admin', 'super_admin') as any,
  require2FA as any,
  upload.single('file'),
  employeesController.import as any
);

// DELETE /api/employees/all - удаление ВСЕХ (super_admin, только для разработки)
router.delete(
  '/all',
  requirePosition('super_admin') as any,
  require2FA as any,
  employeesController.deleteAll as any
);

// GET /api/employees/:id/history - история событий сотрудника (worker+)
router.get(
  '/:id/history',
  requirePosition('worker', 'header', 'admin', 'super_admin') as any,
  employeesController.getHistory as any
);

// GET /api/employees/:id - получение одного (worker+)
router.get(
  '/:id',
  requirePosition('worker', 'header', 'admin', 'super_admin') as any,
  employeesController.getById as any
);

// POST /api/employees - создание (header+, требуется 2FA)
router.post(
  '/',
  requirePosition('header', 'admin', 'super_admin') as any,
  require2FA as any,
  employeesController.create as any
);

// PUT /api/employees/:id - обновление (header+, требуется 2FA)
router.put(
  '/:id',
  requirePosition('header', 'admin', 'super_admin') as any,
  require2FA as any,
  employeesController.update as any
);

// DELETE /api/employees/:id - удаление (admin+, требуется 2FA)
router.delete(
  '/:id',
  requirePosition('admin', 'super_admin') as any,
  require2FA as any,
  employeesController.delete as any
);

// POST /api/employees/:id/archive - архивация (header+)
router.post(
  '/:id/archive',
  requirePosition('header', 'admin', 'super_admin') as any,
  employeesController.archive as any
);

// POST /api/employees/:id/restore - восстановление (header+)
router.post(
  '/:id/restore',
  requirePosition('header', 'admin', 'super_admin') as any,
  employeesController.restore as any
);

// POST /api/employees/:id/fire - уволить (header+)
router.post(
  '/:id/fire',
  requirePosition('header', 'admin', 'super_admin') as any,
  employeesController.fire as any
);

// POST /api/employees/:id/rehire - восстановить на работу (header+)
router.post(
  '/:id/rehire',
  requirePosition('header', 'admin', 'super_admin') as any,
  employeesController.rehire as any
);

// POST /api/employees/:id/move-department - переместить в отдел (header+)
router.post(
  '/:id/move-department',
  requirePosition('header', 'admin', 'super_admin') as any,
  employeesController.moveDepartment as any
);

export default router;
