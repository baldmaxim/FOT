import { Router, type NextFunction, type Request, type Response } from 'express';
import { sigurController } from '../controllers/sigur.controller.js';
import { sigurMonitorController } from '../controllers/sigur-monitor.controller.js';
import { sigurSyncController } from '../controllers/sigur-sync.controller.js';
import { sigurAdminController } from '../controllers/sigur-admin.controller.js';
import { sigurFilterController } from '../controllers/sigur-filter.controller.js';
import { sigurCardReaderController } from '../controllers/sigur-card-reader.controller.js';
import { authenticate, requireAnyPageAccess, requireCritical2FA, requirePageAccess } from '../middleware/auth.js';
import { registerCache, invalidateCaches } from '../middleware/cacheResponse.js';
import { noStore } from '../middleware/noStore.js';
import { serverTiming } from '../middleware/serverTiming.js';
import { notifySigurStructureChanged } from '../services/skud-realtime.service.js';

const router = Router();

// Все роуты требуют аутентификации и page access на настройки СКУД
router.use(authenticate);

// Кэши для тяжёлых GET'ов Sigur (внешний API — самый медленный путь).
const sigurAdminDeptsCache = registerCache(
  'sigur:admin:departments',
  () => 'sigur:admin:departments',
  2 * 60_000,
);
const sigurAdminDeptsTreeCache = registerCache(
  'sigur:admin:departments-tree',
  (req) => `sigur:admin:departments-tree:${req.query.source === 'sigur' ? 'sigur' : 'org'}`,
  2 * 60_000,
);
const sigurAdminDeptsCountsCache = registerCache(
  'sigur:admin:departments-counts',
  () => 'sigur:admin:departments-counts',
  2 * 60_000,
);
const sigurAdminPositionsCache = registerCache(
  'sigur:admin:positions',
  () => 'sigur:admin:positions',
  5 * 60_000,
);
const sigurAdminEmployeesCache = registerCache(
  'sigur:admin:employees',
  (req) =>
    `sae:${req.query.departmentId ?? ''}:${req.query.search ?? ''}:${req.query.page ?? 1}:${req.query.pageSize ?? ''}`,
  60_000,
  500,
);
const sigurAdminCardStatusesCache = registerCache(
  'sigur:admin:card-statuses',
  (req) => `sacs:${req.query.connection ?? ''}:${req.query.employeeIds ?? ''}`,
  5 * 60_000,
);

const sigurAdminEmployeeProfileKey = (req: Request): string =>
  `saep:${req.query.connection ?? ''}:${req.params.sigurEmployeeId ?? ''}:${req.query.includeAccessPointCatalog ?? ''}`;

const sigurAdminEmployeeProfileCache = registerCache(
  'sigur:admin:employee-profile',
  sigurAdminEmployeeProfileKey,
  45_000,
  500,
);

const sigurAdminEmployeeProfileMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  if (req.query.refresh === '1') {
    sigurAdminEmployeeProfileCache.invalidateKey(sigurAdminEmployeeProfileKey(req));
    next();
    return;
  }
  sigurAdminEmployeeProfileCache(req, res, next);
};

const sigurAdminAccessPointOptionsCache = registerCache(
  'sigur:admin:access-point-options',
  (req) => `saapo:${req.query.connection ?? ''}`,
  5 * 60_000,
);

const SIGUR_ADMIN_CACHES = [
  'sigur:admin:departments',
  'sigur:admin:departments-tree',
  'sigur:admin:departments-counts',
  'sigur:admin:positions',
  'sigur:admin:employees',
  'sigur:admin:card-statuses',
  'sigur:admin:employee-profile',
  'sigur:admin:access-point-options',
];

// Write-through invalidation: любой POST/PUT/DELETE/PATCH на /admin/* и /sync* сбрасывает кэши
// и пушит structure_updated через Socket.IO, чтобы все клиенты сразу инвалидировали React Query
// без ожидания истечения staleTime.
router.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        invalidateCaches(...SIGUR_ADMIN_CACHES);
        notifySigurStructureChanged({ source: 'admin_crud' });
      }
    });
  }
  next();
});

// === Read-only эндпоинты ===

// GET /api/sigur/connection-settings — текущие параметры подключения и архивного отдела
router.get('/connection-settings', requirePageAccess('/skud-settings', 'view'), sigurController.getConnectionSettings);
router.get('/connection-status', requirePageAccess('/skud-settings', 'view'), sigurController.getConnectionStatus);

