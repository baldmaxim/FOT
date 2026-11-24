import { Router } from 'express';

import { companyApartmentsController as apartments } from '../controllers/company-apartments.controller.js';
import { dormitoryCompensationPauseController as pause } from '../controllers/dormitory-compensation-pause.controller.js';
import { dormitoryDirectoryController as directory } from '../controllers/dormitory-directory.controller.js';
import { dormitoryPenaltiesController as penalties } from '../controllers/dormitory-penalties.controller.js';
import { dormitoryResidentsController as residents } from '../controllers/dormitory-residents.controller.js';
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
// Миграция 371: «Платно» и комментарий, «Переселить».
router.patch('/stays/:id/meta', dormitoryEdit, residents.updateMeta);
router.post('/stays/:id/move', dormitoryEdit, residents.move);
// Миграция 374: «Компенсация аренды» — приостановить, возобновить, завершить паузу.
router.post('/stays/:id/suspend', dormitoryEdit, pause.suspend);
router.post('/stays/:id/resume', dormitoryEdit, pause.resume);
router.post('/stays/:id/finish-pause', dormitoryEdit, pause.finish);
// Вкладки «Общежитие» и «Компенсация аренды».
router.get('/residents', dormitoryView, residents.residents);
router.get('/compensation', dormitoryView, residents.compensation);
// Вкладка «Квартира»: служебные квартиры и их жильцы.
router.get('/apartments', dormitoryView, apartments.list);
router.post('/apartments', dormitoryEdit, apartments.add);
router.patch('/apartments/:id', dormitoryEdit, apartments.update);
router.delete('/apartments/:id', dormitoryEdit, apartments.remove);
router.get('/employees/search', dormitoryEdit, c.searchEmployees);
// Названия общежитий справочника — выбор общежития в окнах заселения, правки и переселения.
router.get('/addresses', dormitoryEdit, c.listAddresses);
// Миграция 377: справочник общежитий («Общежитие» → «Справочник»).
router.get('/dormitories', dormitoryView, directory.list);
router.post('/dormitories', dormitoryEdit, directory.add);
router.patch('/dormitories/:id', dormitoryEdit, directory.update);
router.delete('/dormitories/:id', dormitoryEdit, directory.remove);
// Миграция 378: «История взысканий» («Общежитие»); check — для окна «Заселить» (до /:id).
router.get('/penalties', dormitoryView, penalties.list);
router.get('/penalties/check', dormitoryEdit, penalties.check);
router.post('/penalties', dormitoryEdit, penalties.add);
router.patch('/penalties/:id', dormitoryEdit, penalties.update);
router.delete('/penalties/:id', dormitoryEdit, penalties.remove);

export default router;
