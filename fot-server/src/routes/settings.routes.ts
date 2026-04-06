import { Router } from 'express';
import { settingsController } from '../controllers/settings.controller.js';
import { authenticate, requireSuperAdmin } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);
router.use(requireSuperAdmin);

// GET /api/settings — все настройки
router.get('/', settingsController.getAll);

// GET /api/settings/r2/status — статус R2
router.get('/r2/status', settingsController.getR2Status);

// PUT /api/settings/r2 — сохранить R2 настройки
router.put('/r2', settingsController.saveR2);

// POST /api/settings/r2/test — тест подключения R2
router.post('/r2/test', settingsController.testR2);

export default router;
