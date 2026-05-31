import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { noStore } from '../middleware/noStore.js';
import { portalPresence } from '../services/portal-presence.service.js';

const router = Router();

router.use(authenticate);

// Кто сейчас онлайн на портале (держит Socket.IO-коннект). Список нужен чату
// для всех ролей, поэтому ограничиваемся authenticate; страницы кадров/всех
// пользователей закрыты собственным page-access. noStore — статус живой.
router.get('/online', noStore, (_req, res) => {
  res.json(portalPresence.getSnapshot());
});

export default router;
