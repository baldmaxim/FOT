const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_NAMES_SHORT = [
  'янв', 'фев', 'мар', 'апр', 'май', 'июн',
  'июл', 'авг', 'сен', 'окт', 'ноя', 'дек',
];
const MONTH_NAMES_LONG = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

export interface ITimesheetDateRange {
  startDate: string;
  endDate: string;
}

export const isIsoDate = (value: unknown): value is string =>
  typeof value === 'string' && ISO_DATE_REGEX.test(value) && !Number.isNaN(new Date(value).getTime());

export const getMonthBounds = (month: string): { firstDate: string; lastDate: string } | null => {
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  const [y, m] = month.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return {
    firstDate: `${month}-01`,
    lastDate: `${month}-${String(lastDay).padStart(2, '0')}`,
  };
};

export const clampRangeToMonth = (
  range: ITimesheetDateRange,
  month: string,
): ITimesheetDateRange | null => {
  const bounds = getMonthBounds(month);
  if (!bounds) return null;
  const { firstDate, lastDate } = bounds;
  const startDate = range.startDate < firstDate ? firstDate : (range.startDate > lastDate ? lastDate : range.startDate);
  let endDate = range.endDate < firstDate ? firstDate : (range.endDate > lastDate ? lastDate : range.endDate);
  if (endDate < startDate) endDate = startDate;
  return { startDate, endDate };
};

export const getDefaultRangeForMonth = (month: string): ITimesheetDateRange | null => {
  const bounds = getMonthBounds(month);
  if (!bounds) return null;
  return { startDate: bounds.firstDate, endDate: bounds.lastDate };
};

export const formatTimesheetRangeLabel = (startDate: string, endDate: string): string => {
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);
  const startLabel = `${sd} ${MONTH_NAMES_SHORT[sm - 1] || sm}`;
  const endLabel = `${ed} ${MONTH_NAMES_SHORT[em - 1] || em}`;
  if (sy !== ey) return `${startLabel} ${sy} — ${endLabel} ${ey}`;
  if (sm !== em) return `${startLabel} — ${endLabel} ${ey}`;
  if (sd === ed) return `${startLabel} ${ey}`;
  return `${sd}–${ed} ${MONTH_NAMES_SHORT[sm - 1] || sm} ${ey}`;
};

export const formatMonthLabel = (month: string): string => {
  if (!/^\d{4}-\d{2}$/.test(month)) return month;
  const [y, m] = month.split('-').map(Number);
  return `${MONTH_NAMES_LONG[m - 1] || m} ${y}`;
};

export const listDatesInRange = (startDate: string, endDate: string): string[] => {
  if (!isIsoDate(startDate) || !isIsoDate(endDate) || endDate < startDate) return [];
  const dates: string[] = [];
  const cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
};

export const rangesOverlap = (a: ITimesheetDateRange, b: ITimesheetDateRange): boolean =>
  a.startDate <= b.endDate && b.startDate <= a.endDate;
