import { Router } from 'express';

import { dormitoryStaysController as c } from '../controllers/dormitory-stays.controller.js';
import { authenticate, requireAnyPageAccess, requirePageAccess } from '../middleware/auth.js';
import { noStore } from '../middleware/noStore.js';

const router = Router();

router.use(authenticate);
// Список меняют правки на этой же вкладке: без no-store браузер 30 с отдавал бы прежний (app.ts).
router.use(noStore);

// Гарды именованными алиасами — их распознаёт `npm run audit:routes`.
const dormitoryView = requirePageAccess('/staff-control/dormitory', 'view');
const dormitoryEdit = requirePageAccess('/staff-control/dormitory', 'edit');
// Выгрузка — и из вкладки кадров, и из «Справочника» «Зарплаты» (там та же таблица, только чтение).
const dormitoryExport = requireAnyPageAccess(
  ['/staff-control/dormitory', '/salary/terms', '/salary/payments'],
  'view',
);

router.get('/stays', dormitoryView, c.list);
router.post('/stays/export', dormitoryExport, c.exportTable);
router.post('/stays', dormitoryEdit, c.add);
router.patch('/stays/:id', dormitoryEdit, c.update);
router.delete('/stays/:id', dormitoryEdit, c.remove);
router.get('/employees/search', dormitoryEdit, c.searchEmployees);

export default router;
