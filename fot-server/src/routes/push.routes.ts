import { Router } from 'express';
import { pushController } from '../controllers/push.controller.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// Публичный — нужен для инициализации на фронте до логина
router.get('/vapid-public-key', pushController.getVapidPublicKey);

router.use(authenticate);
router.post('/subscribe', pushController.subscribe);
router.delete('/subscribe', pushController.unsubscribe);

export default router;
