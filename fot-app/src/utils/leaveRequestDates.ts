import type { ILeaveRequest } from '../services/leaveRequestService';
import { formatDateCompact, MONTH_GENITIVE_SHORT_RU, pluralDays } from './dateCompact';

/**
 * Заявление в архиве: обработано и все его даты в прошлом.
 * На рассмотрении (pending) — всегда «Активные», даже если даты прошли.
 */
export const isLeaveRequestArchived = (r: ILeaveRequest, today: string): boolean => {
  if (r.status === 'pending') return false;
  if (r.request_type === 'time_correction') {
    return !!r.correction_date && r.correction_date < today;
  }
  return r.end_date < today;
};

const fmtFull = (iso: string): string => {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
};

const DAY_MS = 86_400_000;

/** ISO-дата (YYYY-MM-DD) → UTC-метка времени (полночь), для сравнения «соседние ли дни». */
const isoToUtc = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};

/** Сгруппировать отсортированные даты в непрерывные отрезки подряд идущих дней. */
const groupConsecutive = (sorted: string[]): string[][] => {
  const groups: string[][] = [];
  for (const iso of sorted) {
    const last = groups[groups.length - 1];
    if (last && isoToUtc(iso) - isoToUtc(last[last.length - 1]) === DAY_MS) {
      last.push(iso);
    } else {
      groups.push([iso]);
    }
  }
  return groups;
};

/** Отрезок дат: один день — «01.05.2026», диапазон — «01.05.2026 — 16.05.2026». */
const fmtRange = (group: string[]): string =>
  group.length === 1 ? fmtFull(group[0]) : `${fmtFull(group[0])} — ${fmtFull(group[group.length - 1])}`;

/**
 * Компактное представление дат заявления для карточек:
 *  - один день: «01.05.2026»
 *  - непрерывный период: «01.05.2026 — 16.05.2026»
 *  - набор дат: подряд идущие сворачиваются в диапазон, отрезки — через запятую,
 *    напр. «29.06.2026 — 01.07.2026, 05.07.2026»
 */
export function formatLeaveRequestDatesCompact(r: ILeaveRequest): string {
  if (r.request_type === 'time_correction' && r.correction_date) return fmtFull(r.correction_date);
  const dates = r.selected_dates ?? null;
  if (dates && dates.length > 0) {
    const sorted = [...new Set(dates)].sort();
    return groupConsecutive(sorted).map(fmtRange).join(', ');
  }
  // Однодневное заявление — одна дата, а не «12.08.2026 — 12.08.2026».
  if (r.start_date === r.end_date) return fmtFull(r.start_date);
  return `${fmtFull(r.start_date)} — ${fmtFull(r.end_date)}`;
}

