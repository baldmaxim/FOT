import { Router } from 'express';
import { mtsController } from '../controllers/mts.controller.js';
import { authenticate, requireCritical2FA, requirePageAccess } from '../middleware/auth.js';
import { noStore } from '../middleware/noStore.js';

// МТС «Мобильные сотрудники» — отдельный модуль геолокации. Доступ — страница /mts
// (только super_admin, миграция 108). Сохранение токена и привязок — под critical 2FA.
// Cache-Control: no-store на всём модуле (геолокация сотрудников не должна оседать
// в HTTP-кэше браузера — общие ПК / кнопка «назад»).

const router = Router();

router.use(authenticate);
router.use(noStore);

// Настройки подключения
router.get('/connection-settings', requirePageAccess('/mts', 'view'), mtsController.getConnectionSettings);
router.put(
  '/connection-settings',
  requirePageAccess('/mts', 'edit'),
  requireCritical2FA,
  mtsController.saveConnectionSettings,
);
router.post('/connection-settings/test', requirePageAccess('/mts', 'view'), mtsController.testConnection);

// Данные МТС
router.get('/subscribers', requirePageAccess('/mts', 'view'), mtsController.getSubscribers);
router.get('/last-locations', requirePageAccess('/mts', 'view'), mtsController.getLastLocations);
router.get('/track', requirePageAccess('/mts', 'view'), mtsController.getTrack);
router.get('/history', requirePageAccess('/mts', 'view'), mtsController.getHistory);

// Дополнительные бесплатные read-only справочники (GET → МТС, без списаний).
router.get('/subscriber-groups', requirePageAccess('/mts', 'view'), mtsController.getSubscriberGroups);
router.get('/subscriber-groups/:id', requirePageAccess('/mts', 'view'), mtsController.getSubscriberGroup);
router.get('/custom-fields', requirePageAccess('/mts', 'view'), mtsController.getCustomFields);
router.get('/recent-locations', requirePageAccess('/mts', 'view'), mtsController.getRecentLocations);
router.get('/recent-tracks', requirePageAccess('/mts', 'view'), mtsController.getRecentTracks);
router.get('/recent-global-locations', requirePageAccess('/mts', 'view'), mtsController.getRecentGlobalLocations);

// ПЛАТНЫЙ ручной запрос актуального положения — super_admin + 2FA + явный confirmed=true в body.
router.post(
  '/request-location',
  requirePageAccess('/mts', 'edit'),
  requireCritical2FA,
  mtsController.requestLocation,
);

// Задачи МТС
router.get('/tasks', requirePageAccess('/mts', 'view'), mtsController.getTasks);
router.get('/tasks/:taskId', requirePageAccess('/mts', 'view'), mtsController.getTask);
router.post(
  '/tasks',
  requirePageAccess('/mts', 'edit'),
  requireCritical2FA,
  mtsController.createTask,
);

// Привязка абонент -> сотрудник
router.get('/mappings', requirePageAccess('/mts', 'view'), mtsController.getMappings);
router.get('/mappings/suggestions', requirePageAccess('/mts', 'view'), mtsController.getMappingSuggestions);
router.put('/mappings', requirePageAccess('/mts', 'edit'), requireCritical2FA, mtsController.setMapping);

export default router;
