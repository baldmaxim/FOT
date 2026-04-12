import { Router } from 'express';
import multer from 'multer';
import { skudController } from '../controllers/skud.controller.js';
import { authenticate, requireAnyPageAccess, requirePageAccess, requireCritical2FA } from '../middleware/auth.js';
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

// GET /api/skud/dashboard-stats - аналитика дашборда (header+, кэш 60с)
router.get(
  '/dashboard-stats',
  requirePageAccess('/dashboard', 'view'),
  dashboardCache,
  skudController.getDashboardStats
);

// GET /api/skud/discipline - аналитика дисциплины по всей организации (header+)
router.get(
  '/discipline',
  requirePageAccess('/discipline', 'view'),
  skudController.getDisciplineViolations
);

router.get(
  '/discipline/export',
  requirePageAccess('/discipline', 'view'),
  skudController.exportDisciplineViolations
);

// GET /api/skud/daily-summary - дневные сводки (header+)
router.get(
  '/daily-summary',
  requirePageAccess('/skud-db', 'view'),
  skudController.getDailySummary
);

// GET /api/skud/employee-events/:employeeId - события конкретного сотрудника (worker+)
router.get(
  '/employee-events/:employeeId',
  requireAnyPageAccess(
    ['/employee', '/employee/timesheet', '/employee/history', '/employees', '/staff-control'],
    'view',
  ),
  skudController.getEmployeeEvents
);

router.get(
  '/employee-events/:employeeId/export',
  requireAnyPageAccess(
    ['/employee', '/employee/timesheet', '/employee/history', '/employees', '/staff-control'],
    'view',
  ),
  skudController.exportEmployeeEvents
);

// GET /api/skud/events - события СКУД (header+)
router.get(
  '/events',
  requirePageAccess('/skud-db', 'view'),
  skudController.getEvents
);

// GET /api/skud/access-points - точки доступа (header+)
router.get(
  '/access-points',
  requireAnyPageAccess(['/skud-settings', '/skud-travel'], 'view'),
  skudController.getAccessPoints
);

// GET /api/skud/access-point-settings - настройки точек доступа для отдела (worker+)
router.get(
  '/access-point-settings',
  requireAnyPageAccess(['/employee', '/employee/timesheet', '/employees', '/staff-control', '/skud-settings'], 'view'),
  skudController.getAccessPointSettings
);

// GET /api/skud/travel-objects - объекты для группировки точек доступа (header+)
router.get(
  '/travel-objects',
  requirePageAccess('/skud-settings', 'view'),
  skudController.getTravelObjects
);

// POST /api/skud/travel-objects - создать объект (admin+)
router.post(
  '/travel-objects',
  requirePageAccess('/skud-settings', 'edit'),
  skudController.createTravelObject
);

// PUT /api/skud/travel-objects/:id - обновить объект и его точки доступа (admin+)
router.put(
  '/travel-objects/:id',
  requirePageAccess('/skud-settings', 'edit'),
  skudController.updateTravelObject
);

// DELETE /api/skud/travel-objects/:id - удалить объект (admin+)
router.delete(
  '/travel-objects/:id',
  requirePageAccess('/skud-settings', 'edit'),
  skudController.deleteTravelObject
);

// GET /api/skud/travel-routes - маршруты между объектами (header+)
router.get(
  '/travel-routes',
  requirePageAccess('/skud-settings', 'view'),
  skudController.getTravelRoutes
);

// POST /api/skud/travel-routes - создать маршрут (admin+)
router.post(
  '/travel-routes',
  requirePageAccess('/skud-settings', 'edit'),
  skudController.createTravelRoute
);

// PUT /api/skud/travel-routes/:id - обновить маршрут (admin+)
router.put(
  '/travel-routes/:id',
  requirePageAccess('/skud-settings', 'edit'),
  skudController.updateTravelRoute
);

// DELETE /api/skud/travel-routes/:id - удалить маршрут (admin+)
router.delete(
  '/travel-routes/:id',
  requirePageAccess('/skud-settings', 'edit'),
  skudController.deleteTravelRoute
);

// GET /api/skud/travel-segments - предрасчитанные передвижения сотрудников (header+)
router.get(
  '/travel-segments',
  requirePageAccess('/skud-travel', 'view'),
  skudController.getTravelSegments
);

// POST /api/skud/travel-segments/rebuild - принудительный пересчёт передвижений (header+)
router.post(
  '/travel-segments/rebuild',
  requirePageAccess('/skud-travel', 'edit'),
  skudController.rebuildTravelSegments
);

// PUT /api/skud/access-point-settings - сохранение настроек точек доступа (admin+)
router.put(
  '/access-point-settings',
  requirePageAccess('/skud-settings', 'edit'),
  skudController.saveAccessPointSettings
);

// POST /api/skud/sync-access-points - обновление точек доступа из Sigur (admin+)
router.post(
  '/sync-access-points',
  requirePageAccess('/skud-settings', 'edit'),
  skudController.syncAccessPoints
);

// GET /api/skud/presence - статус присутствия сотрудников (header+, кэш 30с)
router.get(
  '/presence',
  requireAnyPageAccess(['/dashboard', '/employees', '/staff-control'], 'view'),
  presenceCache,
  skudController.getPresence
);

// POST /api/skud/import - импорт (admin+, требуется 2FA)
router.post(
  '/import',
  requirePageAccess('/skud-settings', 'edit'),
  requireCritical2FA,
  importLimiter,
  upload.single('file'),
  skudController.import
);

// POST /api/skud/sync-employee - синхронизация событий одного сотрудника из Sigur (admin+)
router.post(
  '/sync-employee',
  requireAnyPageAccess(['/employees', '/staff-control'], 'edit'),
  skudController.syncEmployee
);

// POST /api/skud/clean-duplicates - бэкфилл хэшей + удаление дублей (super_admin, требуется 2FA)
router.post(
  '/clean-duplicates',
  requirePageAccess('/skud-settings', 'edit'),
  requireCritical2FA,
  skudController.cleanDuplicates
);

// DELETE /api/skud/clear - очистка данных (super_admin, требуется 2FA)
router.delete(
  '/clear',
  requirePageAccess('/skud-settings', 'edit'),
  requireCritical2FA,
  skudController.clear
);

export default router;
