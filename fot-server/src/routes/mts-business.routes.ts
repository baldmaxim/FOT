import { Router } from 'express';
import multer from 'multer';
import { mtsBusinessController } from '../controllers/mts-business.controller.js';
import { authenticate, requireCritical2FA, requirePageAccess } from '../middleware/auth.js';
import { noStore } from '../middleware/noStore.js';

// МТС «Бизнес» — детализация звонков (время разговоров). Доступ — страница
// /mts-business (только super_admin, миграция 197). Смена настроек и заказ
// детализации — под critical 2FA. Cache-Control: no-store на всём модуле
// (детализация звонков — ПДн, не должна оседать в HTTP-кэше браузера).

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

router.use(authenticate);
router.use(noStore);

// Аккаунты (несколько API/лицевых счетов). Создание/изменение/удаление — 2FA.
router.get('/accounts', requirePageAccess('/mts-business', 'view'), mtsBusinessController.listAccounts);
router.post('/accounts', requirePageAccess('/mts-business', 'edit'), requireCritical2FA, mtsBusinessController.createAccount);
router.put('/accounts/:id', requirePageAccess('/mts-business', 'edit'), requireCritical2FA, mtsBusinessController.updateAccount);
router.delete('/accounts/:id', requirePageAccess('/mts-business', 'edit'), requireCritical2FA, mtsBusinessController.deleteAccount);
router.post('/accounts/:id/test', requirePageAccess('/mts-business', 'view'), mtsBusinessController.testAccount);

// Заказ детализации (документ уходит на email) — edit + critical 2FA + confirmed=true.
router.post(
  '/detalization/order',
  requirePageAccess('/mts-business', 'edit'),
  requireCritical2FA,
  mtsBusinessController.orderDetalization,
);
router.get('/detalization/requests', requirePageAccess('/mts-business', 'view'), mtsBusinessController.listRequests);
router.post(
  '/detalization/requests/:id/refresh-status',
  requirePageAccess('/mts-business', 'view'),
  mtsBusinessController.refreshStatus,
);

// Загрузка XML-детализации (файл с email) → парсинг → CDR.
router.post(
  '/detalization/upload',
  requirePageAccess('/mts-business', 'edit'),
  requireCritical2FA,
  upload.single('file'),
  mtsBusinessController.uploadDetalization,
);

// Привязка номеров к сотрудникам
router.get('/number-map', requirePageAccess('/mts-business', 'view'), mtsBusinessController.getNumberMap);
router.put('/number-map', requirePageAccess('/mts-business', 'edit'), requireCritical2FA, mtsBusinessController.setNumberMap);

// Отчёт «время разговоров» по сотрудникам
router.get('/report/talk-time', requirePageAccess('/mts-business', 'view'), mtsBusinessController.getTalkTimeReport);

export default router;
