import { Router } from 'express';
import { sigurController } from '../controllers/sigur.controller.js';
import { sigurSyncController } from '../controllers/sigur-sync.controller.js';
import { sigurAdminController } from '../controllers/sigur-admin.controller.js';
import { sigurFilterController } from '../controllers/sigur-filter.controller.js';
import { authenticate, requireMinPosition } from '../middleware/auth.js';

const router = Router();

// Все роуты требуют аутентификации и роли admin/super_admin
router.use(authenticate);
router.use(requireMinPosition('header'));

// === Read-only эндпоинты ===

// GET /api/sigur/stream?type=employees — SSE-стриминг с прогрессом
router.get('/stream', sigurController.stream);

// GET /api/sigur/test — проверка подключения
router.get('/test', sigurController.testConnection);

// GET /api/sigur/employees — сотрудники Sigur
router.get('/employees', sigurController.getEmployees);

// GET /api/sigur/departments — отделы Sigur
router.get('/departments', sigurController.getDepartments);

// GET /api/sigur/access-points — точки доступа
router.get('/access-points', sigurController.getAccessPoints);

// GET /api/sigur/events — события (query: startTime, endTime)
router.get('/events', sigurController.getEvents);

// GET /api/sigur/events/types — типы событий
router.get('/events/types', sigurController.getEventTypes);

// GET /api/sigur/cards — карты доступа
router.get('/cards', sigurController.getCards);

// GET /api/sigur/zones — зоны доступа
router.get('/zones', sigurController.getZones);

// GET /api/sigur/access-rules — режимы доступа
router.get('/access-rules', sigurController.getAccessRules);

// GET /api/sigur/discover — диагностика полей Sigur API
router.get('/discover', sigurController.discover);

// GET /api/sigur/preview — предпросмотр сырых данных Sigur
router.get('/preview', sigurController.preview);

// === Sync эндпоинты ===

// POST /api/sigur/sync-all — полная синхронизация структуры (SSE)
router.post('/sync-all', sigurSyncController.syncAll);

// POST /api/sigur/sync — синхронизация событий из Sigur в БД
router.post('/sync', sigurSyncController.sync);

// POST /api/sigur/clear-events — удаление событий за период
router.post('/clear-events', sigurSyncController.clearEvents);

// POST /api/sigur/sync-employees — импорт сотрудников из Sigur в БД
router.post('/sync-employees', sigurSyncController.syncEmployees);

// POST /api/sigur/sync-departments — импорт отделов с иерархией
router.post('/sync-departments', sigurSyncController.syncDepartments);

// POST /api/sigur/sync-positions — импорт должностей из Sigur
router.post('/sync-positions', sigurSyncController.syncPositions);

// POST /api/sigur/match-employees — ручное сопоставление сотрудников
router.post('/match-employees', sigurSyncController.matchEmployees);

// === Фильтр синхронизации ===

// GET /api/sigur/sync-filter — текущий whitelist отделов для синхронизации
router.get('/sync-filter', sigurFilterController.getFilter);

// PUT /api/sigur/sync-filter — замена whitelist отделов
router.put('/sync-filter', sigurFilterController.updateFilter);

// === Admin эндпоинты ===

// POST /api/sigur/sync-organizations — импорт отделов Sigur как организаций
router.post('/sync-organizations', sigurAdminController.syncOrganizations);

// POST /api/sigur/seed-positions — предзаполнение справочника должностей
router.post('/seed-positions', sigurAdminController.seedPositions);

// POST /api/sigur/clean-duplicate-organizations — удаление дублей организаций
router.post('/clean-duplicate-organizations', sigurAdminController.cleanDuplicateOrganizations);

export default router;
