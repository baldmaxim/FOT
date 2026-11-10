import { Router } from 'express';

import { deductionSubkindsController as subkinds } from '../controllers/deduction-subkinds.controller.js';
import { staffDeductionsController as c } from '../controllers/staff-deductions.controller.js';
import { authenticate, requirePageAccess, requireRolePageAccess } from '../middleware/auth.js';
import { noStore } from '../middleware/noStore.js';

const router = Router();

router.use(authenticate);
// Список меняют правки на этой же вкладке: без no-store браузер 30 с отдавал бы прежний (app.ts).
router.use(noStore);

// Гарды именованными алиасами — их распознаёт `npm run audit:routes`.
const deductionsView = requirePageAccess('/staff-control/deductions', 'view');
const deductionsEdit = requirePageAccess('/staff-control/deductions', 'edit');
// Справочник видов общий с «Зарплатой»: правит только роль, персональная галочка (миграция 351) — нет.
const deductionKindsEdit = requireRolePageAccess('/staff-control/deductions', 'edit');

router.get('/', deductionsView, c.list);
router.post('/export', deductionsView, c.exportTable);
// Дерево «вид → подвиды» — то же, что у «Зарплаты» (/api/payroll/deduction-kinds), миграция 321.
router.get('/kinds', deductionsView, subkinds.listKindTree);
router.post('/kinds', deductionKindsEdit, c.addKind);
router.patch('/kinds/:id', deductionKindsEdit, c.updateKind);
router.delete('/kinds/:id', deductionKindsEdit, c.deleteKind);
router.post('/kinds/:id/subkinds', deductionKindsEdit, subkinds.add);
router.patch('/subkinds/:id', deductionKindsEdit, subkinds.update);
router.delete('/subkinds/:id', deductionKindsEdit, subkinds.remove);
router.get('/employees/search', deductionsEdit, c.searchEmployees);
// «Плановые удержания» (миграция 357) — те же записи, что у «Зарплаты»; by-month — развёртка по месяцам, как в расчёте.
router.get('/planned', deductionsView, c.plannedList);
router.get('/planned/by-month', deductionsView, c.plannedListByMonth);
router.post('/planned/export', deductionsView, c.plannedExport);
router.post('/planned', deductionsEdit, c.plannedAdd);
router.patch('/planned/:id', deductionsEdit, c.plannedUpdate);
router.delete('/planned/:id', deductionsEdit, c.plannedRemove);
router.post('/', deductionsEdit, c.add);
router.patch('/:id', deductionsEdit, c.update);
router.delete('/:id', deductionsEdit, c.remove);

export default router;
