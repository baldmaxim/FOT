import { Router } from 'express';
import multer from 'multer';
import { skudController } from '../controllers/skud.controller.js';
import { authenticate, requireRole, requireOrganization, require2FA, injectOrganizationFromQuery } from '../middleware/auth.js';

const router = Router();

// Настройка multer
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max для СКУД (больше данных)
  },
  fileFilter: (_req, file, cb) => {
    const allowedMimes = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
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

// GET /api/skud/daily-summary - дневные сводки (viewer+)
router.get(
  '/daily-summary',
  requireRole('viewer', 'manager', 'owner', 'super_admin') as any,
  skudController.getDailySummary as any
);

// GET /api/skud/employee-events/:employeeId - события конкретного сотрудника (viewer+)
router.get(
  '/employee-events/:employeeId',
  requireRole('viewer', 'manager', 'owner', 'super_admin') as any,
  skudController.getEmployeeEvents as any
);

// GET /api/skud/events - события СКУД (viewer+)
router.get(
  '/events',
  requireRole('viewer', 'manager', 'owner', 'super_admin') as any,
  skudController.getEvents as any
);

// GET /api/skud/access-points - точки доступа (viewer+)
router.get(
  '/access-points',
  requireRole('viewer', 'manager', 'owner', 'super_admin') as any,
  skudController.getAccessPoints as any
);

// GET /api/skud/access-point-settings - настройки точек доступа для отдела (viewer+)
router.get(
  '/access-point-settings',
  requireRole('viewer', 'manager', 'owner', 'super_admin') as any,
  skudController.getAccessPointSettings as any
);

// PUT /api/skud/access-point-settings - сохранение настроек точек доступа (manager+)
router.put(
  '/access-point-settings',
  requireRole('manager', 'owner', 'super_admin') as any,
  skudController.saveAccessPointSettings as any
);

// GET /api/skud/presence - статус присутствия сотрудников (header+)
router.get(
  '/presence',
  requireRole('header', 'viewer', 'manager', 'owner', 'super_admin') as any,
  skudController.getPresence as any
);

// POST /api/skud/import - импорт (manager+)
// TODO: вернуть require2FA после тестирования
router.post(
  '/import',
  requireRole('manager', 'owner', 'super_admin') as any,
  upload.single('file'),
  skudController.import as any
);

// POST /api/skud/sync-employee - синхронизация событий одного сотрудника из Sigur (manager+)
router.post(
  '/sync-employee',
  requireRole('manager', 'owner', 'super_admin') as any,
  skudController.syncEmployee as any
);

// POST /api/skud/clean-duplicates - бэкфилл хэшей + удаление дублей (owner+)
router.post(
  '/clean-duplicates',
  requireRole('owner', 'super_admin') as any,
  skudController.cleanDuplicates as any
);

// DELETE /api/skud/clear - очистка данных (owner+, требуется 2FA)
router.delete(
  '/clear',
  requireRole('owner', 'super_admin') as any,
  require2FA as any,
  skudController.clear as any
);

export default router;
