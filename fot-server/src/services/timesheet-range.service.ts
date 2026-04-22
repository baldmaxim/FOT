const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export interface ITimesheetDateRange {
  startDate: string;
  endDate: string;
}

const MONTH_NAMES_RU_SHORT = [
  'янв', 'фев', 'мар', 'апр', 'май', 'июн',
  'июл', 'авг', 'сен', 'окт', 'ноя', 'дек',
];

export function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && ISO_DATE_REGEX.test(value) && !Number.isNaN(new Date(value).getTime());
}

export function parseTimesheetRange(value: unknown): ITimesheetDateRange | null {
  if (!value || typeof value !== 'object') return null;

  const { start_date, end_date } = value as Record<string, unknown>;
  if (!isIsoDate(start_date) || !isIsoDate(end_date)) return null;
  if (end_date < start_date) return null;

  return { startDate: start_date, endDate: end_date };
}

export function formatTimesheetRangeLabel(startDate: string, endDate: string): string {
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);
  const startLabel = `${sd} ${MONTH_NAMES_RU_SHORT[sm - 1] || String(sm)}`;
  const endLabel = `${ed} ${MONTH_NAMES_RU_SHORT[em - 1] || String(em)}`;

  if (sy !== ey) return `${startLabel} ${sy} — ${endLabel} ${ey}`;
  if (sm !== em) return `${startLabel} — ${endLabel} ${ey}`;
  if (sd === ed) return `${startLabel} ${ey}`;
  return `${sd}–${ed} ${MONTH_NAMES_RU_SHORT[sm - 1] || String(sm)} ${ey}`;
}

export function isDateWithinRange(workDate: string, startDate: string, endDate: string): boolean {
  return workDate >= startDate && workDate <= endDate;
}

export function rangesOverlap(a: ITimesheetDateRange, b: ITimesheetDateRange): boolean {
  return a.startDate <= b.endDate && b.startDate <= a.endDate;
}

export function addDays(isoDate: string, delta: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

export function clampRangeToMonth(range: ITimesheetDateRange, year: number, month: number): ITimesheetDateRange {
  const first = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const last = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return {
    startDate: range.startDate < first ? first : range.startDate > last ? last : range.startDate,
    endDate: range.endDate > last ? last : range.endDate < first ? first : range.endDate,
  };
}
