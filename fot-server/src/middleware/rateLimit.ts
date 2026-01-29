import rateLimit from 'express-rate-limit';

// Общий лимит для API
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 100, // 100 запросов с одного IP
  message: { success: false, error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Строгий лимит для авторизации
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 10, // 10 попыток входа
  message: { success: false, error: 'Too many login attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Лимит для 2FA
export const twoFactorLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 минут
  max: 5, // 5 попыток
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
