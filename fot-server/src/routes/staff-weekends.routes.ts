import { Router } from 'express';

import { staffWeekendsController as c } from '../controllers/staff-weekends.controller.js';
import { authenticate, requirePageAccess } from '../middleware/auth.js';
import { noStore } from '../middleware/noStore.js';

const router = Router();

router.use(authenticate);
// День уходит из списка, как только появится корректировка: без no-store браузер 30 с отдавал бы прежний (app.ts).
router.use(noStore);

// Гард именованным алиасом — его распознаёт `npm run audit:routes`.
const weekendsView = requirePageAccess('/staff-control/weekends', 'view');

router.get('/', weekendsView, c.list);
router.post('/export', weekendsView, c.exportTable);

export default router;
