import type { NextFunction, Request, Response } from 'express';
import { dataApiKeyService } from '../services/data-api-key.service.js';

export interface DataApiKeyContext {
  id: string;
  name: string;
  rate_limit_per_minute: number;
}

/**
 * Аутентификация публичного data-api токена (Bearer fot_<prefix>_<secret>).
 * Кладёт ключ в req.dataApiKey. На любую ошибку — 401 (формулировки как в
 * fot-data-api /external/v1: Invalid token format / Invalid token / revoked / expired).
 * Используется только публичными роутами (НЕ JWT-эндпоинтами).
 */
export async function dataApiAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header) {
    res.status(401).json({ success: false, error: 'Missing Authorization header' });
    return;
  }
  const parts = header.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    res.status(401).json({ success: false, error: 'Invalid Authorization header' });
    return;
  }

  const result = await dataApiKeyService.authenticateRawToken(parts[1]);
  if (!result.ok) {
    res.status(401).json({ success: false, error: result.detail });
    return;
  }

  (req as Request & { dataApiKey?: DataApiKeyContext }).dataApiKey = result.key;
  next();
}
