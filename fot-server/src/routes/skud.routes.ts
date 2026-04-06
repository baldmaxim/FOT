import { Router } from 'express';
import multer from 'multer';
import { skudController } from '../controllers/skud.controller.js';
import { authenticate, requireMinPosition, requireCritical2FA } from '../middleware/auth.js';
import { importLimiter } from '../middleware/rateLimit.js';
import { cacheResponse } from '../middleware/cacheResponse.js';

const presenceCache = cacheResponse(
  (req) => `presence:${req.query.department_id || 'all'}`,
  30_000,
);

const dashboardCache = cacheResponse(
  (req) => `dashboard:${req.query.department_id}:${req.query.period}:${req.query.month || ''}`,
  60_000,
);

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

// Все роуты требуют аутентификации
router.use(authenticate);

// GET /api/skud/organizations - организации с событиями СКУД (super_admin)
router.get(
  '/organizations',
  requireMinPosition('super_admin'),
  skudController.getOrganizations
);

// GET /api/skud/dashboard-stats - аналитика дашборда (header+, кэш 60с)
router.get(
  '/dashboard-stats',
  requireMinPosition('header'),
  dashboardCache,
  skudController.getDashboardStats
);

// GET /api/skud/discipline - аналитика дисциплины по всей организации (header+)
router.get(
  '/discipline',
  requireMinPosition('header'),
  skudController.getDisciplineViolations
);

// GET /api/skud/daily-summary - дневные сводки (header+)
router.get(
  '/daily-summary',
  requireMinPosition('header'),
  skudController.getDailySummary
);

// GET /api/skud/employee-events/:employeeId - события конкретного сотрудника (worker+)
router.get(
  '/employee-events/:employeeId',
  requireMinPosition('worker'),
  skudController.getEmployeeEvents
);

// GET /api/skud/events - события СКУД (header+)
router.get(
  '/events',
  requireMinPosition('header'),
  skudController.getEvents
);

// GET /api/skud/access-points - точки доступа (header+)
router.get(
  '/access-points',
  requireMinPosition('header'),
  skudController.getAccessPoints
);

// GET /api/skud/access-point-settings - настройки точек доступа для отдела (worker+)
router.get(
  '/access-point-settings',
  requireMinPosition('worker'),
  skudController.getAccessPointSettings
);

// PUT /api/skud/access-point-settings - сохранение настроек точек доступа (admin+)
router.put(
  '/access-point-settings',
  requireMinPosition('admin'),
  skudController.saveAccessPointSettings
);

// POST /api/skud/sync-access-points - обновление точек доступа из Sigur (admin+)
router.post(
  '/sync-access-points',
  requireMinPosition('admin'),
  skudController.syncAccessPoints
);

// GET /api/skud/presence - статус присутствия сотрудников (header+, кэш 30с)
router.get(
  '/presence',
  requireMinPosition('header'),
  presenceCache,
  skudController.getPresence
);

// POST /api/skud/import - импорт (admin+, требуется 2FA)
router.post(
  '/import',
  requireMinPosition('admin'),
  requireCritical2FA,
  importLimiter,
  upload.single('file'),
  skudController.import
);

// POST /api/skud/sync-employee - синхронизация событий одного сотрудника из Sigur (admin+)
router.post(
  '/sync-employee',
  requireMinPosition('admin'),
  skudController.syncEmployee
);

// POST /api/skud/clean-duplicates - бэкфилл хэшей + удаление дублей (super_admin, требуется 2FA)
router.post(
  '/clean-duplicates',
  requireMinPosition('super_admin'),
  requireCritical2FA,
  skudController.cleanDuplicates
);

// DELETE /api/skud/clear - очистка данных (super_admin, требуется 2FA)
router.delete(
  '/clear',
  requireMinPosition('super_admin'),
  requireCritical2FA,
  skudController.clear
);

export default router;
