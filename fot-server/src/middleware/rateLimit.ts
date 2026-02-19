import rateLimit from 'express-rate-limit';

// Общий лимит для API (увеличен для разработки)
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 500, // 500 запросов с одного IP (увеличено с 100)
  message: { success: false, error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Строгий лимит для авторизации (увеличен для разработки)
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 50, // 50 попыток входа (увеличено с 10)
  message: { success: false, error: 'Too many login attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Лимит для 2FA (увеличен для разработки)
export const twoFactorLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 минут
  max: 20, // 20 попыток (увеличено с 5)
  message: { success: false, error: 'Too many 2FA attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Лимит для импорта файлов
export const importLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 час
  max: 10, // 10 импортов в час
  message: { success: false, error: 'Too many import requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});
