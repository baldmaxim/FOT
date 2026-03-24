import { Router } from 'express';
import multer from 'multer';
import { skudController } from '../controllers/skud.controller.js';
import { authenticate, requireMinPosition, requireOrganization, require2FA, injectOrganizationFromQuery } from '../middleware/auth.js';

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

// GET /api/skud/organizations - организации с событиями СКУД (super_admin)
router.get(
  '/organizations',
  requireMinPosition('super_admin') as any,
  skudController.getOrganizations as any
);

// GET /api/skud/dashboard-stats - аналитика дашборда (header+)
router.get(
  '/dashboard-stats',
  requireMinPosition('header') as any,
  skudController.getDashboardStats as any
);

// GET /api/skud/discipline - аналитика дисциплины по всей организации (admin+)
router.get(
  '/discipline',
  requireMinPosition('admin') as any,
  skudController.getDisciplineViolations as any
);

// GET /api/skud/daily-summary - дневные сводки (header+)
router.get(
  '/daily-summary',
  requireMinPosition('header') as any,
  skudController.getDailySummary as any
);

// GET /api/skud/employee-events/:employeeId - события конкретного сотрудника (worker+)
router.get(
  '/employee-events/:employeeId',
  requireMinPosition('worker') as any,
  skudController.getEmployeeEvents as any
);

// GET /api/skud/events - события СКУД (header+)
router.get(
  '/events',
  requireMinPosition('header') as any,
  skudController.getEvents as any
);

// GET /api/skud/access-points - точки доступа (header+)
router.get(
  '/access-points',
  requireMinPosition('header') as any,
  skudController.getAccessPoints as any
);

// GET /api/skud/access-point-settings - настройки точек доступа для отдела (worker+)
router.get(
  '/access-point-settings',
  requireMinPosition('worker') as any,
  skudController.getAccessPointSettings as any
);

// PUT /api/skud/access-point-settings - сохранение настроек точек доступа (admin+)
router.put(
  '/access-point-settings',
  requireMinPosition('admin') as any,
  skudController.saveAccessPointSettings as any
);

// POST /api/skud/sync-access-points - обновление точек доступа из Sigur (admin+)
router.post(
  '/sync-access-points',
  requireMinPosition('admin') as any,
  skudController.syncAccessPoints as any
);

// GET /api/skud/presence - статус присутствия сотрудников (header+)
router.get(
  '/presence',
  requireMinPosition('header') as any,
  skudController.getPresence as any
);

// POST /api/skud/import - импорт (admin+, требуется 2FA)
router.post(
  '/import',
  requireMinPosition('admin') as any,
  require2FA as any,
  upload.single('file'),
  skudController.import as any
);

// POST /api/skud/sync-employee - синхронизация событий одного сотрудника из Sigur (admin+)
router.post(
  '/sync-employee',
  requireMinPosition('admin') as any,
  skudController.syncEmployee as any
);

// POST /api/skud/clean-duplicates - бэкфилл хэшей + удаление дублей (super_admin)
router.post(
  '/clean-duplicates',
  requireMinPosition('super_admin') as any,
  skudController.cleanDuplicates as any
);

// DELETE /api/skud/clear - очистка данных (super_admin, требуется 2FA)
router.delete(
  '/clear',
  requireMinPosition('super_admin') as any,
  require2FA as any,
  skudController.clear as any
);

export default router;
