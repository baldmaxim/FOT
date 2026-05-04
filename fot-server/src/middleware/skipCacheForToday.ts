import {
  resolveTimesheetDateRange,
  resolveTimesheetPeriodRange,
} from '../services/timesheet-department-assignments.service.js';
import { formatDateToISO } from '../utils/date.utils.js';

/**
 * Оборачивает кэш-middleware: если запрашиваемый диапазон содержит сегодняшний день,
 * пропускает запрос мимо кэша. Иначе — отдаёт кэшированный ответ.
 *
 * Зачем: часы за сегодня живые, обновляются с каждым проходом СКУД, и 5-минутный TTL
 * кэша ведёт к расхождению между разными страницами (карточка пересчитывает live на фронте,
 * табель отдела — нет).
 *
 * Тип `cache` — Express middleware с дополнительными методами `.invalidate` / `.invalidateKey`.
 * Используем `any`, чтобы не тянуть глобальную аугментацию `Express.Request['user']` в роут-файлы
 * и не плодить рассинхрон с `AuthenticatedRequest`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const cacheUnlessRangeIncludesToday = (cache: any): any => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapped: any = (req: any, res: any, next: any) => {
    const month = typeof req.query.month === 'string' ? req.query.month : '';
    if (!month) return cache(req, res, next);

    const fromParam = typeof req.query.from === 'string' ? req.query.from : null;
    const toParam = typeof req.query.to === 'string' ? req.query.to : null;
    const halfParam = typeof req.query.half === 'string' ? req.query.half : null;

    const range = (fromParam && toParam)
      ? resolveTimesheetDateRange(month, fromParam, toParam)
      : resolveTimesheetPeriodRange(month, halfParam);
    if (!range) return cache(req, res, next);

    const todayStr = formatDateToISO(new Date());
    if (todayStr >= range.startDate && todayStr <= range.endDate) {
      return next();
    }
    return cache(req, res, next);
  };
  wrapped.invalidate = cache.invalidate;
  wrapped.invalidateKey = cache.invalidateKey;
  return wrapped;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const cacheWithShortTtlForToday = (longCache: any, todayCache: any): any => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapped: any = (req: any, res: any, next: any) => {
    const month = typeof req.query.month === 'string' ? req.query.month : '';
    if (!month) return longCache(req, res, next);

    const fromParam = typeof req.query.from === 'string' ? req.query.from : null;
    const toParam = typeof req.query.to === 'string' ? req.query.to : null;
    const halfParam = typeof req.query.half === 'string' ? req.query.half : null;

    const range = (fromParam && toParam)
      ? resolveTimesheetDateRange(month, fromParam, toParam)
      : resolveTimesheetPeriodRange(month, halfParam);
    if (!range) return longCache(req, res, next);

    const todayStr = formatDateToISO(new Date());
    if (todayStr >= range.startDate && todayStr <= range.endDate) {
      return todayCache(req, res, next);
    }
    return longCache(req, res, next);
  };
  wrapped.invalidate = () => {
    longCache.invalidate();
    todayCache.invalidate();
  };
  wrapped.invalidateKey = (key: string) => {
    longCache.invalidateKey(key);
    todayCache.invalidateKey(key);
  };
  return wrapped;
};
