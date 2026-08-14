import { queryOne } from '../config/postgres.js';

/**
 * N-й рабочий день месяца — срок автоматической фиксации плана.
 *
 * Правила «не суббота/воскресенье и не праздник» НЕДОСТАТОЧНО: production_calendar
 * хранит norm_days, holidays, mandatory_holidays и pre_holidays, но не содержит
 * перенесённых рабочих суббот. В месяце с переносом вычисленный день разошёлся бы
 * с официальным календарём — поэтому миграция 241 добавляет working_weekends.
 *
 * Календарь читается СВОИМ запросом, а не через loadCalendarMonth: та функция обслуживает
 * табель, и добавление в её SELECT новой колонки уронило бы весь табель, если бэкенд
 * когда-нибудь окажется задеплоен раньше миграции. Здесь цена такой ошибки — только KPI.
 */

export interface CalendarMonthDays {
  holidays: Set<string>;
  workingWeekends: Set<string>;
}

async function loadMonthDays(year: number, month: number): Promise<CalendarMonthDays | null> {
  const row = await queryOne<{
    holidays: string[] | null;
    mandatory_holidays: string[] | null;
    working_weekends: string[] | null;
  }>(
    `SELECT holidays, mandatory_holidays, working_weekends
       FROM production_calendar
      WHERE year = $1 AND month = $2`,
    [year, month],
  );
  if (!row) return null;

  return {
    holidays: new Set([...(row.holidays ?? []), ...(row.mandatory_holidays ?? [])]),
    workingWeekends: new Set(row.working_weekends ?? []),
  };
}

const iso = (year: number, month: number, day: number): string =>
  `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

/**
 * @returns дату N-го рабочего дня в формате YYYY-MM-DD либо null, если месяца нет
 *          в производственном календаре. null означает «срок неизвестен» — фиксация
 *          не выполняется, а не выполняется «на всякий случай сегодня».
 */
export async function getNthWorkingDay(
  year: number,
  month: number,
  n: number,
): Promise<string | null> {
  const calendar = await loadMonthDays(year, month);
  if (!calendar) return null;

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let counted = 0;

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = iso(year, month, day);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const isWeekend = weekday === 0 || weekday === 6;

    // Перенесённая рабочая суббота считается рабочим днём, даже если это выходной
    // по календарной сетке; праздник не считается никогда.
    const isWorking = calendar.workingWeekends.has(date)
      || (!isWeekend && !calendar.holidays.has(date));
    if (!isWorking) continue;

    counted += 1;
    if (counted === n) return date;
  }

  // Рабочих дней в месяце меньше, чем N (теоретически — январские каникулы при N > 15).
  return null;
}
