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

// ПЛАТНЫЙ ручной запрос актуального положения — super_admin + 2FA + явный confirmed=true в body.
router.post(
  '/request-location',
  requirePageAccess('/mts', 'edit'),
  requireCritical2FA,
  mtsController.requestLocation,
);

// Привязка абонент -> сотрудник
router.get('/mappings', requirePageAccess('/mts', 'view'), mtsController.getMappings);
router.get('/mappings/suggestions', requirePageAccess('/mts', 'view'), mtsController.getMappingSuggestions);
router.put('/mappings', requirePageAccess('/mts', 'edit'), requireCritical2FA, mtsController.setMapping);

export default router;
