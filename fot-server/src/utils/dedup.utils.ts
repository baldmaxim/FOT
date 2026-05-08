import crypto from 'crypto';

/**
 * Вычисляет детерминистический хэш для дедупликации событий СКУД.
 * Минутная точность (HH:MM) — схлопывает события от нескольких датчиков за 1-3 сек.
 * access_point + direction в ключе — сохраняет легитимные разные события.
 */
export const computeDedupHash = (
  name: string,
  eventDate: string,
  eventTime: string,
  accessPoint: string | null,
  direction: string | null,
): string => {
  const namePart = name.toLowerCase().trim();
  const timePart = eventTime.slice(0, 5); // HH:MM
  const apPart = (accessPoint || '').toLowerCase().trim();
  const dirPart = (direction || '').toLowerCase().trim();
  const key = `${namePart}|${eventDate}|${timePart}|${apPart}|${dirPart}`;
  return crypto.createHash('sha256').update(key).digest('hex');
};

/**
 * Дедупликация ошибочных событий Sigur (PASS_DENY и т.п.).
 * Отличия от computeDedupHash:
 *   - failureType в ключе: разные типы ошибок в одну минуту — разные события.
 *   - card_number в ключе: при отсутствии имени (карта не распознана) разделяет события.
 *   - rawId в ключе как финальный tie-breaker: два подряд отказа карты с одинаковыми
 *     остальными полями всё равно сохраняются раздельно (raw id из Sigur уникален).
 */
export const computeFailureDedupHash = (
  name: string | null,
  cardNumber: string | null,
  eventDate: string,
  eventTime: string,
  accessPoint: string | null,
  direction: string | null,
  failureType: string,
  rawId: number | null,
): string => {
  const namePart = (name || '').toLowerCase().trim();
  const cardPart = (cardNumber || '').toLowerCase().trim();
  const timePart = eventTime.slice(0, 5);
  const apPart = (accessPoint || '').toLowerCase().trim();
  const dirPart = (direction || '').toLowerCase().trim();
  const typePart = failureType.toLowerCase().trim();
  const idPart = rawId != null ? String(rawId) : '';
  const key = `${namePart}|${cardPart}|${eventDate}|${timePart}|${apPart}|${dirPart}|${typePart}|${idPart}`;
  return crypto.createHash('sha256').update(key).digest('hex');
};
