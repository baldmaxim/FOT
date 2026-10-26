import { Router } from 'express';

import { authenticate, requireAnyPageAccess, requirePageAccess } from '../middleware/auth.js';
import { noStore } from '../middleware/noStore.js';
import { payrollCardExportController } from '../controllers/payroll-card-export.controller.js';
import { payrollCompensationStopsController } from '../controllers/payroll-compensation-stops.controller.js';
import { deductionSubkindsController } from '../controllers/deduction-subkinds.controller.js';
import { payrollDeductionsController } from '../controllers/payroll-deductions.controller.js';
import { payrollDormitoryAllowancesController } from '../controllers/payroll-dormitory-allowances.controller.js';
import { payrollHousingController } from '../controllers/payroll-housing.controller.js';
import { payrollPaidController } from '../controllers/payroll-paid.controller.js';
import { payrollRatesController } from '../controllers/payroll-rates.controller.js';
import { payrollRegistryController } from '../controllers/payroll-registry.controller.js';
import { dormitoryStaysController } from '../controllers/dormitory-stays.controller.js';
import { payrollSectionAccessController } from '../controllers/payroll-section-access.controller.js';
import { payrollStaffDeductionsController } from '../controllers/payroll-staff-deductions.controller.js';
import { payrollSummaryController } from '../controllers/payroll-summary.controller.js';
import { payrollSupplementsController } from '../controllers/payroll-supplements.controller.js';
import { payrollTermsController } from '../controllers/payroll-terms.controller.js';
import { payrollVacationController } from '../controllers/payroll-vacation.controller.js';

const router = Router();

router.use(authenticate);

// no-store на весь модуль: глобальный дефолт `private, max-age=30` (app.ts) держал бы
// у браузера прошлые суммы после смены условий. Денежные данные из кэша не отдаём.
router.use(noStore);

// Гарды именованными алиасами — их распознаёт `npm run audit:routes`.
// Ключи раздела роль не даёт: их решает только список payroll_section_access (миграция 310),
// и администраторов тоже — см. resolveEffectivePageAccess.
const termsView = requirePageAccess('/salary/terms', 'view');
const termsEdit = requirePageAccess('/salary/terms', 'edit');
// Удержания сотрудника и справочники (виды удержаний, ставки) правятся и в карточке («Условия оплаты»),
// и на «Расчётах».
const deductionsView = requireAnyPageAccess(['/salary/terms', '/salary/payments'], 'view');
const deductionsEdit = requireAnyPageAccess(['/salary/terms', '/salary/payments'], 'edit');

// ─── Условия оплаты ──────────────────────────────────────────────────────────
router.get('/terms', termsView, payrollTermsController.list);
// Варианты фильтра столбца (воронка в заголовке таблицы условий).
router.get('/terms/column-values', termsView, payrollTermsController.columnValues);
router.get('/terms/employee/:empId', termsView, payrollTermsController.getByEmployee);
// История условий для карточки сотрудника: оклад / ставка и плановая доплата одним журналом.
router.get('/terms/employee/:empId/changes', termsView, payrollTermsController.getChanges);
// Только оклад / ставка — для закэшированных клиентов до /changes.
router.get('/terms/employee/:empId/salary-history', termsView, payrollTermsController.getSalaryHistory);
router.post('/terms/employee/:empId', termsEdit, payrollTermsController.assign);
// «Оплачено» по месяцам в карточке: суммы статей отчёта ЗУП из 1С, только чтение.
router.get('/terms/employee/:empId/paid', termsView, payrollPaidController.getByEmployee);
// Расчётный листок месяца в «Истории выплат»: период, дни табеля (рабочие / выходные), условия оплаты.
router.get('/terms/employee/:empId/payslip', termsView, payrollPaidController.getPayslip);
// «Экспорт» карточки сотрудника: условия и история выплат — два листа xlsx из снимка экрана.
router.post('/terms/card/export', termsView, payrollCardExportController.exportCard);

// ─── Удержания: справочник видов с подвидами (общий с кадрами) и удержания сотрудника ──
// Дерево «вид → подвиды» — то же, что у кадров (/api/staff-deductions/kinds), миграция 321.
router.get('/deduction-kinds', deductionsView, deductionSubkindsController.listKindTree);
router.post('/deduction-kinds', deductionsEdit, payrollDeductionsController.addKind);
router.patch('/deduction-kinds/:id', deductionsEdit, payrollDeductionsController.renameKind);
router.delete('/deduction-kinds/:id', deductionsEdit, payrollDeductionsController.deleteKind);
router.post('/deduction-kinds/:id/subkinds', deductionsEdit, deductionSubkindsController.add);
router.patch('/deduction-subkinds/:id', deductionsEdit, deductionSubkindsController.update);
router.delete('/deduction-subkinds/:id', deductionsEdit, deductionSubkindsController.remove);
// Удержания сотрудника (staff_deductions, миграции 318, 321) — в окне сотрудника только для чтения.
router.get('/deductions/employee/:empId/staff', deductionsView, payrollDeductionsController.getStaffByEmployee);