// === Live admin эндпоинты ===

router.get('/admin/departments', requirePageAccess('/skud-settings', 'view'), sigurAdminDeptsCache, sigurAdminController.listDepartments);
router.get('/admin/departments/tree', requirePageAccess('/skud-settings', 'view'), sigurAdminDeptsTreeCache, sigurAdminController.listDepartmentsTree);
router.get('/admin/departments/counts', requirePageAccess('/skud-settings', 'view'), sigurAdminDeptsCountsCache, sigurAdminController.listDepartmentCounts);
router.get('/admin/positions', requirePageAccess('/skud-settings', 'view'), sigurAdminPositionsCache, sigurAdminController.listPositions);
router.get('/admin/employees', requirePageAccess('/skud-settings', 'view'), sigurAdminEmployeesCache, sigurAdminController.listEmployees);
router.get('/admin/employees/card-statuses', requirePageAccess('/skud-settings', 'view'), sigurAdminCardStatusesCache, sigurAdminController.getEmployeeCardStatuses);
router.get('/admin/access-points/options', requirePageAccess('/skud-settings', 'view'), sigurAdminAccessPointOptionsCache, sigurAdminController.listAccessPointOptions);
router.get('/admin/employees/:sigurEmployeeId/profile', requirePageAccess('/skud-settings', 'view'), sigurAdminEmployeeProfileMiddleware, sigurAdminController.getEmployeeProfile);

router.post(
  '/admin/departments',
  requirePageAccess('/skud-settings', 'edit'),
  requireCritical2FA,
  sigurAdminController.createDepartment,
);
router.post(
  '/admin/departments/batch-move',
  requirePageAccess('/skud-settings', 'edit'),
  requireCritical2FA,
  sigurAdminController.batchMoveDepartments,
);
router.put(
  '/admin/departments/:sigurDepartmentId',
  requirePageAccess('/skud-settings', 'edit'),
  requireCritical2FA,
  sigurAdminController.updateDepartment,
);
router.delete(
  '/admin/departments/:sigurDepartmentId',
  requirePageAccess('/skud-settings', 'edit'),
  requireCritical2FA,
  sigurAdminController.deleteDepartment,
);
router.delete(
  '/admin/departments/:sigurDepartmentId/recursive',
  requirePageAccess('/skud-settings', 'edit'),
  requireCritical2FA,
  sigurAdminController.deleteDepartmentRecursive,
);
router.post(
  '/admin/positions',
  requirePageAccess('/skud-settings', 'edit'),
  requireCritical2FA,
  sigurAdminController.createPosition,
);
router.put(
  '/admin/positions/:sigurPositionId',
  requirePageAccess('/skud-settings', 'edit'),
  requireCritical2FA,
  sigurAdminController.updatePosition,
);
router.delete(
  '/admin/positions/:sigurPositionId',
  requirePageAccess('/skud-settings', 'edit'),
  requireCritical2FA,
  sigurAdminController.deletePosition,
);

