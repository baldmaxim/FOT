import type { IResolvedSchedule, ICycleDay } from '../types/schedule';
import type { IProductionCalendarMonth } from '../types/timesheet';

const getISODow = (date: Date): number => {
  const d = date.getDay();
  return d === 0 ? 7 : d;
};

const toISODate = (year: number, month: number, day: number): string => {
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${year}-${m}-${d}`;
};

/**
 * Слот циклического графика для конкретной даты. Зеркалит бэкендовый getCycleSlot
 * (schedule.service.ts): сдвиг считается в календарных днях между anchor и датой
 * (UTC-полночь обоих). Возвращает null, если график не циклический или у него нет
 * валидных cycle_*-полей. anchor_date/assignment_anchor_date приходят строкой
 * 'YYYY-MM-DD' (pg DATE type-parser), поэтому off-by-one с бэком исключён.
 */
const getCycleSlotForDay = (
  sched: IResolvedSchedule,
  year: number,
  month: number,
  day: number,
): ICycleDay | null => {
  if (sched.pattern_type !== 'cycle') return null;
  const cycleLength = sched.cycle_length;
  const cycleDays = sched.cycle_days;
  const anchorRaw = sched.assignment_anchor_date ?? sched.anchor_date;
  if (!cycleLength || !cycleDays || cycleDays.length !== cycleLength || !anchorRaw) {
    return null;
  }
  const [ay, am, ad] = anchorRaw.slice(0, 10).split('-').map(Number);
  if (!ay || !am || !ad) return null;
  const anchorUtc = Date.UTC(ay, am - 1, ad);
  const targetUtc = Date.UTC(year, month - 1, day);
  const dayDiff = Math.round((targetUtc - anchorUtc) / 86_400_000);
  const idx = ((dayDiff % cycleLength) + cycleLength) % cycleLength;
  return cycleDays[idx] ?? null;
};

export const getScheduleForTimesheetDay = (
  schedules: Record<number, IResolvedSchedule> | undefined,
  dailySchedules: Record<number, Record<string, IResolvedSchedule>> | undefined,
  employeeId: number,
  year: number,
  month: number,
  day: number,
): IResolvedSchedule | undefined => {
  const date = toISODate(year, month, day);
  return dailySchedules?.[employeeId]?.[date] || schedules?.[employeeId];
};

/** Возвращает норму часов для конкретного дня с учётом day_overrides */
export const getWorkHoursForDay = (
  sched: IResolvedSchedule | undefined,
  year: number,
  month: number,
  day: number,
): number => {
  if (!sched) return 8;
  const slot = getCycleSlotForDay(sched, year, month, day);
  if (slot) return slot.work_hours;
  if (sched.day_overrides) {
    const dow = String(getISODow(new Date(year, month - 1, day)));
    const override = sched.day_overrides[dow];
    if (override) return override.work_hours;
  }
  return sched.work_hours;
};

/** Длительность смены (start–end, без вычета обеда). Учитывает day_overrides и ночные смены. */
export const getShiftDurationForDay = (
  sched: IResolvedSchedule | undefined,
  year: number,
  month: number,
  day: number,
): number => {
  if (!sched) return 9;
  let workStart = sched.work_start;
  let workEnd = sched.work_end;
  const slot = getCycleSlotForDay(sched, year, month, day);
  if (slot) {
    workStart = slot.work_start ?? sched.work_start;
    workEnd = slot.work_end ?? sched.work_end;
  } else if (sched.day_overrides) {
    const dow = String(getISODow(new Date(year, month - 1, day)));
    const override = sched.day_overrides[dow];
    if (override) {
      workStart = override.work_start;
      workEnd = override.work_end;
    }
  }
  const parse = (value: string): number => {
    const [h = 0, m = 0] = value.split(':').map(Number);
    return h * 60 + m;
  };
  const startMin = parse(workStart);
  let endMin = parse(workEnd);
  if (endMin <= startMin) endMin += 24 * 60;
  return Math.max(0, (endMin - startMin) / 60);
};

export const isHolidayForSchedule = (
  sched: IResolvedSchedule | undefined,
  calendar: IProductionCalendarMonth | null,
  year: number,
  month: number,
  day: number,
): boolean => {
  if (!calendar) return false;
  const iso = toISODate(year, month, day);
  if (calendar.mandatory_holidays?.includes(iso)) return true;
  const respects = sched ? sched.respects_holidays !== false : true;
  if (respects && calendar.holidays?.includes(iso)) return true;
  return false;
};

/** Предпраздничный рабочий день для графика (рабочий, но -1ч). false для нерабочих и для графиков с respects_holidays=false. */
export const isPreHolidayForSchedule = (
  sched: IResolvedSchedule | undefined,
  calendar: IProductionCalendarMonth | null,
  year: number,
  month: number,
  day: number,
): boolean => {
  if (!calendar?.pre_holidays?.length) return false;
  const respects = sched ? sched.respects_holidays !== false : true;
  if (!respects) return false;
  if (isScheduleDayOff(sched, calendar, year, month, day)) return false;
  return calendar.pre_holidays.includes(toISODate(year, month, day));
};

export const isScheduleDayOff = (
  sched: IResolvedSchedule | undefined,
  calendar: IProductionCalendarMonth | null,
  year: number,
  month: number,
  day: number,
): boolean => {
  if (isHolidayForSchedule(sched, calendar, year, month, day)) return true;
  if (!sched) {
    const dow = new Date(year, month - 1, day).getDay();
    return dow === 0 || dow === 6;
  }
  // Цикл-графики: рабочий/выходной определяет слот цикла, а не work_days
  // (редактор для cycle всегда пишет work_days=[1..5], что неверно для 2/2 и т.п.).
  const slot = getCycleSlotForDay(sched, year, month, day);
  if (slot) return slot.work_hours <= 0;
  return !sched.work_days.includes(getISODow(new Date(year, month - 1, day)));
};

/**
 * Порог "полного дня" в часах для визуализации ячейки табеля.
 * work_hours хранится как нетто (без обеда), отдельный вычет lunch_minutes не нужен.
 * - isWeekendDay=false (будний рабочий день графика): берём full_day_threshold_minutes,
 *   fallback = work_hours.
 * - isWeekendDay=true (сотрудник вышел в выходной): берём weekend_full_day_threshold_minutes,
 *   fallback = full_day_threshold_minutes, далее → work_hours.
 */
export const getFullDayThresholdHours = (
  sched: IResolvedSchedule | undefined,
  isWeekendDay: boolean,
): number => {
  if (!sched) return 8;
  // work_hours напрямую: промежуточный round через минуты раньше давал значение чуть БОЛЬШЕ
  // исходного work_hours (например 7.53 → 7.5333), и при capToSchedule capped factHours
  // не дотягивал до threshold, давая ложный underwork.
  const fallbackHours = Math.max(0, sched.work_hours);
  if (isWeekendDay) {
    if (sched.weekend_full_day_threshold_minutes != null) {
      return sched.weekend_full_day_threshold_minutes / 60;
    }
    if (sched.full_day_threshold_minutes != null) {
      return sched.full_day_threshold_minutes / 60;
    }
    return fallbackHours;
  }
  if (sched.full_day_threshold_minutes != null) {
    return sched.full_day_threshold_minutes / 60;
  }
  return fallbackHours;
};

/**
 * Порог "полного дня" с учётом конкретной даты (day_overrides + предпраздничный −1ч).
 * Симметричен бэкендовой getFullDayThresholdHoursForDate.
 */
export const getFullDayThresholdHoursForDay = (
  sched: IResolvedSchedule | undefined,
  calendar: IProductionCalendarMonth | null,
  year: number,
  month: number,
  day: number,
): number => {
  if (!sched) return 8;

  const isDayOff = isScheduleDayOff(sched, calendar, year, month, day);
  // Используем work_hours дня напрямую (а не через round в минуты) — иначе для дробных
  // нетто-часов (например 7.53) фронтовый порог становится 7.5333 и при capToSchedule=true
  // capped factHours (=7.53) ложно отмечается underwork.
  const fallbackHours = Math.max(0, getWorkHoursForDay(sched, year, month, day));

  if (isDayOff) {
    if (sched.weekend_full_day_threshold_minutes != null) {
      return sched.weekend_full_day_threshold_minutes / 60;
    }
    if (sched.full_day_threshold_minutes != null) {
      return sched.full_day_threshold_minutes / 60;
    }
    return fallbackHours;
  }

  // Предпраздничный рабочий день: порог снижается на 1 час (но не ниже 0)
  const preHolidayMinusHours = isPreHolidayForSchedule(sched, calendar, year, month, day) ? 1 : 0;

  if (sched.full_day_threshold_minutes != null) {
    return Math.max(0, sched.full_day_threshold_minutes / 60 - preHolidayMinusHours);
  }

  return Math.max(0, fallbackHours - preHolidayMinusHours);
};

/**
 * Норма часов на конкретный день (фронтовый аналог бэкендовой getDayNormHours):
 * 0 для нерабочего, work_hours-1 для предпраздничного будня (если respects_holidays), иначе work_hours.
 */
export const getDayNormHoursForDay = (
  sched: IResolvedSchedule | undefined,
  calendar: IProductionCalendarMonth | null,
  year: number,
  month: number,
  day: number,
): number => {
  if (!sched) return 0;
  if (isScheduleDayOff(sched, calendar, year, month, day)) return 0;
  const base = getWorkHoursForDay(sched, year, month, day);
  const minus = isPreHolidayForSchedule(sched, calendar, year, month, day) ? 1 : 0;
  return Math.max(0, base - minus);
};

export const getEffectiveLateThresholdForDay = (
  sched: IResolvedSchedule | undefined,
  year: number,
  month: number,
  day: number,
): string => {
  if (!sched) return '09:00:00';

  const override = sched.day_overrides?.[String(getISODow(new Date(year, month - 1, day)))];
  const workStart = override?.work_start || sched.work_start;
  const [h, m, s = 0] = workStart.split(':').map(Number);
  const totalMin = h * 60 + m + (sched.late_threshold_minutes || 0);
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(s || 0).padStart(2, '0')}`;
};

/** Парсит "HH:MM" в минуты. Возвращает null если невалидно или пусто. */
export const parseHMToMinutes = (value: string): number | null => {
  if (!value) return null;
  const m = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (Number.isNaN(h) || Number.isNaN(min) || h < 0 || min < 0 || min > 59 || h > 24) return null;
  return h * 60 + min;
};

/** Минуты → "HH:MM". Пустая строка если null. */
export const minutesToHM = (minutes: number | null | undefined): string => {
  if (minutes == null) return '';
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};
