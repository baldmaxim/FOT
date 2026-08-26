// Лимит запросов для публичного data-api (/api/public/v1).
//
// Отдельный файл, а не строка в rateLimit.ts: там лимитеры per-IP и per-user, а здесь
// ключ лимита — сам API-ключ. 1С ходит с одного адреса, поэтому общий apiLimiter либо
// душил бы её, либо был бы бесполезно большим для остальных.
//
// Значение берём из самого ключа (data_api_keys.rate_limit_per_minute) — оно уже лежит
// в req.dataApiKey после dataApiAuth. До аутентификации ключа ещё нет, поэтому там
// падаем на IP: иначе все анонимные 401-запросы делили бы один счётчик.

import rateLimit from 'express-rate-limit';
import type { Request } from 'express';
import { IS_PRODUCTION } from '../config/features.js';
import type { DataApiKeyContext } from './dataApiAuth.js';

const DEFAULT_LIMIT_PER_MINUTE = 60;

const keyOf = (req: Request): DataApiKeyContext | undefined =>
  (req as Request & { dataApiKey?: DataApiKeyContext }).dataApiKey;

export const dataApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: (req: Request): number => {
    const limit = keyOf(req)?.rate_limit_per_minute;
    return typeof limit === 'number' && limit > 0 ? limit : DEFAULT_LIMIT_PER_MINUTE;
  },
  // В dev лимит не мешает отладке интеграции — как и у остальных лимитеров проекта.
  skip: (): boolean => !IS_PRODUCTION,
  keyGenerator: (req: Request): string => {
    const key = keyOf(req);
    return key?.id ? `dataapi:${key.id}` : `ip:${req.ip ?? 'unknown'}`;
  },
  message: { success: false, error: 'Слишком много запросов, попробуйте позже' },
  standardHeaders: true,
  legacyHeaders: false,
});
