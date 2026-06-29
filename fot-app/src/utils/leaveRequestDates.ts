import type { ILeaveRequest } from '../services/leaveRequestService';

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
  return `${fmtFull(r.start_date)} — ${fmtFull(r.end_date)}`;
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

/** Все даты заявления строго в будущем относительно `today` (ISO YYYY-MM-DD). */
export function isLeaveRequestFullyFuture(r: ILeaveRequest, today: string): boolean {
  return leaveRequestMinDate(r) > today;
}
