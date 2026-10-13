import { Router } from 'express';

import { authenticate, requireAnyPageAccess, requirePageAccess } from '../middleware/auth.js';
import { noStore } from '../middleware/noStore.js';
import { payrollDeductionsController } from '../controllers/payroll-deductions.controller.js';
import { payrollPaidController } from '../controllers/payroll-paid.controller.js';
import { payrollRatesController } from '../controllers/payroll-rates.controller.js';
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
// Удержания сотрудника и справочники (виды удержаний, ставки) правятся и в карточке («Условия оплаты»),
// и на «Расчётах».
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

// ─── Удержания: справочник видов и виды удержаний сотрудника ──────────────────
router.get('/deduction-kinds', deductionsView, payrollDeductionsController.listKinds);
router.post('/deduction-kinds', deductionsEdit, payrollDeductionsController.addKind);
router.patch('/deduction-kinds/:id', deductionsEdit, payrollDeductionsController.renameKind);
router.delete('/deduction-kinds/:id', deductionsEdit, payrollDeductionsController.deleteKind);
router.get('/deductions/employee/:empId', deductionsView, payrollDeductionsController.getByEmployee);
router.put('/deductions/employee/:empId', deductionsEdit, payrollDeductionsController.saveByEmployee);

// ─── Справочник ставок (окно «Справочник» на «Расчётах») ─────────────────────
router.get('/rates', deductionsView, payrollRatesController.list);
router.post('/rates', deductionsEdit, payrollRatesController.add);
router.patch('/rates/:id', deductionsEdit, payrollRatesController.update);
router.delete('/rates/:id', deductionsEdit, payrollRatesController.remove);

// ─── Отпуск в карточке сотрудника (только чтение) ────────────────────────────
router.get('/vacation/employee/:empId', termsView, payrollVacationController.getByEmployee);

export default router;
