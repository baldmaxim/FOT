import {
  CORRECTION_STATUS_LABELS,
  REQUEST_TYPE_LABELS,
  getRequestDecision,
  type ILeaveRequest,
} from '../services/leaveRequestService';
import { normalizeFioSearch } from './fioSearch';

const DAY_MS = 86_400_000;
// Защита от легаси-диапазонов (годы вроде +062026): больше года подряд не разворачиваем.
const MAX_RANGE_DAYS = 366;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isoToUtc = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};

const isoToDisplay = (iso: string): string => {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
};

/** Все дни диапазона [from, to] включительно, ISO. Концы — всегда, даже если диапазон обрезан. */
const rangeDays = (from: string, to: string): string[] => {
  if (!ISO_DATE_RE.test(from) || !ISO_DATE_RE.test(to) || from > to) {
    return [from, to].filter(d => ISO_DATE_RE.test(d));
  }
  const days: string[] = [];
  const end = isoToUtc(to);
  for (let t = isoToUtc(from); t <= end && days.length < MAX_RANGE_DAYS; t += DAY_MS) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  if (days[days.length - 1] !== to) days.push(to);
  return days;
};

/** Дни заявления — по тем же правилам, что formatLeaveRequestDatesCompact / leaveRequestOverlapsPeriod. */
const requestDays = (r: ILeaveRequest): string[] => {
  if (r.request_type === 'time_correction' && r.correction_date) return [r.correction_date];
  if (r.selected_dates && r.selected_dates.length > 0) return r.selected_dates;
  return rangeDays(r.start_date, r.end_date);
};

/**
 * Текст заявления для поиска: тип, статус (как на карточке), комментарий решения,
 * статус корректировки, причина и КАЖДЫЙ день заявления «дд.мм.гггг» — чтобы «14.06»
 * находило и отпуск 10.06–20.06, а «07.2026» — отпуск 27.06–05.07.
 */
const leaveRequestSearchText = (r: ILeaveRequest): string => {
  const decision = getRequestDecision(r);
  const parts = [
    REQUEST_TYPE_LABELS[r.request_type],
    decision.label,
    decision.comment,
    r.correction_status,
    r.correction_status ? CORRECTION_STATUS_LABELS[r.correction_status] : null,
    r.reason,
    ...requestDays(r).filter(d => ISO_DATE_RE.test(d)).map(isoToDisplay),
  ];
  // normalizeFioSearch сводит пробелы в один — слово запроса (без пробелов) не склеит соседние поля.
  return normalizeFioSearch(parts.filter(Boolean).join(' '));
};

/** Заявление подходит, если в нём найдено каждое слово запроса (регистр и ё/е не важны). */
export const matchesLeaveRequestSearch = (r: ILeaveRequest, search: string): boolean => {
  const terms = normalizeFioSearch(search).split(' ').filter(Boolean);
  if (terms.length === 0) return true;
  const text = leaveRequestSearchText(r);
  return terms.every(term => text.includes(term));
};
