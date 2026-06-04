/**
 * Чистые хелперы по выходным дням месяца (без БД-зависимостей).
 * Вынесено из timesheet.controller, чтобы переиспользовать в проверках
 * подачи табеля (корректировки + служебка) без циклических импортов.
 */

export type WeekendDow = 0 | 6; // 0 = воскресенье, 6 = суббота

/**
 * ISO-даты непраздничных суббот/воскресений месяца year-mon. mandatory_holidays
 * исключаются всегда; обычные holidays — только если respectsHolidays.
 */
export const listNonHolidayWeekendDays = (
  year: number,
  mon: number,
  calendar: { holidays?: string[]; mandatory_holidays?: string[] } | null,
  respectsHolidays: boolean,
  dow: WeekendDow,
): string[] => {
  const lastDay = new Date(year, mon, 0).getDate();
  const monthStr = String(mon).padStart(2, '0');
  const out: string[] = [];
  for (let d = 1; d <= lastDay; d++) {
    if (new Date(year, mon - 1, d).getDay() !== dow) continue;
    const iso = `${year}-${monthStr}-${String(d).padStart(2, '0')}`;
    const isHoliday = !!calendar && (
      (calendar.mandatory_holidays?.includes(iso) ?? false)
      || (respectsHolidays && (calendar.holidays?.includes(iso) ?? false))
    );
    if (isHoliday) continue;
    out.push(iso);
  }
  return out;
};
