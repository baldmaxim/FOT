const WEEKDAYS_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const MONTHS_RU = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

export const getDaysInMonth = (year: number, month: number): number => {
  return new Date(year, month, 0).getDate();
};

export const generateDateRange = (from: string, to: string): string[] => {
  const result: string[] = [];
  const cursor = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  while (cursor <= end) {
    const y = cursor.getFullYear();
    const m = String(cursor.getMonth() + 1).padStart(2, '0');
    const d = String(cursor.getDate()).padStart(2, '0');
    result.push(`${y}-${m}-${d}`);
    cursor.setDate(cursor.getDate() + 1);
  }
  return result;
};

export const isWeekend = (year: number, month: number, day: number): boolean => {
  const d = new Date(year, month - 1, day).getDay();
  return d === 0 || d === 6;
};

export const getWeekdayShort = (year: number, month: number, day: number): string => {
  return WEEKDAYS_SHORT[new Date(year, month - 1, day).getDay()];
};

export const getWorkingDaysCount = (year: number, month: number): number => {
  const days = getDaysInMonth(year, month);
  let count = 0;
  for (let d = 1; d <= days; d++) {
    if (!isWeekend(year, month, d)) count++;
  }
  return count;
};

export const getMonthLabel = (year: number, month: number): string => {
  return `${MONTHS_RU[month - 1]} ${year}`;
};

export const formatDateRu = (day: number, month: number): string => {
  const monthsGenitive = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
  ];
  return `${day} ${monthsGenitive[month - 1]}`;
};

export const getWeekdayFull = (year: number, month: number, day: number): string => {
  const days = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
  return days[new Date(year, month - 1, day).getDay()];
};

export const isToday = (year: number, month: number, day: number): boolean => {
  const now = new Date();
  return now.getFullYear() === year && now.getMonth() + 1 === month && now.getDate() === day;
};

export const isFutureDay = (year: number, month: number, day: number): boolean => {
  const d = new Date(year, month - 1, day);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d > today;
};

export const toISODate = (year: number, month: number, day: number): string => {
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${year}-${m}-${d}`;
};

export const computeWorkingNorm = (
  year: number,
  month: number,
  holidays: string[],
  mandatoryHolidays: string[],
  preHolidays: string[] = [],
): { norm_days: number; norm_hours: number } => {
  const days = getDaysInMonth(year, month);
  const offDays = new Set<string>([...holidays, ...mandatoryHolidays]);
  const preSet = new Set<string>(preHolidays);
  let normDays = 0;
  let preWorkingCount = 0;
  for (let d = 1; d <= days; d++) {
    const iso = toISODate(year, month, d);
    if (isWeekend(year, month, d)) continue;
    if (offDays.has(iso)) continue;
    normDays++;
    if (preSet.has(iso)) preWorkingCount++;
  }
  return { norm_days: normDays, norm_hours: Math.max(0, normDays * 8 - preWorkingCount) };
};

export const getWorkingDaysUpToToday = (year: number, month: number): number => {
  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1;

  if (year < curYear || (year === curYear && month < curMonth)) {
    return getWorkingDaysCount(year, month);
  }
  if (year > curYear || (year === curYear && month > curMonth)) {
    return 0;
  }
  // Current month — count working days up to today
  const today = now.getDate();
  let count = 0;
  for (let d = 1; d <= today; d++) {
    if (!isWeekend(year, month, d)) count++;
  }
  return count;
};
