import { Router } from 'express';
import multer from 'multer';
import { mtsBusinessController } from '../controllers/mts-business.controller.js';
import { mtsBusinessBillingController } from '../controllers/mts-business-billing.controller.js';
import { mtsBusinessCatalogController } from '../controllers/mts-business-catalog.controller.js';
import { authenticate, requireCritical2FA, requirePageAccess } from '../middleware/auth.js';
import { noStore } from '../middleware/noStore.js';

// МТС «Бизнес» — детализация звонков (время разговоров). Доступ — страница
// /mts-business (только роль admin, как /mts; миграция 197). Смена настроек и заказ
// детализации — под critical 2FA. Cache-Control: no-store на всём модуле
// (детализация звонков — ПДн, не должна оседать в HTTP-кэше браузера).

const router = Router();

// Детализация по лицевому счёту за месяц реально весит >100 МБ (проверено:
// 115 МБ XML по ЛС с 22 номерами). Держим запас; nginx client_max_body_size
// на сайте должен быть не меньше.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 300 * 1024 * 1024 },
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

// Ручной бэкафилл за период — синхронно, без email (Bills/BillingStatementExtdByMSISDN).
router.post(
  '/detalization/fetch-sync',
  requirePageAccess('/mts-business', 'edit'),
  requireCritical2FA,
  mtsBusinessController.fetchSyncDetalization,
);
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
router.get('/number-map/imported', requirePageAccess('/mts-business', 'view'), mtsBusinessController.getImportedNumbers);
router.put('/number-map', requirePageAccess('/mts-business', 'edit'), requireCritical2FA, mtsBusinessController.setNumberMap);

// Отчёт «время разговоров» по сотрудникам + сводка по лицевым счетам (дашборд)
router.get('/report/talk-time', requirePageAccess('/mts-business', 'view'), mtsBusinessController.getTalkTimeReport);
router.get('/report/accounts-summary', requirePageAccess('/mts-business', 'view'), mtsBusinessController.getAccountsSummary);

// Баланс/начисления/неоплаченные счета (вкладка «Финансы»). Обслуживается из
// истории — обновление данных только через /billing/refresh (edit + 2FA) и
// ежедневный планировщик, не по каждому открытию страницы.
router.get('/billing/summary', requirePageAccess('/mts-business', 'view'), mtsBusinessBillingController.getSummary);
router.get('/billing/trend', requirePageAccess('/mts-business', 'view'), mtsBusinessBillingController.getTrend);
router.post(
  '/billing/refresh',
  requirePageAccess('/mts-business', 'edit'),
  requireCritical2FA,
  mtsBusinessBillingController.refresh,
);

// Тариф/услуги/остатки пакетов/структура абонента (обогащение «Финансы»).
// Меняется редко — обновляется еженедельным кадансом планировщика или вручную.
router.get('/catalog/employees', requirePageAccess('/mts-business', 'view'), mtsBusinessCatalogController.getEmployeesCatalog);
router.get('/catalog/accounts-packages', requirePageAccess('/mts-business', 'view'), mtsBusinessCatalogController.getAccountsPackages);
router.post(
  '/catalog/refresh',
  requirePageAccess('/mts-business', 'edit'),
  requireCritical2FA,
  mtsBusinessCatalogController.refresh,
);

export default router;
