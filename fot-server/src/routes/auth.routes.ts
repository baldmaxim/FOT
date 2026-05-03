import { Router } from 'express';
import { authController } from '../controllers/auth.controller.js';
import { auth2faSelfController } from '../controllers/auth-2fa-self.controller.js';
import { authenticate } from '../middleware/auth.js';
import {
  authLimiter,
  refreshLimiter,
  twoFactorLimiter,
  loginPerEmailLimiter,
  forgotPasswordPerEmailLimiter,
} from '../middleware/rateLimit.js';

const router = Router();

// Публичные роуты
router.post('/register', authLimiter, authController.register);
// Login защищён двумя лимитерами: per-IP (общий пул из NAT) и per-email
// (targeted-bruteforce одного аккаунта сквозь NAT).
router.post('/login', authLimiter, loginPerEmailLimiter, authController.login);
router.post('/refresh', refreshLimiter, authController.refresh);
router.post('/logout', authController.logout);
router.post('/forgot-password', authLimiter, forgotPasswordPerEmailLimiter, authController.forgotPassword);
router.post('/reset-password', authLimiter, authController.resetPassword);

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

// Self-service 2FA
router.post('/2fa/setup', authenticate, auth2faSelfController.setup2FA);
router.post('/2fa/enable', twoFactorLimiter, authenticate, auth2faSelfController.enable2FA);
router.post('/2fa/disable', authenticate, auth2faSelfController.disable2FA);

export default router;
