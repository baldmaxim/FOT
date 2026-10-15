import type { Request } from 'express';

// Key-builder кэша GET /api/sigur/admin/employees. Вынесен из sigur.routes.ts, чтобы
// тестировать напрямую. blocked обязателен: «Все» и «Заблокированные» одного отдела —
// разные ответы, без него фильтр в пределах TTL отдавал чужой (пустой) список.
export const buildSigurAdminEmployeesCacheKey = (req: Request): string =>
  [
    'sae',
    req.query.departmentId ?? '',
    req.query.search ?? '',
    req.query.blocked ?? '',
    req.query.page ?? 1,
    req.query.pageSize ?? '',
  ].join(':');
