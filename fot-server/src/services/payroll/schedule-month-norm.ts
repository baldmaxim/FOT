/**
 * Норма графика за месяц по дням — одно правило для зарплаты по часам (countScheduleMonthNormMinutes и снимок нормы
 * в основе — norm_plan, миграция 368) и для блока «График работы» в табеле «По сотруднику». Норма дня — по графику
 * этой даты (getDayNormHours: выходной и праздник графика — 0, предпраздничный — минус час). Квота обязательных Сб/Вс
 * и её часы берутся из графика последнего дня месяца. Квота к датам не привязана: в норму идут первые отработанные
 * выходы. Приём и увольнение норму не режут. Чистый модуль, без БД.
 */
import type { IProductionCalendarMonth, IResolvedSchedule } from '../../types/index.js';
import { getDayNormHours } from '../schedule.service.js';

export interface IScheduleMonthNormDay {
  /** YYYY-MM-DD. */
  date: string;
  /** Норма дня по графику, часы; 0 — выходной или праздник графика. */
  hours: number;
}

export interface IScheduleMonthNorm {
  /** Даты месяца, у которых есть график, по порядку. */
  days: IScheduleMonthNormDay[];
  /** График есть на каждый день месяца. */
  complete: boolean;
  /** Квота обязательных суббот и воскресений — из графика последнего дня; его нет — 0. */
  saturdays: number;
  sundays: number;
  /** Часы дня квоты — work_hours графика последнего дня. */
  quotaHours: number;
  /** Норма месяца в минутах: (Σ часов дней + квота × её часы) × 60, округление один раз; null — графика нет хоть на день. */
  totalMinutes: number | null;
}

/** Снимок нормы в основе (norm_plan): минуты дней с нормой и квота; итог — norm_minutes той же основы. */
export interface IPayrollNormPlan {
  /** YYYY-MM-DD → минуты нормы дня; дни с нормой 0 не пишутся. */
  days: Record<string, number>;
  saturdays: number;
  sundays: number;
  /** Минуты дня квоты Сб/Вс. */
  quota_minutes: number;
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** Норма месяца YYYY-MM по графикам дат — правила в шапке файла. */
export const scheduleMonthNorm = (
  schedules: ReadonlyMap<string, IResolvedSchedule> | undefined,
  month: string,
  calendar: IProductionCalendarMonth | null,
): IScheduleMonthNorm => {
  const [year, mon] = month.split('-').map(Number);
  const total = new Date(year, mon, 0).getDate();
  const days: IScheduleMonthNormDay[] = [];
  let hours = 0;
  let complete = true;
  for (let day = 1; day <= total; day++) {
    const date = `${month}-${pad2(day)}`;
    const schedule = schedules?.get(date);
    if (!schedule) {
      complete = false;
      continue;
    }
    const dayHours = getDayNormHours(schedule, new Date(year, mon - 1, day), calendar);
    days.push({ date, hours: dayHours });
    hours += dayHours;
  }
  const last = schedules?.get(`${month}-${pad2(total)}`);
  const saturdays = last?.expected_saturdays_per_month ?? 0;
  const sundays = last?.expected_sundays_per_month ?? 0;
  const quotaHours = last?.work_hours ?? 0;
  return {
    days,
    complete,
    saturdays,
    sundays,
    quotaHours,
    totalMinutes: complete ? Math.round((hours + (saturdays + sundays) * quotaHours) * 60) : null,
  };
};

/** Снимок для основы; графика нет хоть на день (нормы нет) — null. */
export const toNormPlan = (norm: IScheduleMonthNorm): IPayrollNormPlan | null => {
  if (!norm.complete) return null;
  const days: Record<string, number> = {};
  for (const day of norm.days) {
    const minutes = Math.round(day.hours * 60);
    if (minutes > 0) days[day.date] = minutes;
  }
  return {
    days,
    saturdays: norm.saturdays,
    sundays: norm.sundays,
    quota_minutes: Math.round(norm.quotaHours * 60),
  };
};
