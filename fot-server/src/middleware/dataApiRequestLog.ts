import type { NextFunction, Request, Response } from 'express';
import { dataApiKeyService } from '../services/data-api-key.service.js';
import type { DataApiKeyContext } from './dataApiAuth.js';

/**
 * Пишет строку в data_api_request_logs на каждый запрос публичного data-api
 * (Node-ветка /api/public/v1/*) — аналог middleware access_log_and_limit в
 * fot-data-api/app/main.py. Без него «Лог запросов» в админке оставался пустым,
 * хотя 1С ходит именно сюда.
 *
 * Подключать ДО dataApiAuth: тогда в лог попадают и 401-е (с key_id = null).
 * Ключ читаем в момент 'finish' — к этому времени dataApiAuth его уже проставил.
 */
export function dataApiRequestLog(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const keyCtx = (req as Request & { dataApiKey?: DataApiKeyContext }).dataApiKey;
    const latencyMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
    // req.path внутри роутера — путь относительно точки монтирования: '/timesheet'.
    const resource = req.path.replace(/^\/+|\/+$/g, '') || null;
    const queryParams = Object.keys(req.query).length > 0 ? req.query : null;
    const error = (res.locals as { dataApiError?: string }).dataApiError ?? null;

    void dataApiKeyService.writeRequestLog({
      key_id: keyCtx?.id ?? null,
      table_name: resource,
      ip: req.ip ?? null,
      status_code: res.statusCode,
      latency_ms: latencyMs,
      query_params: queryParams,
      error_message: error,
    });
  });

  next();
}
