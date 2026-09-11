import { Router } from 'express';

import { authenticate, requirePageAccess } from '../middleware/auth.js';
import { noStore } from '../middleware/noStore.js';
import { payrollTermsController } from '../controllers/payroll-terms.controller.js';

const router = Router();

router.use(authenticate);

// no-store на весь модуль: глобальный дефолт `private, max-age=30` (app.ts) держал бы
// у браузера прошлые суммы после смены условий. Денежные данные из кэша не отдаём.
router.use(noStore);

// Гарды именованными алиасами — их распознаёт `npm run audit:routes`.
// Ключи разведены заранее: на этапе 1 все выданы только роли admin (миграция 272),
// но раздать их разным ролям можно будет в /admin/roles без миграции и деплоя.
const termsView = requirePageAccess('/salary/terms', 'view');
const termsEdit = requirePageAccess('/salary/terms', 'edit');

// ─── Условия оплаты ──────────────────────────────────────────────────────────
// Статические пути до параметрических: иначе '/terms/employee/:empId' перехватил бы
// '/terms/bulk'.
router.get('/terms', termsView, payrollTermsController.list);
router.post('/terms/bulk', termsEdit, payrollTermsController.assignBulk);
router.get('/terms/employee/:empId', termsView, payrollTermsController.getByEmployee);
router.post('/terms/employee/:empId', termsEdit, payrollTermsController.assign);

export default router;
