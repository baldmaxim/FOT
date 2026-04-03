import rateLimit from 'express-rate-limit';
import { IS_PRODUCTION } from '../config/features.js';

const skipInDev = (): boolean => !IS_PRODUCTION;

export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: IS_PRODUCTION ? 500 : 1000,
  skip: skipInDev,
  message: { success: false, error: 'Слишком много запросов, попробуйте позже' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: IS_PRODUCTION ? 10 : 50,
  skip: skipInDev,
  message: { success: false, error: 'Слишком много попыток входа, попробуйте через 15 минут' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const twoFactorLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: IS_PRODUCTION ? 5 : 20,
  skip: skipInDev,
  message: { success: false, error: 'Слишком много попыток 2FA, попробуйте через 5 минут' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const importLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: IS_PRODUCTION ? 5 : 10,
  skip: skipInDev,
  message: { success: false, error: 'Слишком много импортов, попробуйте через час' },
  standardHeaders: true,
  legacyHeaders: false,
});
