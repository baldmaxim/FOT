/**
 * Классификация ошибок pg-Pool, которые НЕ являются ошибкой приложения.
 *
 * Насыщение пула (DATABASE_POOL_MAX, connectionTimeoutMillis в config/postgres.ts)
 * — это перегрузка, а не баг обработчика: правильный ответ клиенту 503 + Retry-After,
 * а не 500. Иначе всплеск параллельных запросов (см. массовую объектную правку
 * табеля) выглядит в мониторинге как сотня ошибок приложения.
 *
 * Тексты сообщений — из pg-pool: 'timeout exceeded when trying to connect'
 * (ожидание свободного коннекта) и 'Connection terminated due to connection timeout'
 * (не успели установить новое соединение). Кода ошибки у них нет, поэтому
 * сопоставляем по сообщению.
 */

export const DB_POOL_BUSY_CODE = 'db_pool_busy';
export const DB_POOL_BUSY_MESSAGE = 'Сервер занят — слишком много одновременных запросов. Повторите попытку.';

const POOL_TIMEOUT_PATTERNS = [
  /timeout exceeded when trying to connect/i,
  /connection terminated due to connection timeout/i,
];

/** true, если ошибка — таймаут аренды/установки соединения pg-Pool. */
export const isPoolAcquireTimeout = (err: unknown): boolean => {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (!message) return false;
  return POOL_TIMEOUT_PATTERNS.some(pattern => pattern.test(message));
};
