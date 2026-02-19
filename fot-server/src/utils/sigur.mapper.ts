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
  physicalPerson: string;
  cardNumber: string | null;
  eventDate: string;     // YYYY-MM-DD
  eventTime: string;     // HH:MM:SS
  accessPoint: string | null;
  direction: 'entry' | 'exit' | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

export const mapSigurEvent = (raw: Record<string, unknown>): IMappedSigurEvent | null => {
  // Только события прохода
  if (raw.eventType !== 'PASS_DETECTED') return null;

  const data = raw.data as Record<string, any> | undefined;
  const additional = raw.additionalData as Record<string, any> | undefined;

  // ФИО сотрудника
  const personName = additional?.accessObject?.data?.name;
  if (typeof personName !== 'string' || !personName.trim()) return null;

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

  // Точка доступа
  const apName = additional?.accessPoint?.name;
  const accessPoint = typeof apName === 'string' && apName.trim() ? apName.trim() : null;

  return {
    physicalPerson: personName.trim(),
    cardNumber,
    eventDate: date,
    eventTime: time,
    accessPoint,
    direction,
  };
};

/**
 * Парсит ISO-timestamp с таймзоной → { date: "YYYY-MM-DD", time: "HH:MM:SS" }
 */
const parseTimestamp = (ts: string): { date: string | null; time: string | null } => {
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return { date: null, time: null };

    // Извлекаем локальное время из ISO-строки (до +/Z)
    // "2026-02-02T10:23:23+03:00" → date="2026-02-02", time="10:23:23"
    const match = ts.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/);
    if (match) {
      return { date: match[1], time: match[2] };
    }

    // Fallback: используем Date
    const pad = (n: number) => String(n).padStart(2, '0');
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    return { date, time };
  } catch {
    return { date: null, time: null };
  }
};