router.post(
  '/admin/employees',
  requirePageAccess('/skud-settings', 'edit'),
  requireCritical2FA,
  sigurAdminController.createEmployee,
);
router.put(
  '/admin/employees/:sigurEmployeeId',
  requirePageAccess('/skud-settings', 'edit'),
  requireCritical2FA,
  sigurAdminController.updateEmployee,
);
router.delete(
  '/admin/employees/:sigurEmployeeId',
  requirePageAccess('/skud-settings', 'edit'),
  requireCritical2FA,
  sigurAdminController.deleteEmployee,
);
router.post(
  '/admin/employees/:sigurEmployeeId/block',
  requirePageAccess('/skud-settings', 'edit'),
  requireCritical2FA,
  sigurAdminController.blockEmployee,
);
router.post(
  '/admin/employees/:sigurEmployeeId/unblock',
  requirePageAccess('/skud-settings', 'edit'),
  requireCritical2FA,
  sigurAdminController.unblockEmployee,
);
router.post(
  '/admin/employees/:sigurEmployeeId/move',
  requirePageAccess('/skud-settings', 'edit'),
  requireCritical2FA,
  sigurAdminController.moveEmployee,
);
router.post(
  '/admin/employees/batch-move',
  requirePageAccess('/skud-settings', 'edit'),
  requireCritical2FA,
  sigurAdminController.batchMoveEmployees,
);
router.post(
  '/admin/employees/batch-move-stream',
  requirePageAccess('/skud-settings', 'edit'),
  requireCritical2FA,
  sigurAdminController.batchMoveEmployeesStream,
);
router.post(
  '/admin/employees/bulk-access-points-stream',
  requirePageAccess('/skud-settings', 'edit'),
  requireCritical2FA,
  sigurAdminController.bulkAddEmployeeAccessPointsStream,
);
router.put(
  '/admin/employees/:sigurEmployeeId/access-points',
  requirePageAccess('/skud-settings', 'edit'),
  requireCritical2FA,
  sigurAdminController.saveEmployeeAccessPoints,
);
router.put(
  '/admin/employees/:sigurEmployeeId/access-rules',
  requirePageAccess('/skud-settings', 'edit'),
  requireCritical2FA,
  sigurAdminController.saveEmployeeAccessRules,
);
router.put(
  '/admin/employees/:sigurEmployeeId/cards/:cardId/expiration',
  requirePageAccess('/skud-settings', 'edit'),
  requireCritical2FA,
  sigurAdminController.updateEmployeeCardExpiration,
);
router.patch(
  '/admin/employees/:sigurEmployeeId/cards/:cardId/binding',
  requirePageAccess('/skud-settings', 'edit'),
  requireCritical2FA,
  sigurAdminController.updateEmployeeCardBinding,
);
router.post(
  '/admin/employees/:sigurEmployeeId/cards/binding',
  requirePageAccess('/skud-settings', 'edit'),
  requireCritical2FA,
  sigurAdminController.assignEmployeeCardBinding,
);
router.delete(
  '/admin/employees/:sigurEmployeeId/cards/:cardId/binding',
  requirePageAccess('/skud-settings', 'edit'),
  requireCritical2FA,
  sigurAdminController.deleteEmployeeCardBinding,
);

// === Monitor эндпоинты (admin+) ===

router.get('/monitor/status', requirePageAccess('/skud-settings', 'view'), noStore, serverTiming('sigur_monitor_status'), sigurMonitorController.getStatus);
router.get('/monitor/incidents', requirePageAccess('/skud-settings', 'view'), noStore, serverTiming('sigur_monitor_incidents'), sigurMonitorController.getIncidents);
router.get('/monitor/incidents/:id', requirePageAccess('/skud-settings', 'view'), sigurMonitorController.getIncidentById);
router.get('/monitor/checks', requirePageAccess('/skud-settings', 'view'), noStore, serverTiming('sigur_monitor_checks'), sigurMonitorController.getChecks);

// GET /api/sigur/stream?type=employees — SSE-стриминг с прогрессом
router.get('/stream', requirePageAccess('/skud-settings', 'view'), sigurController.stream);

// GET /api/sigur/test — проверка подключения
router.get('/test', requirePageAccess('/skud-settings', 'view'), sigurController.testConnection);

// GET /api/sigur/employees — сотрудники Sigur
router.get('/employees', requirePageAccess('/skud-settings', 'view'), sigurController.getEmployees);

// GET /api/sigur/departments — отделы Sigur
router.get('/departments', requirePageAccess('/skud-settings', 'view'), sigurController.getDepartments);

// GET /api/sigur/access-points — точки доступа
router.get('/access-points', requirePageAccess('/skud-settings', 'view'), sigurController.getAccessPoints);

// GET /api/sigur/events — события (query: startTime, endTime)
router.get('/events', requirePageAccess('/skud-settings', 'view'), sigurController.getEvents);

// GET /api/sigur/events/types — типы событий
router.get('/events/types', requirePageAccess('/skud-settings', 'view'), sigurController.getEventTypes);

// GET /api/sigur/cards — карты доступа
router.get('/cards', requirePageAccess('/skud-settings', 'view'), sigurController.getCards);

// GET /api/sigur/zones — зоны доступа
router.get('/zones', requirePageAccess('/skud-settings', 'view'), sigurController.getZones);

// GET /api/sigur/access-rules — режимы доступа
router.get('/access-rules', requirePageAccess('/skud-settings', 'view'), sigurController.getAccessRules);

// GET /api/sigur/discover — диагностика полей Sigur API
router.get('/discover', requirePageAccess('/skud-settings', 'view'), sigurController.discover);

// GET /api/sigur/preview — предпросмотр сырых данных Sigur
router.get('/preview', requirePageAccess('/skud-settings', 'view'), sigurController.preview);

