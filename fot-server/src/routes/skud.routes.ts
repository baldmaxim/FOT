import { Router } from 'express';
import multer from 'multer';
import { skudController } from '../controllers/skud.controller.js';
import { authenticate, requireAnyPageAccess, requirePageAccess, requireCritical2FA } from '../middleware/auth.js';
import { importLimiter } from '../middleware/rateLimit.js';
import { registerCache, invalidateCaches } from '../middleware/cacheResponse.js';
import { noStore } from '../middleware/noStore.js';
import { serverTiming } from '../middleware/serverTiming.js';
import { invalidatePresenceCache } from '../services/skud-presence.service.js';
import { invalidatePresenceByObjectCache } from '../services/skud-presence-by-object.service.js';
import { invalidateDashboardCache } from '../services/skud-dashboard.service.js';

// req.user.id обязателен в ключах: иначе ответ, прогретый одним пользователем
// (например, админом без department_id → данные по всем отделам), отдавался бы
// другому пользователю с другим scope без вызова контроллера, в обход 403.
// TTL держим коротким: основная инвалидация идёт через invalidateCaches() из
// presence-polling при появлении новых СКУД-событий, TTL — лишь страховка.
const presenceCache = registerCache(
  'skud-presence',
  (req) => `presence:${req.user.id}:${req.query.department_id || 'all'}`,
  5_000,
);

const presenceByObjectCache = registerCache(
  'skud-presence-by-object',
  (req) => `presence-by-object:${req.user.id}`,
  5_000,
);

const dashboardCache = registerCache(
  'skud-dashboard',
  (req) => {
    const period = ['today', 'week', 'month'].includes(req.query.period as string)
      ? (req.query.period as string)
      : 'today';
    const month = typeof req.query.month === 'string' ? req.query.month : '';
    return `dashboard:${req.user.id}:${req.query.department_id ?? 'all'}:${period}:${month}`;
  },
  10_000,
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

// Write-through invalidation: после мутаций (импорт, sync-employee, rebuild сегментов,
// CRUD объектов/маршрутов) сбрасываем HTTP-кэши per-user и in-memory кэши сервисов,
// иначе presence/dashboard продолжат отдавать stale-данные до TTL 5-10 сек.
router.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        invalidateCaches('skud-presence', 'skud-presence-by-object', 'skud-dashboard');
        invalidatePresenceCache();
        invalidatePresenceByObjectCache();
        invalidateDashboardCache();
      }
    });
  }
  next();
});

