/**
 * Маппер событий Sigur REST API → формат skud_events / skud_event_failures.
 *
 * Реальный формат Sigur /api/v1/events/parsed:
 * {
 *   eventType: "PASS_DETECTED" | "PASS_DENY" | ...,
 *   eventTypeId: 6 | 12 | ...,
 *   timestamp: "2026-02-02T10:23:23+03:00",
 *   data: { direction: "IN", cardKey: "18CB7ECE00000000", ... },
 *   additionalData: {
 *     accessObject: { type: "EMPLOYEE", data: { name: "Фамилия Имя Отчество", ... } },
 *     accessPoint: { name: "Примавера Штаб" },
 *   }
 * }
 *
 * Маппер возвращает тегированный union: успешный проход (`kind: 'pass'`) идёт в
 * skud_events и участвует в расчётах табеля; всё остальное (`kind: 'failure'`)
 * пишется в skud_event_failures и из расчётов исключено.
 */

export interface IMappedSigurPassEvent {
  kind: 'pass';
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

export interface IMappedSigurFailureEvent {
  kind: 'failure';
  failureType: string;          // строкой из raw.eventType ('PASS_DENY' и т.п.)
  failureTypeId: number | null; // из raw.eventTypeId, если присутствует
  physicalPerson: string | null;
  cardNumber: string | null;
  eventDate: string;
  eventTime: string;
  accessPoint: string | null;
  direction: 'entry' | 'exit' | null;
  employeeId: number | null;
  reason: string | null;        // raw.description / raw.data?.reason / raw.data?.failureReason
  rawId: number | null;
}

export type IMappedSigurEvent = IMappedSigurPassEvent | IMappedSigurFailureEvent;

/* eslint-disable @typescript-eslint/no-explicit-any */

// Расшифровка denyReasonCode из Sigur (см. docs/sigur-rest-api.md, раздел 15).
// Sigur при PASS_DENY обычно отдаёт только числовой код в data.denyReasonCode;
// строковое описание data.denyReason приходит не всегда.
const DENY_REASON_BY_CODE: Record<number, string> = {
  0: 'Неверный PIN',
  1: 'Ключ просрочен',
  3: 'Неизвестный ключ',
  4: 'По временным зонам',
  5: 'Нет доступа к этой двери',
  6: 'Нет доступа в это время',
  7: 'Антипассбэк',
  11: 'Дверь заблокирована',
  14: 'Лимит вместимости зоны',
  16: 'Превышение алкоголя',
  28: 'Лицо не идентифицировано',
  35: 'Проверка температуры не пройдена',
  37: 'Маска отсутствует',
};

const pickString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const parseDirection = (dir: unknown): 'entry' | 'exit' | null => {
  if (dir === 'IN' || dir === 'entry') return 'entry';
  if (dir === 'OUT' || dir === 'exit') return 'exit';
  return null;
};

const extractEmployeeId = (raw: unknown): number | null => {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return parseInt(raw, 10);
  return null;
};

export const mapSigurEvent = (raw: Record<string, unknown>): IMappedSigurEvent | null => {
  // Дата и время из timestamp — обязательны для любого типа события
  const ts = raw.timestamp as string | undefined;
  if (!ts) return null;
  const { date, time } = parseTimestamp(ts);
  if (!date || !time) return null;

  const data = raw.data as Record<string, any> | undefined;
  const additional = raw.additionalData as Record<string, any> | undefined;

  // Имя сотрудника (если есть)
  const personData = additional?.accessObject?.data;
  const personName = personData?.name;
  const hasName = typeof personName === 'string' && personName.trim().length > 0;

  // Номер карты (если есть)
  const cardKey = data?.cardKey;
  const cardNumber = typeof cardKey === 'string' && cardKey.trim() ? cardKey.trim() : null;

  // Точка доступа
  const apName = additional?.accessPoint?.name;
  const accessPoint = typeof apName === 'string' && apName.trim() ? apName.trim() : null;

  // Направление
  const direction = parseDirection(data?.direction);

  // employeeId в Sigur: data.employeeId или accessObject.data.id
  const employeeId =
    extractEmployeeId(data?.employeeId) ?? extractEmployeeId(personData?.id);

  const eventType = typeof raw.eventType === 'string' ? raw.eventType : null;
  const rawId = typeof raw.id === 'number' && Number.isFinite(raw.id) ? raw.id : null;

  if (eventType === 'PASS_DETECTED') {
    // Без имени и без карты PASS_DETECTED считаем мусором (как и раньше)
    if (!hasName && !cardNumber) return null;
    return {
      kind: 'pass',
      physicalPerson: hasName ? personName!.trim() : null,
      cardNumber,
      eventDate: date,
      eventTime: time,
      accessPoint,
      direction,
      employeeId,
      blocked: null,
      department: null,
    };
  }

  // Всё остальное — failure-событие. Имя/карта могут отсутствовать (часто так
  // и происходит при PASS_DENY на чужой карте или таймауте).
  const failureType = eventType || 'UNKNOWN';
  const failureTypeId = typeof raw.eventTypeId === 'number' ? raw.eventTypeId : null;

  // Приоритет источников причины:
  //   1. data.denyReason — строковое описание от Sigur (если он его прислал)
  //   2. DENY_REASON_BY_CODE[data.denyReasonCode] — расшифровка числового кода
  //   3. data.passReason — для информативных не-failure типов (BIO, температура и т.п.)
  //   4. raw.description / data.reason / data.failureReason — старые fallback-поля
  const denyReasonCode = typeof data?.denyReasonCode === 'number' ? data.denyReasonCode : null;
  const reason =
    pickString(data?.denyReason)
    ?? (denyReasonCode != null ? DENY_REASON_BY_CODE[denyReasonCode] ?? null : null)
    ?? pickString(data?.passReason)
    ?? pickString(raw.description)
    ?? pickString(data?.reason)
    ?? pickString(data?.failureReason);

  return {
    kind: 'failure',
    failureType,
    failureTypeId,
    physicalPerson: hasName ? personName!.trim() : null,
    cardNumber,
    eventDate: date,
    eventTime: time,
    accessPoint,
    direction,
    employeeId,
    reason,
    rawId,
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