/** «1 авг» — короткая дата без года, для узкой колонки списка. */
const fmtShortDay = (iso: string): string => {
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTH_GENITIVE_SHORT_RU[m - 1]}`;
};

/**
 * Диапазон в одну строку для узкой колонки. Внутри одного месяца схлопываем до
 * «10–30 сен»; месяц один только тогда, когда совпали И год, И месяц — иначе
 * сентябрь разных лет слился бы в один диапазон.
 */
const fmtShortRange = (fromIso: string, toIso: string): string => {
  const [fy, fm, fd] = fromIso.split('-').map(Number);
  const [ty, tm] = toIso.split('-').map(Number);
  if (fy === ty && fm === tm) {
    const [, , td] = toIso.split('-').map(Number);
    return `${fd}–${td} ${MONTH_GENITIVE_SHORT_RU[fm - 1]}`;
  }
  return `${fmtShortDay(fromIso)} — ${fmtShortDay(toIso)}`;
};

/**
 * Ячейка даты в строке списка заявлений: `day` — первая строка, `sub` — мелкая
 * подпись под ней (день недели либо длительность), чтобы ничего не вылезало
 * из узкой колонки:
 *  - корректировка / однодневное заявление → «9 авг» + «вс»;
 *  - период внутри месяца → «10–30 сен» + «21 день»;
 *  - период через месяцы → «20 авг — 2 сен» + «14 дней»;
 *  - несмежные отрезки → первый отрезок + «+N дн» (полный список — в раскрытии,
 *    через formatLeaveRequestDatesCompact).
 * `sub` пустой, если добавить нечего.
 */
export function formatLeaveRequestDateCell(r: ILeaveRequest): { day: string; sub: string } {
  // Легаси-корректировки без correction_date опираются на start_date.
  if (r.request_type === 'time_correction') {
    const iso = r.correction_date || r.start_date;
    const { day, weekday } = formatDateCompact(iso);
    return { day, sub: weekday };
  }

  const dates = r.selected_dates && r.selected_dates.length > 0
    ? [...new Set(r.selected_dates)].sort()
    : null;

  if (dates) {
    if (dates.length === 1) {
      const { day, weekday } = formatDateCompact(dates[0]);
      return { day, sub: weekday };
    }
    const groups = groupConsecutive(dates);
    const first = groups[0];
    const day = first.length === 1
      ? fmtShortDay(first[0])
      : fmtShortRange(first[0], first[first.length - 1]);
    // Считаем именно выбранные дни, а не длину календарного диапазона.
    const rest = dates.length - first.length;
    return {
      day,
      sub: groups.length > 1 ? `+${rest} дн` : `${dates.length} ${pluralDays(dates.length)}`,
    };
  }

  if (r.start_date === r.end_date) {
    const { day, weekday } = formatDateCompact(r.start_date);
    return { day, sub: weekday };
  }
  const span = Math.round((isoToUtc(r.end_date) - isoToUtc(r.start_date)) / DAY_MS) + 1;
  return {
    day: fmtShortRange(r.start_date, r.end_date),
    sub: Number.isFinite(span) && span > 0 ? `${span} ${pluralDays(span)}` : '',
  };
}

/** Полный, развёрнутый список дат — для деталей. Возвращает массив форматированных строк. */
export function formatLeaveRequestDatesFull(r: ILeaveRequest): string[] {
  const dates = r.selected_dates ?? null;
  if (dates && dates.length > 0) return dates.map(fmtFull);
  return [fmtFull(r.start_date), fmtFull(r.end_date)];
}

export function hasDiscreteDates(r: ILeaveRequest): boolean {
  return !!(r.selected_dates && r.selected_dates.length > 0);
}

/** Минимальная (самая ранняя) дата заявления, ISO. `selected_dates` приоритетнее диапазона. */
export function leaveRequestMinDate(r: ILeaveRequest): string {
  if (r.selected_dates && r.selected_dates.length > 0) {
    return [...r.selected_dates].sort()[0];
  }
  return r.start_date;
}

/**
 * Даты заявления пересекаются с периодом [from, to] (ISO, включительно).
 * Пустая граница = «без ограничения» с этой стороны. Синтетических
 * «бесконечностей» не используем: в данных есть легаси-годы вроде +062026.
 * Источник дат — те же правила, что в formatLeaveRequestDatesCompact.
 */
export function leaveRequestOverlapsPeriod(r: ILeaveRequest, from: string, to: string): boolean {
  const isWithin = (date: string): boolean => (!from || date >= from) && (!to || date <= to);

  if (r.request_type === 'time_correction' && r.correction_date) {
    return isWithin(r.correction_date);
  }
  const dates = r.selected_dates ?? null;
  if (dates && dates.length > 0) {
    return dates.some(isWithin);
  }
  return (!to || r.start_date <= to) && (!from || r.end_date >= from);
}

/** Все даты заявления строго в будущем относительно `today` (ISO YYYY-MM-DD). */
export function isLeaveRequestFullyFuture(r: ILeaveRequest, today: string): boolean {
  return leaveRequestMinDate(r) > today;
}
