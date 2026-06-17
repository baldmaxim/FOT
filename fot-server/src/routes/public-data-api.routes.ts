import { Router } from 'express';
import { dataApiAuth } from '../middleware/dataApiAuth.js';
import { publicDataApiController } from '../controllers/public-data-api.controller.js';

// Публичная часть data-api на Node (рядом с Python /external/v1): расчётные
// эндпоинты, которые нельзя отдать через generic-таблицы. Авторизация — data-api
// Bearer токен (fot_<prefix>_<secret>), НЕ JWT.
const router = Router();

router.use(dataApiAuth);

router.get('/timesheet', publicDataApiController.getDepartmentTimesheet);

export default router;
