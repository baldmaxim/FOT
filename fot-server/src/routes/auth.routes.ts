import { Router } from 'express';
import { authController } from '../controllers/auth.controller.js';
import { authenticate } from '../middleware/auth.js';
import { authLimiter, twoFactorLimiter } from '../middleware/rateLimit.js';

const router = Router();

// Публичные роуты
router.post('/register', authLimiter, authController.register);
router.post('/login', authLimiter, authController.login);
router.post('/forgot-password', authLimiter, authController.forgotPassword);
router.post('/reset-password', authLimiter, authController.resetPassword);
router.get('/organizations', authController.getOrganizations);

// Роуты требующие аутентификации
router.post(
  '/verify-2fa',
  twoFactorLimiter,
  authenticate,
  authController.verify2FA
);

router.post(
  '/recovery',
  twoFactorLimiter,
  authenticate,
  authController.useRecoveryCode
);

router.get('/me', authenticate, authController.getMe);

export default router;
