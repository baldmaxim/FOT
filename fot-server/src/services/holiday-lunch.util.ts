import type { IProductionCalendarMonth, IResolvedSchedule } from '../types/index.js';
import { formatDateToISO } from '../utils/date.utils.js';
import { getScheduleForDate } from './schedule.service.js';

/** С этой даты обед в праздник производственного календаря не вычитается. */
export const LUNCH_FREE_HOLIDAY_FROM = '2026-11-01';

/**
 * Праздник без вычета обеда. Флаг графика respects_holidays здесь не проверяется намеренно:
 * правило действует на всех графиках, даже там, где праздник — обычный рабочий день.
 */
export const isLunchFreeHoliday = (
  date: Date,
  calendar: IProductionCalendarMonth | null,
): boolean => {
  if (!calendar) return false;
  const iso = formatDateToISO(date);
  if (iso < LUNCH_FREE_HOLIDAY_FROM) return false;
  return Boolean(calendar.holidays?.includes(iso) || calendar.mandatory_holidays?.includes(iso));
};

/** Обед к вычету при расчёте оплачиваемых часов дня, в минутах. */
export const getPaidLunchMinutes = (
  schedule: IResolvedSchedule,
  date: Date,
  calendar: IProductionCalendarMonth | null,
): number => (
  isLunchFreeHoliday(date, calendar) ? 0 : getScheduleForDate(schedule, date).lunch_minutes
);

/**
 * На сколько часов поднять предел по графику в такой праздник. Норма и work_hours хранятся
 * за вычетом обеда, поэтому без этой надбавки невычтенный час срезался бы пределом.
 */
export const getHolidayLunchHours = (
  schedule: IResolvedSchedule,
  date: Date,
  calendar: IProductionCalendarMonth | null,
): number => (
  isLunchFreeHoliday(date, calendar)
    ? Math.max(0, getScheduleForDate(schedule, date).lunch_minutes || 0) / 60
    : 0
);
