import { Router } from 'express';
import { authController } from '../controllers/auth.controller.js';
import { authenticate } from '../middleware/auth.js';
import { authLimiter, twoFactorLimiter } from '../middleware/rateLimit.js';
import type { AuthenticatedRequest } from '../types/index.js';

const router = Router();

// Публичные роуты
router.post('/register', authLimiter, authController.register);
router.post('/login', authLimiter, authController.login);
router.get('/organizations', authController.getOrganizations);

// Роуты требующие аутентификации
router.post(
  '/verify-2fa',
  twoFactorLimiter,
  authenticate as any,
  authController.verify2FA as any
);

router.post(
  '/recovery',
  twoFactorLimiter,
  authenticate as any,
  authController.useRecoveryCode as any
);

router.get('/me', authenticate as any, authController.getMe as any);

export default router;