// ─── Справочник ставок (окно «Справочник» на «Расчётах») ─────────────────────
router.get('/rates', deductionsView, payrollRatesController.list);
router.post('/rates', deductionsEdit, payrollRatesController.add);
router.patch('/rates/:id', deductionsEdit, payrollRatesController.update);
router.delete('/rates/:id', deductionsEdit, payrollRatesController.remove);
// Кто живёт в общежитии — кнопка «Общежитие» в шапке «Справочника»; ведётся в «Управлении кадрами»,
// «Зарплата» только убирает: выезд 1-м числом месяца (PATCH) или ошибочная строка (DELETE).
router.get('/dormitory-stays', deductionsView, dormitoryStaysController.listForPayroll);
router.patch('/dormitory-stays/:id', deductionsEdit, dormitoryStaysController.closeForPayroll);
router.delete('/dormitory-stays/:id', deductionsEdit, dormitoryStaysController.removeForPayroll);

// ─── Таблицы окна «Справочник» (миграция 315) ────────────────────────────────
// «Доплата за проживание» — квартиры «Проживания» (миграция 320): те же записи, что во вкладке кадров.
router.get('/housing-allowances', termsView, payrollHousingController.list);
router.post('/housing-allowances', termsEdit, payrollHousingController.add);
router.patch('/housing-allowances/:id', termsEdit, payrollHousingController.update);
router.delete('/housing-allowances/:id', termsEdit, payrollHousingController.remove);
// «Доплата»: плановая (журнал окна сотрудника) и разовая.
router.get('/supplements', termsView, payrollSupplementsController.list);
router.post('/supplements/planned', termsEdit, payrollSupplementsController.addPlanned);
router.put('/supplements/planned/employee/:empId', termsEdit, payrollSupplementsController.setPlanned);
router.delete('/supplements/planned/employee/:empId', termsEdit, payrollSupplementsController.removePlanned);
router.post('/supplements/one-time', termsEdit, payrollSupplementsController.addOneTime);
router.patch('/supplements/one-time/:id', termsEdit, payrollSupplementsController.updateOneTime);
router.delete('/supplements/one-time/:id', termsEdit, payrollSupplementsController.removeOneTime);
// «Без проезда»: кому не выплачивать проезд, периоды «с — по».
router.get('/compensation-stops', deductionsView, payrollCompensationStopsController.list);
router.post('/compensation-stops', deductionsEdit, payrollCompensationStopsController.add);
router.patch('/compensation-stops/:id', deductionsEdit, payrollCompensationStopsController.update);
router.delete('/compensation-stops/:id', deductionsEdit, payrollCompensationStopsController.remove);
// «Доплата за общежитие» (миграция 317): кому платят за то, что не живёт в общежитии, периоды «с — по».
router.get('/dormitory-allowances', deductionsView, payrollDormitoryAllowancesController.list);
router.post('/dormitory-allowances', deductionsEdit, payrollDormitoryAllowancesController.add);
router.patch('/dormitory-allowances/:id', deductionsEdit, payrollDormitoryAllowancesController.update);
router.delete('/dormitory-allowances/:id', deductionsEdit, payrollDormitoryAllowancesController.remove);
// «Удержания» — удержания staff_deductions (миграция 321): те же записи, что во вкладке кадров «Удержания».
router.get('/staff-deductions', deductionsView, payrollStaffDeductionsController.list);
router.post('/staff-deductions', termsEdit, payrollStaffDeductionsController.add);
router.patch('/staff-deductions/:id', termsEdit, payrollStaffDeductionsController.update);
router.delete('/staff-deductions/:id', termsEdit, payrollStaffDeductionsController.remove);
// «Экспорт» видимых строк таблицы (:table — housing, supplements, compensation-stops, dormitory-allowances, deductions, summary).
router.post('/registry/:table/export', deductionsView, payrollRegistryController.exportTable);

// ─── «Свод» на «Расчётах»: «Оплачено» по объектам и категориям (только чтение) ──
router.get('/summary/months', termsView, payrollSummaryController.months);
router.get('/summary', termsView, payrollSummaryController.get);

// ─── Кому доступен раздел (окно «Справочник», только чтение; список ведётся в БД) ─
router.get('/section-access', deductionsView, payrollSectionAccessController.list);

// ─── Отпуск в карточке сотрудника (только чтение) ────────────────────────────
router.get('/vacation/employee/:empId', termsView, payrollVacationController.getByEmployee);

export default router;
