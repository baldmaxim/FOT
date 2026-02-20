import { Router } from 'express';
import { sigurController } from '../controllers/sigur.controller.js';
import { authenticate, requireRole } from '../middleware/auth.js';

const router = Router();

// Все роуты требуют аутентификации и роли admin/super_admin
router.use(authenticate as any);
router.use(requireRole('admin', 'owner', 'super_admin') as any);

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

// GET /api/sigur/events/codes — коды событий
router.get('/events/codes', sigurController.getEventCodes as any);

// GET /api/sigur/cards — карты доступа
router.get('/cards', sigurController.getCards as any);

// GET /api/sigur/zones — зоны доступа
router.get('/zones', sigurController.getZones as any);

// GET /api/sigur/access-rules — режимы доступа
router.get('/access-rules', sigurController.getAccessRules as any);

// GET /api/sigur/preview — предпросмотр сырых данных Sigur
router.get('/preview', sigurController.preview as any);

// POST /api/sigur/sync — синхронизация событий из Sigur в БД
router.post('/sync', sigurController.sync as any);

// POST /api/sigur/sync-employees — импорт сотрудников из Sigur в БД
router.post('/sync-employees', sigurController.syncEmployees as any);

// POST /api/sigur/sync-organizations — импорт отделов Sigur как организаций
router.post('/sync-organizations', sigurController.syncOrganizations as any);

// POST /api/sigur/clean-duplicate-organizations — удаление дублей организаций
router.post('/clean-duplicate-organizations', sigurController.cleanDuplicateOrganizations as any);

export default router;
