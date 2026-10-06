import { Router } from 'express';

import { authenticate, requireAnyPageAccess, requirePageAccess } from '../middleware/auth.js';
import { noStore } from '../middleware/noStore.js';
import { payrollDeductionsController } from '../controllers/payroll-deductions.controller.js';
import { payrollPaidController } from '../controllers/payroll-paid.controller.js';
import { payrollTermsController } from '../controllers/payroll-terms.controller.js';
import { payrollVacationController } from '../controllers/payroll-vacation.controller.js';

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
const paymentsView = requirePageAccess('/salary/payments', 'view');
const paymentsEdit = requirePageAccess('/salary/payments', 'edit');
// Справочник видов удержаний нужен и карточке («Условия оплаты»), и «Расчётам».
const deductionKindsView = requireAnyPageAccess(['/salary/terms', '/salary/payments'], 'view');

// ─── Условия оплаты ──────────────────────────────────────────────────────────
// Статические пути до параметрических: иначе '/terms/employee/:empId' перехватил бы
// '/terms/bulk'.
router.get('/terms', termsView, payrollTermsController.list);
// Варианты фильтра столбца (воронка в заголовке таблицы условий).
router.get('/terms/column-values', termsView, payrollTermsController.columnValues);
router.post('/terms/bulk', termsEdit, payrollTermsController.assignBulk);
router.get('/terms/employee/:empId', termsView, payrollTermsController.getByEmployee);
// История условий для карточки сотрудника: оклад / ставка и плановая доплата одним журналом.
router.get('/terms/employee/:empId/changes', termsView, payrollTermsController.getChanges);
// Только оклад / ставка — для закэшированных клиентов до /changes.
router.get('/terms/employee/:empId/salary-history', termsView, payrollTermsController.getSalaryHistory);
router.post('/terms/employee/:empId', termsEdit, payrollTermsController.assign);
// «Оплачено» по месяцам в карточке: суммы статей отчёта ЗУП, вносятся вручную.
router.get('/terms/employee/:empId/paid', termsView, payrollPaidController.getByEmployee);
router.put('/terms/employee/:empId/paid', termsEdit, payrollPaidController.save);

// ─── «Расчёты»: удержания по видам и справочник видов ────────────────────────
router.get('/deduction-kinds', deductionKindsView, payrollDeductionsController.listKinds);
router.post('/deduction-kinds', paymentsEdit, payrollDeductionsController.addKind);
router.get('/deductions', paymentsView, payrollDeductionsController.list);

// ─── Отпуск в карточке сотрудника (только чтение) ────────────────────────────
router.get('/vacation/employee/:empId', termsView, payrollVacationController.getByEmployee);

export default router;
