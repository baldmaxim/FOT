import type { ISchedulePlanDay, ISchedulePlanPeriod } from '../types/timesheet';

export const MONTH_NAMES_RU = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
] as const;

const WEEKDAY_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'] as const;

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** Часы плана: не больше 2 знаков после запятой, без хвостовых нулей. 10 → «10», 8,5 → «8,5», 159,0166… → «159,02». */
export const formatPlanHours = (hours: number): string => {
  const rounded = Math.round(hours * 100) / 100;
  return String(rounded).replace('.', ',');
};

/** Норма месяца в минутах → часы плана. */
export const formatPlanMinutes = (minutes: number): string => formatPlanHours(minutes / 60);

/** «дд.мм» из YYYY-MM-DD. */
const formatDayMonth = (iso: string): string => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;

/** Подпись графиков года: один период — только название, несколько — с датами. */
export const formatPlanPeriods = (periods: readonly ISchedulePlanPeriod[]): string => {
  if (periods.length === 0) return '—';
  if (periods.length === 1) return periods[0].schedule_name ?? '—';
  return periods
    .map(period => `${period.schedule_name ?? '—'} — ${formatDayMonth(period.from)}–${formatDayMonth(period.to)}`)
    .join(' · ');
};

/** Подсказка дня: «Пт 04.09 — 10 ч», «Ср 07.01 — праздник», «Чт 30.04 — предпраздничный, 7 ч», «Сб 05.09 — выходной». */
export const formatPlanDayTooltip = (year: number, month: number, day: ISchedulePlanDay): string => {
  const weekday = WEEKDAY_SHORT[new Date(year, month - 1, day.day).getDay()];
  const head = `${weekday} ${pad2(day.day)}.${pad2(month)}`;
  if (day.kind === 'holiday') return `${head} — праздник`;
  if (day.kind === 'off') return `${head} — выходной`;
  if (day.kind === 'pre_holiday') return `${head} — предпраздничный, ${formatPlanHours(day.hours)} ч`;
  return `${head} — ${formatPlanHours(day.hours)} ч`;
};

export const daysInPlanMonth = (year: number, month: number): number => new Date(year, month, 0).getDate();

/** В графике самый длинный месяц — 31 день. */
export const PLAN_MAX_DAY = 31;

/**
 * Дни графика под табелем — те же, что у сетки табеля (`visibleDays`: «1–15», «16–конец», «Весь месяц»), день в день.
 * Период кончается последним днём месяца табеля — график идёт до 31-го: у других месяцев года он есть. Пусто — 1–31.
 */
export const schedulePlanDayNumbers = (visibleDays: readonly number[], monthDays: number): number[] => {
  const first = visibleDays.length > 0 ? Math.max(1, visibleDays[0]) : 1;
  const last = visibleDays.length > 0 ? visibleDays[visibleDays.length - 1] : PLAN_MAX_DAY;
  const end = last >= monthDays ? PLAN_MAX_DAY : Math.min(last, PLAN_MAX_DAY);
  return Array.from({ length: Math.max(0, end - first + 1) }, (_, index) => first + index);
};

/** Квота «Сб / Вс» одним столбцом: «2 / 1»; обе нулевые — пусто. */
export const formatPlanWeekendQuota = (saturdays: number, sundays: number): string => (
  saturdays > 0 || sundays > 0 ? `${saturdays} / ${sundays}` : ''
);
