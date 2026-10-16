import type { ILeaveRequest } from '../services/leaveRequestService';
import type { HrCorrectionItem } from '../services/correctionLeaveService';
import { leaveRequestOverlapsPeriod } from './leaveRequestDates';

/**
 * Элемент вкладок отдела кадров: обычное заявление или отпуск, поставленный корректировкой
 * табеля (карточка, снятые дни, отказ). Ключ — составной (lr:/tc:/rm:/rj:): id заявлений и
 * корректировок пересекаются, поэтому всё состояние страницы держится по ключу.
 */
export type HrAckItem = { kind: 'request'; key: string; request: ILeaveRequest } | HrCorrectionItem;

export const NO_DEPARTMENT_KEY = 'Без отдела';

export const requestItem = (request: ILeaveRequest): HrAckItem => ({ kind: 'request', key: `lr:${request.id}`, request });

export const itemDeptKey = (item: HrAckItem): string =>
  ((item.kind === 'request' ? item.request.department_name : item.department_name) ?? '').trim() || NO_DEPARTMENT_KEY;

export const itemEmployeeName = (item: HrAckItem): string =>
  (item.kind === 'request' ? item.request.employee_name : item.employee_name) ?? '';

export const itemEmployeeId = (item: HrAckItem): number =>
  (item.kind === 'request' ? item.request.employee_id : item.employee_id);

export const itemIsAcked = (item: HrAckItem): boolean =>
  !!(item.kind === 'request' ? item.request.hr_acknowledged_at : item.hr_acknowledged_at);

/** Порядок списка: заявления — по подаче (как раньше), корректировки — по последней правке. */
const itemSortTime = (item: HrAckItem): number =>
  Date.parse(item.kind === 'request' ? item.request.created_at : item.last_changed_at) || 0;

export const itemOverlapsPeriod = (item: HrAckItem, from: string, to: string): boolean => {
  if (item.kind === 'request') return leaveRequestOverlapsPeriod(item.request, from, to);
  return item.days.some(day => (!from || day >= from) && (!to || day <= to));
};

export const mergeHrAckItems = (requests: readonly ILeaveRequest[], corrections: readonly HrCorrectionItem[]): HrAckItem[] =>
  [...requests.map(requestItem), ...corrections].sort((a, b) => itemSortTime(b) - itemSortTime(a));

const fmtFull = (iso: string): string => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

const nextIso = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** Дни карточки: подряд идущие — диапазоном «15.10.2026 — 28.10.2026», разрывы — через запятую. */
export const formatDaysCompact = (days: readonly string[]): string => {
  const runs: Array<[string, string]> = [];
  for (const day of [...new Set(days)].sort()) {
    const last = runs[runs.length - 1];
    if (last && nextIso(last[1]) === day) last[1] = day;
    else runs.push([day, day]);
  }
  return runs.map(([from, to]) => (from === to ? fmtFull(from) : `${fmtFull(from)} — ${fmtFull(to)}`)).join(', ');
};
