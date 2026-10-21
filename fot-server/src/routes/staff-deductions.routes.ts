import { Router } from 'express';

import { staffDeductionsController as c } from '../controllers/staff-deductions.controller.js';
import { authenticate, requirePageAccess } from '../middleware/auth.js';
import { noStore } from '../middleware/noStore.js';

const router = Router();

router.use(authenticate);
// Список меняют правки на этой же вкладке: без no-store браузер 30 с отдавал бы прежний (app.ts).
router.use(noStore);

// Гарды именованными алиасами — их распознаёт `npm run audit:routes`.
const deductionsView = requirePageAccess('/staff-control/deductions', 'view');
const deductionsEdit = requirePageAccess('/staff-control/deductions', 'edit');

router.get('/', deductionsView, c.list);
router.post('/export', deductionsView, c.exportTable);
router.get('/kinds', deductionsView, c.listKinds);
router.post('/kinds', deductionsEdit, c.addKind);
router.patch('/kinds/:id', deductionsEdit, c.updateKind);
router.delete('/kinds/:id', deductionsEdit, c.deleteKind);
router.get('/employees/search', deductionsEdit, c.searchEmployees);
router.post('/', deductionsEdit, c.add);
router.patch('/:id', deductionsEdit, c.update);
router.delete('/:id', deductionsEdit, c.remove);

export default router;
