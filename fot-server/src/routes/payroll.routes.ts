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
// Удержания сотрудника и справочник видов правятся и в карточке («Условия оплаты»), и на «Расчётах».
const deductionsView = requireAnyPageAccess(['/salary/terms', '/salary/payments'], 'view');
const deductionsEdit = requireAnyPageAccess(['/salary/terms', '/salary/payments'], 'edit');

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
// «Оплачено» по месяцам в карточке: суммы статей отчёта ЗУП из 1С, только чтение.
router.get('/terms/employee/:empId/paid', termsView, payrollPaidController.getByEmployee);

// ─── Удержания: справочник видов и удержания сотрудника по месяцам ───────────
// Фильтр «Удержания» на «Расчётах» — параметры списка условий (/terms).
router.get('/deduction-kinds', deductionsView, payrollDeductionsController.listKinds);
router.post('/deduction-kinds', deductionsEdit, payrollDeductionsController.addKind);
router.get('/deduction-entries/employee/:empId', deductionsView, payrollDeductionsController.getEntries);
router.put('/deduction-entries/employee/:empId', deductionsEdit, payrollDeductionsController.saveEntries);

// ─── Отпуск в карточке сотрудника (только чтение) ────────────────────────────
router.get('/vacation/employee/:empId', termsView, payrollVacationController.getByEmployee);

export default router;
