import { Router } from 'express';

import { staffCorrectionsController as c } from '../controllers/staff-corrections.controller.js';
import { authenticate, requirePageAccess } from '../middleware/auth.js';
import { noStore } from '../middleware/noStore.js';

const router = Router();

router.use(authenticate);
// Правка в окне дня сразу меняет журнал: без no-store браузер отдавал бы прежний ответ.
router.use(noStore);

// Гард именованным алиасом — его распознаёт `npm run audit:routes`.
const correctionsView = requirePageAccess('/staff-control/corrections', 'view');

router.get('/', correctionsView, c.list);
router.get('/skud', correctionsView, c.skud);
router.post('/export', correctionsView, c.exportTable);

export default router;
