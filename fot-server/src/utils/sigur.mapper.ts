/**
 * Маппер событий Sigur REST API → формат skud_events.
 *
 * Реальный формат Sigur /api/v1/events/parsed:
 * {
 *   eventType: "PASS_DETECTED",
 *   timestamp: "2026-02-02T10:23:23+03:00",
 *   data: { direction: "IN", cardKey: "18CB7ECE00000000", ... },
 *   additionalData: {
 *     accessObject: { type: "EMPLOYEE", data: { name: "Фамилия Имя Отчество", ... } },
 *     accessPoint: { name: "Примавера Штаб" },
 *   }
 * }
 */

export interface IMappedSigurEvent {
  physicalPerson: string | null;
  cardNumber: string | null;
  eventDate: string;     // YYYY-MM-DD
  eventTime: string;     // HH:MM:SS
  accessPoint: string | null;
  direction: 'entry' | 'exit' | null;
  employeeId: number | null;
  blocked: boolean | null;
  department: string | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

export const mapSigurEvent = (raw: Record<string, unknown>): IMappedSigurEvent | null => {
  // Только события прохода
  if (raw.eventType !== 'PASS_DETECTED') return null;

  const data = raw.data as Record<string, any> | undefined;
  const additional = raw.additionalData as Record<string, any> | undefined;

  // Данные сотрудника
  const personData = additional?.accessObject?.data;
  const personName = personData?.name;
  const hasName = typeof personName === 'string' && personName.trim().length > 0;

  // Дата и время из timestamp
  const ts = raw.timestamp as string | undefined;
  if (!ts) return null;

  const { date, time } = parseTimestamp(ts);
  if (!date || !time) return null;

  // Направление
  const dir = data?.direction;
  const direction: 'entry' | 'exit' | null =
    dir === 'IN' ? 'entry' :
    dir === 'OUT' ? 'exit' :
    null;

  // Номер карты
  const cardKey = data?.cardKey;
  const cardNumber = typeof cardKey === 'string' && cardKey.trim() ? cardKey.trim() : null;

  // Без имени и без карты — бесполезное событие
  if (!hasName && !cardNumber) return null;

  // Точка доступа
  const apName = additional?.accessPoint?.name;
  const accessPoint = typeof apName === 'string' && apName.trim() ? apName.trim() : null;

  // ID сотрудника в Sigur (для обогащения данными)
  const employeeId = data?.employeeId ?? personData?.id ?? null;

  return {
    physicalPerson: hasName ? personName!.trim() : null,
    cardNumber,
    eventDate: date,
    eventTime: time,
    accessPoint,
    direction,
    employeeId: typeof employeeId === 'number'
      ? employeeId
      : (typeof employeeId === 'string' && /^\d+$/.test(employeeId)
        ? parseInt(employeeId, 10)
        : null),
    blocked: null, // обогащается из кэша сотрудников (поле isBlocked)
    department: null,
  };
};

/**
 * Парсит ISO-timestamp в момент времени и возвращает компоненты в МСК
 * (UTC+3) → { date: "YYYY-MM-DD", time: "HH:MM:SS" }.
 *
 * Раньше regex выдёргивал HH:MM:SS из строки, игнорируя TZ-offset. После того
 * как сервер Sigur стал отдавать timestamp с offset, отличным от +03:00 (например
 * +02:00 из-за слетевшего TZ), event_at в БД уезжал на 1 час в прошлое — отсюда
 * был лаг ~30+ минут на дашборде. Теперь нормализуем к МСК через эпоху.
 */
const parseTimestamp = (ts: string): { date: string | null; time: string | null } => {
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return { date: null, time: null };

    const m = new Date(d.getTime() + 3 * 3600 * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return {
      date: `${m.getUTCFullYear()}-${pad(m.getUTCMonth() + 1)}-${pad(m.getUTCDate())}`,
      time: `${pad(m.getUTCHours())}:${pad(m.getUTCMinutes())}:${pad(m.getUTCSeconds())}`,
    };
  } catch {
    return { date: null, time: null };
  }
};
