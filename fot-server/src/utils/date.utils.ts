/**
 * Проверяет валидность даты
 */
export function isValidDate(date: Date): boolean {
  return date instanceof Date && !isNaN(date.getTime());
}

/**
 * Форматирует дату в ISO формат (YYYY-MM-DD)
 */
export function formatDateToISO(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Парсит дату из различных форматов
 */
export function parseDate(value: string | number | Date | null | undefined): string | null {
  if (!value) return null;

  // Если это уже Date объект
  if (value instanceof Date) {
    return formatDateToISO(value);
  }

  const str = String(value).trim();
  if (!str) return null;

  // Пробуем различные форматы

  // Excel serial date (число)
  if (!isNaN(Number(str))) {
    const num = Number(str);
    // Excel даты: дни с 1900-01-01 (с поправкой на баг 1900 года)
    if (num > 1 && num < 100000) {
      const excelEpoch = new Date(1899, 11, 30);
      const date = new Date(excelEpoch.getTime() + num * 24 * 60 * 60 * 1000);
      return formatDateToISO(date);
    }
  }

  // DD.MM.YYYY или DD/MM/YYYY
  const dmyMatch = str.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})$/);
  if (dmyMatch) {
    const [, day, month, year] = dmyMatch;
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    if (isValidDate(date)) {
      return formatDateToISO(date);
    }
  }

  // YYYY-MM-DD
  const isoMatch = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    if (isValidDate(date)) {
      return formatDateToISO(date);
    }
  }

  // Пробуем стандартный Date.parse
  const parsed = new Date(str);
  if (isValidDate(parsed)) {
    return formatDateToISO(parsed);
  }

  return null;
}

/**
 * Парсит календарную дату YYYY-MM-DD без перехода в UTC.
 * Возвращает local Date на полуночи, либо null для невалидного ввода.
 */
export function parseIsoDateOnly(value: string): Date | null {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const [, yearRaw, monthRaw, dayRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const date = new Date(year, month - 1, day);

  if (
    !isValidDate(date) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }

  return date;
}

/**
 * Строит включительный диапазон календарных дат YYYY-MM-DD.
 * Не использует UTC-преобразования, чтобы избежать сдвигов на границах месяца/года.
 */
export function buildInclusiveDateRange(startDate: string, endDate: string): string[] {
  const start = parseIsoDateOnly(startDate);
  const end = parseIsoDateOnly(endDate);

  if (!start || !end) {
    throw new Error('Некорректный формат даты. Ожидается YYYY-MM-DD');
  }

  if (start > end) {
    throw new Error('startDate не может быть позже endDate');
  }

  const days: string[] = [];
  const cursor = new Date(start);

  while (cursor <= end) {
    days.push(formatDateToISO(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  return days;
}

/**
 * Текущая календарная дата в зоне Europe/Moscow в виде YYYY-MM-DD.
 *
 * `new Date().toISOString().slice(0, 10)` даёт UTC-дату — в окне 00:00–03:00 МСК
 * это вчерашнее число, из-за чего фильтры «активно сегодня» в listEmployeeAssignments
 * и в employees.controller (schedule-фильтр) показывают вчерашнюю срезку и не видят
 * только что вставленную запись с effective_from=today (МСК).
 */
export function moscowTodayIso(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(now);
}

/** Порог применения увольнения, назначенного на сегодняшнюю дату (Europe/Moscow). */
export const DISMISSAL_CUTOFF_HM = '23:00';

export interface IMoscowDismissalTiming {
  /** Календарная дата МСК, YYYY-MM-DD. */
  today: string;
  /** Время МСК, HH:mm (24-часовое). */
  timeHm: string;
  /** true, если порог 23:00 МСК уже пройден — увольнение «на сегодня» применяется сразу. */
  cutoffPassed: boolean;
  /** Граница для планировщика: применяем увольнения с dismissal_date <= dueCutoff. */
  dueCutoff: string;
}

/**
 * Дата и время Europe/Moscow из ОДНОГО момента времени + порог 23:00.
 *
 * Один formatToParts вместо отдельных вызовов moscowTodayIso()/времени: иначе между
 * вызовами может наступить полночь и дата с временем разъедутся. dateStyle с
 * hour/minute сочетать нельзя (Node кидает TypeError) — только component-options.
 */
export function getMoscowDismissalTiming(now: Date = new Date()): IMoscowDismissalTiming {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find(p => p.type === type)?.value ?? '';

  const today = `${get('year')}-${get('month')}-${get('day')}`;
  const timeHm = `${get('hour')}:${get('minute')}`;
  const cutoffPassed = timeHm >= DISMISSAL_CUTOFF_HM;

  return {
    today,
    timeHm,
    cutoffPassed,
    dueCutoff: cutoffPassed ? today : addDaysToIso(today, -1),
  };
}

/** Сдвиг ISO-даты на N дней (UTC-арифметика, без влияния локальной TZ). */
function addDaysToIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Собирает timestamptz-строку для события SKUD в часовом поясе Europe/Moscow.
 * Используется как канонический источник для skud_events.event_at.
 */
export function buildMoscowEventTimestamp(eventDate: string, eventTime: string): string {
  const normalizedTime = (() => {
    const parts = eventTime.trim().split(':');
    if (parts.length === 2) return `${parts[0]}:${parts[1]}:00`;
    return eventTime.trim();
  })();

  return `${eventDate}T${normalizedTime}+03:00`;
}
