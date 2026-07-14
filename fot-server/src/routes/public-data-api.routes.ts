import { Router } from 'express';
import { dataApiAuth } from '../middleware/dataApiAuth.js';
import { dataApiRequestLog } from '../middleware/dataApiRequestLog.js';
import { publicDataApiController } from '../controllers/public-data-api.controller.js';

// Публичная часть data-api на Node (рядом с Python /external/v1): расчётные
// эндпоинты, которые нельзя отдать через generic-таблицы. Авторизация — data-api
// Bearer токен (fot_<prefix>_<secret>), НЕ JWT.
const router = Router();

// Лог до аутентификации: 401-е тоже попадают в data_api_request_logs (key_id = null).
router.use(dataApiRequestLog);
router.use(dataApiAuth);

router.get('/employee-events', publicDataApiController.getEmployeeEvents);
router.get('/timesheet', publicDataApiController.getDepartmentTimesheet);

export default router;
