// Общие помощники публичных методов data-api на Node (/api/public/v1): обмен табелями и API для ЗУП3.

import type { Request, Response } from 'express';
import { dataApiKeyService } from '../services/data-api-key.service.js';
import type { DataApiKeyContext } from '../middleware/dataApiAuth.js';

export function keyOf(req: Request): DataApiKeyContext | undefined {
  return (req as Request & { dataApiKey?: DataApiKeyContext }).dataApiKey;
}

export function fail(res: Response, status: number, error: string, code?: string, extra?: Record<string, unknown>): void {
  const body: Record<string, unknown> = { success: false, error };
  if (code) body.code = code;
  if (extra) Object.assign(body, extra);
  res.status(status).json(body);
}

/** Гейт: ключу должна быть открыта таблица employees (табель — данные сотрудников). */
export async function ensureEmployeesAccess(req: Request, res: Response): Promise<DataApiKeyContext | null> {
  const keyCtx = keyOf(req);
  if (!keyCtx) {
    fail(res, 401, 'Unauthorized');
    return null;
  }
  let keyTables: Array<{ table_name: string }>;
  try {
    keyTables = await dataApiKeyService.getKeyTables(keyCtx.id);
  } catch {
    fail(res, 500, 'Failed to resolve key access');
    return null;
  }
  if (!keyTables.some(t => t.table_name === 'employees')) {
    fail(res, 403, 'Ключу не открыта таблица employees — табель недоступен');
    return null;
  }
  return keyCtx;
}
