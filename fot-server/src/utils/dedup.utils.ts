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
