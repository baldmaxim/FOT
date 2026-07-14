import { Router } from 'express';
import { dashboardMtsController } from '../controllers/dashboard-mts.controller.js';
import { authenticate, requirePageAccess } from '../middleware/auth.js';
import { registerCache } from '../middleware/cacheResponse.js';
import { noStore } from '../middleware/noStore.js';
import { serverTiming } from '../middleware/serverTiming.js';

// req.user.id обязателен в ключе кэша: иначе ответ, прогретый одним пользователем,
// достался бы другому с другим scope в обход 403 (та же причина, что в skud.routes.ts).
const mtsUsageCache = registerCache(
  'dashboard-mts-usage',
  (req) => {
    const dept = typeof req.query.department_id === 'string' ? req.query.department_id : 'none';
    const month = typeof req.query.month === 'string' ? req.query.month : '';
    const date = typeof req.query.date === 'string' ? req.query.date : '';
    return `dash-mts:${req.user.id}:${dept}:${month}:${date}`;
  },
  60_000,
);

const router = Router();

router.use(authenticate);

// Статистика связи по отделу руководителя. Выписку наполняет ночной конвейер —
// данные меняются раз в сутки, поэтому TTL кэша щедрый.
router.get(
  '/mts-usage',
  requirePageAccess('/dashboard', 'view'),
  noStore,
  serverTiming('dashboard_mts_usage'),
  mtsUsageCache,
  dashboardMtsController.getDepartmentMtsUsage,
);

export default router;
