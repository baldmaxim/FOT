// Диагностический access-log: пишет ОДНУ строку на медленный/ошибочный запрос,
// чтобы видеть «кто/что грузит сайт» без флуда логов на 800+ юзерах.
//
// Логируем только если запрос дольше SLOW_REQUEST_MS (по умолчанию 1500 мс)
// ИЛИ статус >= 500. Формат стабильный и грепабельный:
//   [req] 12453ms 200 GET /api/timesheet user=<uuid> emp=123 ip=1.2.3.4
//
// Поля user/emp берутся в момент res 'finish' — к этому времени auth-middleware
// уже проставил req.user. Маршрут — без query-string (PII/кардинальность).

import type { NextFunction, Request, Response } from 'express';

const SLOW_REQUEST_MS = (() => {
  const raw = Number.parseInt(process.env.SLOW_REQUEST_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1500;
})();

export function accessLog(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const isSlow = elapsedMs >= SLOW_REQUEST_MS;
    const isServerError = res.statusCode >= 500;
    if (!isSlow && !isServerError) return;

    const path = req.originalUrl.split('?')[0];
    const user = req.user as Request['user'] | undefined;
    const userId = user?.id ?? '-';
    const empId = user?.employee_id ?? '-';
    const ip = req.ip ?? '-';
    const tag = isServerError ? '[req:err]' : '[req:slow]';

    console.warn(
      `${tag} ${elapsedMs.toFixed(0)}ms ${res.statusCode} ${req.method} ${path} ` +
      `user=${userId} emp=${empId} ip=${ip}`,
    );
  });

  next();
}