// GET /api/sigur/employees/:id/access-points — прямые точки доступа сотрудника
router.get(
  '/employees/:id/profile',
  requireAnyPageAccess(['/employee', '/staff-control', '/skud-settings'], 'view'),
  sigurController.getEmployeeProfile,
);

// GET /api/sigur/employees/:id/access-points — прямые точки доступа сотрудника
router.get(
  '/employees/:id/access-points',
  requireAnyPageAccess(['/employee', '/staff-control', '/skud-settings'], 'view'),
  sigurController.getEmployeeAccessPoints,
);

// === Sync эндпоинты ===

// POST /api/sigur/sync-all — полная синхронизация структуры (SSE)
router.post('/sync-all', requirePageAccess('/skud-settings', 'edit'), sigurSyncController.syncAll);

// POST /api/sigur/sync — синхронизация событий из Sigur в БД
router.post('/sync', requirePageAccess('/skud-settings', 'edit'), sigurSyncController.sync);

// POST /api/sigur/clear-events — удаление событий за период
router.post('/clear-events', requirePageAccess('/skud-settings', 'edit'), sigurSyncController.clearEvents);

// POST /api/sigur/sync-employees — импорт сотрудников из Sigur в БД
router.post('/sync-employees', requirePageAccess('/skud-settings', 'edit'), sigurSyncController.syncEmployees);

// POST /api/sigur/sync-departments — импорт отделов с иерархией
router.post('/sync-departments', requirePageAccess('/skud-settings', 'edit'), sigurSyncController.syncDepartments);

// POST /api/sigur/sync-positions — импорт должностей из Sigur
router.post('/sync-positions', requirePageAccess('/skud-settings', 'edit'), sigurSyncController.syncPositions);

// POST /api/sigur/match-employees — ручное сопоставление сотрудников
router.post('/match-employees', requirePageAccess('/skud-settings', 'edit'), sigurSyncController.matchEmployees);

// PUT /api/sigur/connection-settings — сохранить временные параметры подключения
router.put(
  '/connection-settings',
  requirePageAccess('/skud-settings', 'edit'),
  requireCritical2FA,
  sigurController.saveConnectionSettings,
);

// POST /api/sigur/archive-department/ensure — создать/проверить архивный отдел
router.post(
  '/archive-department/ensure',
  requirePageAccess('/skud-settings', 'edit'),
  requireCritical2FA,
  sigurController.ensureArchiveDepartment,
);

// PUT /api/sigur/employees/:id/access-points — сохранить прямые точки доступа сотрудника
router.put(
  '/employees/:id/cards/:cardId/expiration',
  requireAnyPageAccess(['/staff-control', '/skud-settings'], 'edit'),
  requireCritical2FA,
  sigurController.updateEmployeeCardExpiration,
);
router.patch(
  '/employees/:id/cards/:cardId/binding',
  requireAnyPageAccess(['/staff-control', '/skud-settings'], 'edit'),
  requireCritical2FA,
  sigurController.updateEmployeeCardBinding,
);

// PUT /api/sigur/employees/:id/access-points — сохранить прямые точки доступа сотрудника
router.put(
  '/employees/:id/access-points',
  requireAnyPageAccess(['/staff-control', '/skud-settings'], 'edit'),
  requireCritical2FA,
  sigurController.saveEmployeeAccessPoints,
);

// === Фильтр синхронизации ===

// GET /api/sigur/sync-filter — текущий whitelist отделов для синхронизации
router.get('/sync-filter', requirePageAccess('/skud-settings', 'view'), sigurFilterController.getFilter);

// PUT /api/sigur/sync-filter — замена whitelist отделов
router.put('/sync-filter', requirePageAccess('/skud-settings', 'edit'), sigurFilterController.updateFilter);

// === Card Reader (USB-считыватель) ===

// GET /api/sigur/cards/lookup?uid=<sigurCard16hex> — кому принадлежит карта
router.get(
  '/cards/lookup',
  requirePageAccess('/skud-card-reader', 'view'),
  sigurCardReaderController.lookup,
);

// POST /api/sigur/cards/assign — привязать карту к сотруднику
router.post(
  '/cards/assign',
  requirePageAccess('/skud-card-reader', 'edit'),
  requireCritical2FA,
  sigurCardReaderController.assign,
);

// === Admin эндпоинты ===

// POST /api/sigur/seed-positions — предзаполнение справочника должностей
router.post('/seed-positions', requirePageAccess('/skud-settings', 'edit'), sigurAdminController.seedPositions);

export default router;
