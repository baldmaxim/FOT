import type { Request } from 'express';

// Key-builder'ы кэшей GET /api/timesheet. Вынесены из timesheet.routes.ts, чтобы
// тестировать напрямую (роутер для этого поднимать не нужно).

// Эффективное значение include_empty — ровно та же формула, что в getAll
// (timesheet.controller): фильтр «пустых» применяется только при явном '0'.
// Нормализация нужна кэшу: отсутствие параметра и '1' дают один и тот же ответ
// и должны жить в одном bucket'е, иначе тумблер в пределах TTL отдаёт чужой вариант.
const normalizeIncludeEmpty = (req: Request): '0' | '1' =>
  req.query.include_empty !== '0' ? '1' : '0';

const buildKey = (prefix: string, req: Request): string =>
  [
    prefix,
    req.query.month ?? '',
    req.query.department_id ?? 'all',
    req.query.employee_id ?? '',
    // employee_ids: HR-снимок персональной подачи — разные снимки одного
    // пользователя обязаны жить в разных bucket'ах.
    req.query.employee_ids ?? '',
    req.query.from ?? '',
    req.query.to ?? '',
    req.query.half ?? '',
    req.query.include_objects ?? '',
    normalizeIncludeEmpty(req),
    req.query.schedule_payload ?? '',
    req.user.id,
    req.user.show_actual_hours ? '1' : '0',
  ].join(':');

export const buildTimesheetCacheKey = (req: Request): string =>
  buildKey('ts', req);

export const buildTimesheetTodayCacheKey = (req: Request): string =>
  buildKey('ts-today', req);
