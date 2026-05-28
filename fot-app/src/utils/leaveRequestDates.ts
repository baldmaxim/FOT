import type { ILeaveRequest } from '../services/leaveRequestService';

const fmtFull = (iso: string): string => {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
};

const fmtShort = (iso: string): string => {
  const [, m, d] = iso.split('-');
  return `${d}.${m}`;
};

/**
 * Компактное представление дат заявления для карточек:
 *  - один день: «01.05.2026»
 *  - 2–4 дискретных дня: «01.05, 02.05, 11.05.2026»
 *  - 5+ дискретных дней: «01.05, 02.05, 11.05 +N (2026)»
 *  - непрерывный период: «01.05.2026 — 16.05.2026»
 */
export function formatLeaveRequestDatesCompact(r: ILeaveRequest): string {
  if (r.request_type === 'time_correction' && r.correction_date) return fmtFull(r.correction_date);
  const dates = r.selected_dates ?? null;
  if (dates && dates.length > 0) {
    if (dates.length === 1) return fmtFull(dates[0]);
    if (dates.length <= 4) {
      return `${dates.slice(0, -1).map(fmtShort).join(', ')}, ${fmtFull(dates[dates.length - 1])}`;
    }
    const year = dates[dates.length - 1].slice(0, 4);
    return `${dates.slice(0, 3).map(fmtShort).join(', ')} +${dates.length - 3} (${year})`;
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