// GET /api/skud/dashboard-stats - аналитика дашборда (header+, кэш 60с)
router.get(
  '/dashboard-stats',
  requirePageAccess('/dashboard', 'view'),
  noStore,
  serverTiming('skud_dashboard'),
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

// GET /api/skud/daily-summary - дневные сводки (admin+)
// Доступ под /skud-settings: вкладка «База» живёт на этой странице.
router.get(
  '/daily-summary',
  requirePageAccess('/skud-settings', 'view'),
  skudController.getDailySummary
);

// GET /api/skud/employee-events/:employeeId - события конкретного сотрудника (worker+)
router.get(
  '/employee-events/:employeeId',
  requireAnyPageAccess(
    ['/employee', '/staff-control'],
    'view',
  ),
  skudController.getEmployeeEvents
);

router.get(
  '/employee-events/:employeeId/export',
  requireAnyPageAccess(
    ['/employee', '/staff-control'],
    'view',
  ),
  skudController.exportEmployeeEvents
);

// GET /api/skud/events - события СКУД (admin+)
// Доступ под /skud-settings: вкладка «База» живёт на этой странице.
router.get(
  '/events',
  requirePageAccess('/skud-settings', 'view'),
  skudController.getEvents
);

// GET /api/skud/event-failures - ошибочные события Sigur (PASS_DENY и т.п.) (admin+)
// Доступ под /skud-settings: вкладка «Ошибочные события» живёт на этой странице.
router.get(
  '/event-failures',
  requirePageAccess('/skud-settings', 'view'),
  skudController.getEventFailures
);

// GET /api/skud/access-points - точки доступа (header+)
router.get(
  '/access-points',
  requirePageAccess('/skud-settings', 'view'),
  skudController.getAccessPoints
);

// GET /api/skud/access-point-settings - настройки точек доступа для отдела (worker+)
router.get(
  '/access-point-settings',
  requireAnyPageAccess(['/employee', '/staff-control', '/skud-settings'], 'view'),
  skudController.getAccessPointSettings
);

// GET /api/skud/travel-config - текущий единый лимит передвижения (header+)
router.get(
  '/travel-config',
  requirePageAccess('/skud-settings', 'view'),
  skudController.getTravelConfig
);

// PUT /api/skud/travel-config - сохранить единый лимит передвижения (admin+)
router.put(
  '/travel-config',
  requirePageAccess('/skud-settings', 'edit'),
  skudController.updateTravelConfig
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

// GET /api/skud/travel-objects/:id/map - карта объекта (header+)
// noStore: image_url — signed URL с TTL 1 ч; нельзя кэшировать в браузере, иначе протухнет.
router.get(
  '/travel-objects/:id/map',
  noStore,
  requirePageAccess('/skud-settings', 'view'),
  skudController.getTravelObjectMap
);

// POST /api/skud/travel-objects/:id/map/upload-url - получить signed upload URL карты (admin+)
router.post(
  '/travel-objects/:id/map/upload-url',
  requirePageAccess('/skud-settings', 'edit'),
  skudController.getTravelObjectMapUploadUrl
);

// POST /api/skud/travel-objects/:id/map/confirm - подтвердить загрузку карты (admin+)
router.post(
  '/travel-objects/:id/map/confirm',
  requirePageAccess('/skud-settings', 'edit'),
  skudController.confirmTravelObjectMapUpload
);

// PUT /api/skud/travel-objects/:id/map-points - сохранить маркеры карты (admin+)
router.put(
  '/travel-objects/:id/map-points',
  requirePageAccess('/skud-settings', 'edit'),
  skudController.saveTravelObjectMapPoints
);

// DELETE /api/skud/travel-objects/:id/map - удалить карту объекта (admin+)
router.delete(
  '/travel-objects/:id/map',
  requirePageAccess('/skud-settings', 'edit'),
  skudController.deleteTravelObjectMap
);

// DELETE /api/skud/travel-objects/:id - удалить объект (admin+)
router.delete(
  '/travel-objects/:id',
  requirePageAccess('/skud-settings', 'edit'),
  skudController.deleteTravelObject
);

// GET /api/skud/access-point-map - карта конкретной точки доступа (HR/Admin)
// noStore: image_url — signed URL с TTL 1 ч; нельзя кэшировать в браузере, иначе протухнет.
router.get(
  '/access-point-map',
  noStore,
  requirePageAccess('/skud-settings', 'view'),
  skudController.getAccessPointMap
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
  requirePageAccess('/skud-settings', 'view'),
  skudController.getTravelSegments
);

// POST /api/skud/travel-segments/rebuild - принудительный пересчёт передвижений (header+)
router.post(
  '/travel-segments/rebuild',
  requirePageAccess('/skud-settings', 'edit'),
  skudController.rebuildTravelSegments
);

// GET /api/skud/travel-segments/day - сегменты передвижений сотрудника за конкретный день
// (для модалки в табеле). Доступ дополнительно проверяется по отделу сотрудника внутри контроллера.
router.get(
  '/travel-segments/day',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr'], 'view'),
  skudController.getDayTravelSegments
);

// POST /api/skud/travel-segments/:id/approve - подтвердить превышение лимита передвижения.
router.post(
  '/travel-segments/:id/approve',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr'], 'edit'),
  skudController.approveTravelSegment
);

// POST /api/skud/travel-segments/:id/reject - отклонить превышение лимита передвижения.
router.post(
  '/travel-segments/:id/reject',
  requireAnyPageAccess(['/timesheet', '/timesheet-hr'], 'edit'),
  skudController.rejectTravelSegment
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
  requireAnyPageAccess(['/dashboard', '/staff-control'], 'view'),
  noStore,
  serverTiming('skud_presence'),
  presenceCache,
  skudController.getPresence
);

// GET /api/skud/presence-by-object - агрегация присутствия по объектам и компаниям
router.get(
  '/presence-by-object',
  requirePageAccess('/skud-presence', 'view'),
  noStore,
  serverTiming('skud_presence_by_object'),
  presenceByObjectCache,
  skudController.getPresenceByObject
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
  requirePageAccess('/staff-control', 'edit'),
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
