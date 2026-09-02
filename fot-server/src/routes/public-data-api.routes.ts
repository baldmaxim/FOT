import { Router } from 'express';
import { dataApiAuth } from '../middleware/dataApiAuth.js';
import { dataApiRequestLog } from '../middleware/dataApiRequestLog.js';
import { publicDataApiController } from '../controllers/public-data-api.controller.js';
import { publicTimesheetsController } from '../controllers/public-timesheets.controller.js';
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
router.get('/timesheet', publicDataApiController.getDepartmentTimesheet);

// Обмен закрытыми согласованными табелями: список → выгрузка версии → подтверждение.
router.get('/timesheets', publicTimesheetsController.list);
router.get('/timesheets/:approval_id', publicTimesheetsController.detail);
// Объектная разбивка часов той же редакции — отдельным методом, чтобы тело табеля
// и его content_hash остались прежними.
router.get('/timesheets/:approval_id/objects', publicTimesheetsController.objects);
router.post('/timesheets/:approval_id/ack', publicTimesheetsController.ack);

export default router;
