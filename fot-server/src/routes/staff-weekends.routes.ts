import { Router } from 'express';

import { staffWeekendsController as c } from '../controllers/staff-weekends.controller.js';
import {
  requireWeekendPeriodManage,
  staffWeekendPeriodsController as periods,
} from '../controllers/staff-weekends-periods.controller.js';
import { authenticate, requirePageAccess, resolveTimesheetLockToggle } from '../middleware/auth.js';
import { noStore } from '../middleware/noStore.js';

const router = Router();

router.use(authenticate);
// День уходит из списка, как только появится корректировка: без no-store браузер 30 с отдавал бы прежний (app.ts).
router.use(noStore);

// Гард именованным алиасом — его распознаёт `npm run audit:routes`.
const weekendsView = requirePageAccess('/staff-control/weekends', 'view');

// Прежний список: нужен старой вкладке до выката фронтенда, затем удалить.
router.get('/', weekendsView, c.list);
router.get('/grid', weekendsView, resolveTimesheetLockToggle, c.grid);
router.post('/export', weekendsView, c.exportTable);

// Открыть и закрыть табель отдела. Право вкладки + право снимать замок и охват «все отделы».
router.get('/periods/preview', weekendsView, resolveTimesheetLockToggle, requireWeekendPeriodManage, periods.preview);
router.post('/periods/open', weekendsView, resolveTimesheetLockToggle, requireWeekendPeriodManage, periods.open);
router.post('/periods/close', weekendsView, resolveTimesheetLockToggle, requireWeekendPeriodManage, periods.close);

export default router;
