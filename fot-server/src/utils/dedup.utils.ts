import crypto from 'crypto';

/**
 * Вычисляет детерминистический хэш для дедупликации событий СКУД.
 *
 * Sigur-источники (presence-polling, sigur-sync) передают rawId — числовой id
 * события из Sigur, уникальный на физическое событие. Тогда ключ строится по нему:
 * это НЕ теряет разные проходы в одну минуту (раньше HH:MM схлопывал — напр.
 * Вакулина 14:22:20 и 14:22:22 exit на одной точке давали один хэш, второй проход
 * терялся), но по-прежнему ловит повтор ОДНОГО события из перекрытых окон
 * поллинга/синка и пагинации Sigur (тот же rawId → тот же хэш → ON CONFLICT DO
 * NOTHING). access_point + direction в ключе — страховка от переиспользования rawId
 * между точками/направлениями. Дребезг датчика (Sigur даёт каждому пробою свой
 * rawId) сохраняется как отдельные события и гасится на расчёте (Σ закрытых пар),
 * а не теряется на вставке.
 *
 * Источники без стабильного id (Excel-импорт 1С — rawId не передан) сохраняют
 * минутную точность (HH:MM), как раньше: схлопывают дребезг нескольких датчиков за
 * 1-3 сек.
 */
export const computeDedupHash = (
  name: string,
  eventDate: string,
  eventTime: string,
  accessPoint: string | null,
  direction: string | null,
  rawId: number | null = null,
): string => {
  const namePart = name.toLowerCase().trim();
  const apPart = (accessPoint || '').toLowerCase().trim();
  const dirPart = (direction || '').toLowerCase().trim();
  if (rawId != null) {
    const key = `${namePart}|${eventDate}|${apPart}|${dirPart}|sigur:${rawId}`;
    return crypto.createHash('sha256').update(key).digest('hex');
  }
  const timePart = eventTime.slice(0, 5); // HH:MM
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
