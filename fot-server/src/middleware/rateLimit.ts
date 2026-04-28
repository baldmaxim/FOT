import rateLimit from 'express-rate-limit';
import { IS_PRODUCTION } from '../config/features.js';

const skipInDev = (): boolean => !IS_PRODUCTION;
const readLimit = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const API_RATE_LIMIT_MAX = readLimit('API_RATE_LIMIT_MAX', IS_PRODUCTION ? 10000 : 1000);
const AUTH_RATE_LIMIT_MAX = readLimit('AUTH_RATE_LIMIT_MAX', IS_PRODUCTION ? 100 : 50);
const REFRESH_RATE_LIMIT_MAX = readLimit('REFRESH_RATE_LIMIT_MAX', IS_PRODUCTION ? 1000 : 300);
const TWO_FACTOR_RATE_LIMIT_MAX = readLimit('TWO_FACTOR_RATE_LIMIT_MAX', IS_PRODUCTION ? 30 : 20);
const IMPORT_RATE_LIMIT_MAX = readLimit('IMPORT_RATE_LIMIT_MAX', IS_PRODUCTION ? 5 : 10);

export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: API_RATE_LIMIT_MAX,
  skip: skipInDev,
  message: { success: false, error: 'Слишком много запросов, попробуйте позже' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: AUTH_RATE_LIMIT_MAX,
  skip: skipInDev,
  skipSuccessfulRequests: true,
  message: { success: false, error: 'Слишком много попыток входа, попробуйте через 15 минут' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: REFRESH_RATE_LIMIT_MAX,
  skip: skipInDev,
  skipSuccessfulRequests: true,
  message: { success: false, error: 'Слишком много запросов обновления сессии, попробуйте позже' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const twoFactorLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: TWO_FACTOR_RATE_LIMIT_MAX,
  skip: skipInDev,
  skipSuccessfulRequests: true,
  message: { success: false, error: 'Слишком много попыток 2FA, попробуйте через 5 минут' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const importLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: IMPORT_RATE_LIMIT_MAX,
  skip: skipInDev,
  message: { success: false, error: 'Слишком много импортов, попробуйте через час' },
  standardHeaders: true,
  legacyHeaders: false,
});
