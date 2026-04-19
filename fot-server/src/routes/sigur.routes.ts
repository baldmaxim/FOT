import { Router } from 'express';
import { sigurController } from '../controllers/sigur.controller.js';
import { sigurMonitorController } from '../controllers/sigur-monitor.controller.js';
import { sigurSyncController } from '../controllers/sigur-sync.controller.js';
import { sigurAdminController } from '../controllers/sigur-admin.controller.js';
import { sigurFilterController } from '../controllers/sigur-filter.controller.js';
import { authenticate, requireAnyPageAccess, requireCritical2FA, requirePageAccess } from '../middleware/auth.js';

const router = Router();

// Все роуты требуют аутентификации и page access на настройки СКУД
router.use(authenticate);

// === Read-only эндпоинты ===

// GET /api/sigur/connection-settings — текущие параметры подключения и архивного отдела
router.get('/connection-settings', requirePageAccess('/skud-settings', 'view'), sigurController.getConnectionSettings);
router.get('/connection-status', requirePageAccess('/skud-settings', 'view'), sigurController.getConnectionStatus);

// === Live admin эндпоинты ===

router.get('/admin/departments', requirePageAccess('/skud-settings', 'view'), sigurAdminController.listDepartments);
router.get('/admin/departments/tree', requirePageAccess('/skud-settings', 'view'), sigurAdminController.listDepartmentsTree);
router.get('/admin/departments/counts', requirePageAccess('/skud-settings', 'view'), sigurAdminController.listDepartmentCounts);
router.get('/admin/positions', requirePageAccess('/skud-settings', 'view'), sigurAdminController.listPositions);
router.get('/admin/employees', requirePageAccess('/skud-settings', 'view'), sigurAdminController.listEmployees);
router.get('/admin/employees/card-statuses', requirePageAccess('/skud-settings', 'view'), sigurAdminController.getEmployeeCardStatuses);
router.get('/admin/employees/:sigurEmployeeId/profile', requirePageAccess('/skud-settings', 'view'), sigurAdminController.getEmployeeProfile);

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

// === Monitor эндпоинты (admin+) ===

router.get('/monitor/status', requirePageAccess('/skud-monitor', 'view'), sigurMonitorController.getStatus);
router.get('/monitor/incidents', requirePageAccess('/skud-monitor', 'view'), sigurMonitorController.getIncidents);
router.get('/monitor/incidents/:id', requirePageAccess('/skud-monitor', 'view'), sigurMonitorController.getIncidentById);
router.get('/monitor/checks', requirePageAccess('/skud-monitor', 'view'), sigurMonitorController.getChecks);

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
  requireAnyPageAccess(['/employee', '/employees', '/staff-control', '/skud-settings'], 'view'),
  sigurController.getEmployeeProfile,
);

// GET /api/sigur/employees/:id/access-points — прямые точки доступа сотрудника
router.get(
  '/employees/:id/access-points',
  requireAnyPageAccess(['/employee', '/employees', '/staff-control', '/skud-settings'], 'view'),
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
  requireAnyPageAccess(['/employees', '/staff-control', '/skud-settings'], 'edit'),
  requireCritical2FA,
  sigurController.updateEmployeeCardExpiration,
);

// PUT /api/sigur/employees/:id/access-points — сохранить прямые точки доступа сотрудника
router.put(
  '/employees/:id/access-points',
  requireAnyPageAccess(['/employees', '/staff-control', '/skud-settings'], 'edit'),
  requireCritical2FA,
  sigurController.saveEmployeeAccessPoints,
);

// === Фильтр синхронизации ===

// GET /api/sigur/sync-filter — текущий whitelist отделов для синхронизации
router.get('/sync-filter', requirePageAccess('/skud-settings', 'view'), sigurFilterController.getFilter);

// PUT /api/sigur/sync-filter — замена whitelist отделов
router.put('/sync-filter', requirePageAccess('/skud-settings', 'edit'), sigurFilterController.updateFilter);

// === Admin эндпоинты ===

// POST /api/sigur/seed-positions — предзаполнение справочника должностей
router.post('/seed-positions', requirePageAccess('/skud-settings', 'edit'), sigurAdminController.seedPositions);

export default router;
