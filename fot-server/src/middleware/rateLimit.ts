import rateLimit from 'express-rate-limit';
import type { Request } from 'express';
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
const FORWARDING_RATE_LIMIT_MAX = readLimit('FORWARDING_RATE_LIMIT_MAX', IS_PRODUCTION ? 5 : 20);
const LOGIN_PER_EMAIL_RATE_LIMIT_MAX = readLimit('LOGIN_PER_EMAIL_RATE_LIMIT_MAX', IS_PRODUCTION ? 12 : 20);
const FORGOT_PASSWORD_PER_EMAIL_RATE_LIMIT_MAX = readLimit('FORGOT_PASSWORD_PER_EMAIL_RATE_LIMIT_MAX', IS_PRODUCTION ? 3 : 10);

// Ключ для per-email лимитеров: нормализованный email из тела запроса +
// IP-fallback. Без email злоумышленник просто крутит (IP, login). С email
// ключом targeted-bruteforce одного аккаунта ловится даже из NAT.
function emailKeyGenerator(req: Request): string {
  const rawEmail = (req.body as { email?: unknown } | undefined)?.email;
  const ip = req.ip ?? 'unknown';
  if (typeof rawEmail !== 'string') return `ip:${ip}`;
  const email = rawEmail.trim().toLowerCase();
  return email ? `email:${email}` : `ip:${ip}`;
}

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

// Переадресация в ЛК: каждая запись — реальный write-вызов в МТС. Ключ — сам
// пользователь (роут под authenticate), а не IP: за NAT офиса один IP на всех.
export const forwardingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: FORWARDING_RATE_LIMIT_MAX,
  skip: skipInDev,
  keyGenerator: (req: Request): string => {
    const userId = (req as Request & { user?: { id?: string } }).user?.id;
    return userId ? `user:${userId}` : `ip:${req.ip ?? 'unknown'}`;
  },
  message: { success: false, error: 'Слишком много изменений переадресации, попробуйте через час' },
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

// Targeted-bruteforce защита для login: 12/15min на конкретный email.
// authLimiter (по IP) недостаточно — за NAT 50 человек делят IP-окно.
// В счётчик попадает только настоящий неверный пароль (401 invalid_credentials):
// контроллер login отдаёт 401 лишь на неверные креды; success/2FA — 200,
// pending-approval — 403, валидация — 400, прочее — 404/500, 429 самого
// лимитера — statusCode≠401. requestWasSuccessful=true декрементит hit, поэтому
// PENDING_APPROVAL/валидация/успех не выжигают лимит реальному пользователю.
export const loginPerEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: LOGIN_PER_EMAIL_RATE_LIMIT_MAX,
  skip: skipInDev,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_req, res) => res.statusCode !== 401,
  keyGenerator: emailKeyGenerator,
  message: { success: false, error: 'Слишком много попыток входа для этого email, попробуйте через 15 минут' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Reset-password: 3/15min на email — защита от спама писем.
export const forgotPasswordPerEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: FORGOT_PASSWORD_PER_EMAIL_RATE_LIMIT_MAX,
  skip: skipInDev,
  keyGenerator: emailKeyGenerator,
  message: { success: false, error: 'Слишком много запросов восстановления пароля, попробуйте через 15 минут' },
  standardHeaders: true,
  legacyHeaders: false,
});
