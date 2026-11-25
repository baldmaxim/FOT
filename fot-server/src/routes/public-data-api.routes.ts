import express, { Router } from 'express';
import { dataApiAuth } from '../middleware/dataApiAuth.js';
import { dataApiRequestLog } from '../middleware/dataApiRequestLog.js';
import { publicDataApiController } from '../controllers/public-data-api.controller.js';
import { publicTimesheetsController } from '../controllers/public-timesheets.controller.js';
import { publicStaffMonthController } from '../controllers/public-staff-month.controller.js';
import { publicDismissalsController } from '../controllers/public-dismissals.controller.js';
import { publicEmployeesController } from '../controllers/public-employees.controller.js';
import { PAYOUTS_BODY_LIMIT, payoutsBodyErrorHandler, publicPayoutsController } from '../controllers/public-payouts.controller.js';
import { dataApiLimiter } from '../middleware/dataApiRateLimit.js';

// Публичная часть data-api на Node (рядом с Python /external/v1): расчётные
// эндпоинты, которые нельзя отдать через generic-таблицы. Авторизация — data-api
// Bearer токен (fot_<prefix>_<secret>), НЕ JWT.
const router = Router();

// Лог до аутентификации: 401-е тоже попадают в data_api_request_logs (key_id = null).
router.use(dataApiRequestLog);
router.use(dataApiAuth);
// Лимит per-key — только после аутентификации, иначе ключа ещё нет в req.
router.use(dataApiLimiter);

router.get('/employee-events', publicDataApiController.getEmployeeEvents);
// Справочник сотрудников для 1С: ID_FOT ↔ код физлица 1С, ФИО, дата рождения (1С сама проставляет ID_FOT).
router.get('/employees', publicEmployeesController.list);
router.get('/timesheet', publicDataApiController.getDepartmentTimesheet);

// Обмен закрытыми согласованными табелями: список → выгрузка версии → подтверждение.
router.get('/timesheets', publicTimesheetsController.list);
router.get('/timesheets/:approval_id', publicTimesheetsController.detail);
// Объектная разбивка часов той же редакции — отдельным методом, чтобы тело табеля
// и его content_hash остались прежними.
router.get('/timesheets/:approval_id/objects', publicTimesheetsController.objects);
// Руководитель отдела по каждому сотруднику той же редакции — тоже отдельным методом.
router.get('/timesheets/:approval_id/managers', publicTimesheetsController.managers);
router.post('/timesheets/:approval_id/ack', publicTimesheetsController.ack);

// API для ЗУП3: сотрудники месяца (объект, факт и норма часов, категория, дни), бригады и объекты месяца.
router.get('/staff-month', publicStaffMonthController.employees);
router.get('/staff-month/brigades', publicStaffMonthController.brigades);
router.get('/staff-month/objects', publicStaffMonthController.objects);
// 1С подтверждает записанные строки (ревизия + хеш) — статус «Выгружен» в «Расчётах».
router.post('/staff-month/ack', publicStaffMonthController.ack);

// Увольнение из 1С ЗУП3: приказ, компенсация отпуска, выходное пособие (право allow_payroll_dismissal_import).
router.post('/payroll/dismissals', publicDismissalsController.post);
// Ведомости выплаты из 1С: XML «зп_документы_31» до 25 МБ и отмена (право allow_payroll_payouts_import).
router.post(
  '/payroll/payouts',
  express.raw({ type: ['application/xml', 'text/xml'], limit: PAYOUTS_BODY_LIMIT }),
  publicPayoutsController.post,
);
router.post('/payroll/payouts/cancel', publicPayoutsController.cancel);
router.use('/payroll/payouts', payoutsBodyErrorHandler);

export default router;
