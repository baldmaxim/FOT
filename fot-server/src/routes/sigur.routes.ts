import { Router } from 'express';
import { sigurController } from '../controllers/sigur.controller.js';
import { sigurSyncController } from '../controllers/sigur-sync.controller.js';
import { sigurAdminController } from '../controllers/sigur-admin.controller.js';
import { authenticate, requireRole } from '../middleware/auth.js';

const router = Router();

// Все роуты требуют аутентификации и роли admin/super_admin
router.use(authenticate as any);
router.use(requireRole('header', 'admin', 'owner', 'super_admin') as any);

// === Read-only эндпоинты ===

// GET /api/sigur/stream?type=employees — SSE-стриминг с прогрессом
router.get('/stream', sigurController.stream as any);

// GET /api/sigur/test — проверка подключения
router.get('/test', sigurController.testConnection as any);

// GET /api/sigur/employees — сотрудники Sigur
router.get('/employees', sigurController.getEmployees as any);

// GET /api/sigur/departments — отделы Sigur
router.get('/departments', sigurController.getDepartments as any);

// GET /api/sigur/access-points — точки доступа
router.get('/access-points', sigurController.getAccessPoints as any);

// GET /api/sigur/events — события (query: startTime, endTime)
router.get('/events', sigurController.getEvents as any);

// GET /api/sigur/events/types — типы событий
router.get('/events/types', sigurController.getEventTypes as any);

// GET /api/sigur/cards — карты доступа
router.get('/cards', sigurController.getCards as any);

// GET /api/sigur/zones — зоны доступа
router.get('/zones', sigurController.getZones as any);

// GET /api/sigur/access-rules — режимы доступа
router.get('/access-rules', sigurController.getAccessRules as any);

// GET /api/sigur/discover — диагностика полей Sigur API
router.get('/discover', sigurController.discover as any);

// GET /api/sigur/preview — предпросмотр сырых данных Sigur
router.get('/preview', sigurController.preview as any);

// === Sync эндпоинты ===

// POST /api/sigur/sync — синхронизация событий из Sigur в БД
router.post('/sync', sigurSyncController.sync as any);

// POST /api/sigur/sync-employees — импорт сотрудников из Sigur в БД
router.post('/sync-employees', sigurSyncController.syncEmployees as any);

// POST /api/sigur/sync-departments — импорт отделов с иерархией
router.post('/sync-departments', sigurSyncController.syncDepartments as any);

// POST /api/sigur/sync-positions — импорт должностей из Sigur
router.post('/sync-positions', sigurSyncController.syncPositions as any);

// === Admin эндпоинты ===

// POST /api/sigur/sync-organizations — импорт отделов Sigur как организаций
router.post('/sync-organizations', sigurAdminController.syncOrganizations as any);

// POST /api/sigur/seed-positions — предзаполнение справочника должностей
router.post('/seed-positions', sigurAdminController.seedPositions as any);

// POST /api/sigur/clean-duplicate-organizations — удаление дублей организаций
router.post('/clean-duplicate-organizations', sigurAdminController.cleanDuplicateOrganizations as any);

export default router;
