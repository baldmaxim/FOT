import { resolveSchedulesForPeriod, loadCalendarMonth } from './schedule.service.js';
import { listNonHolidayWeekendDays, type WeekendDow } from './timesheet-weekend-days.util.js';

/**
 * Освобождает от «работы в выходной» первые `expected_{saturdays|sundays}_per_month`
 * отработанных непраздничных Сб/Вс месяца БЕЗ корректировки — это плановые
 * (обязательные по графику) выходные, входящие в норму. На обязательные слоты
 * претендуют только дни без корректировки; дни с корректировкой не освобождаются
 * (это явно помеченный «лишний» выход) и слоты не занимают.
 *
 * Группировка по (employee, год-месяц, dow). Праздничные Сб/Вс (mandatory_holidays
 * всегда, holidays при respects_holidays) в кандидаты не попадают.
 *
 * Используется и проверкой корректировок (validateCorrectionAttachments), и
 * проверкой служебной записки (checkWeekendWorkRequirement) — единый источник
 * истины «какие выходные плановые».
 */
export async function computeMandatoryExemptions(
  weekendSkudRows: Array<{ employee_id: number; date: string }>,
  adjustmentByEmployeeDate: Set<string>,
): Promise<Set<string>> {
  if (weekendSkudRows.length === 0) return new Set();

  const employeeIds = [...new Set(weekendSkudRows.map(r => r.employee_id))];
  const exemptions = new Set<string>();

  const allDates = weekendSkudRows.map(r => r.date).sort();
  const schedules = await resolveSchedulesForPeriod(
    employeeIds.map(id => ({ id })),
    allDates[0]!,
    allDates[allDates.length - 1]!,
  );

  // Группируем СКУД-выходные по (employee, год-месяц, dow)
  const groups = new Map<string, { empId: number; year: number; month: number; dow: WeekendDow; dates: string[] }>();
  for (const row of weekendSkudRows) {
    const { employee_id: empId, date } = row;
    const dateObj = new Date(`${date}T00:00:00`);
    const dow = dateObj.getDay();
    if (dow !== 0 && dow !== 6) continue;
    const year = dateObj.getFullYear();
    const month = dateObj.getMonth() + 1;
    const key = `${empId}|${year}-${month}|${dow}`;
    let group = groups.get(key);
    if (!group) {
      group = { empId, year, month, dow: dow as WeekendDow, dates: [] };
      groups.set(key, group);
    }
    group.dates.push(date);
  }

  const calendarCache = new Map<string, Awaited<ReturnType<typeof loadCalendarMonth>>>();
  const getCalendar = async (year: number, month: number) => {
    const ckey = `${year}-${month}`;
    if (!calendarCache.has(ckey)) {
      calendarCache.set(ckey, await loadCalendarMonth(year, month));
    }
    return calendarCache.get(ckey) ?? null;
  };

  for (const group of groups.values()) {
    const { empId, year, month, dow, dates } = group;
    // Любой день группы даёт нужные атрибуты графика (стабильны в пределах месяца)
    const dailySchedule = schedules.get(empId)?.get(dates[0]!);
    if (!dailySchedule) continue;

    const expected = dow === 6
      ? (dailySchedule.expected_saturdays_per_month ?? 0)
      : (dailySchedule.expected_sundays_per_month ?? 0);
    if (expected <= 0) continue;

    const monthCalendar = await getCalendar(year, month);
    const validDays = new Set(listNonHolidayWeekendDays(
      year,
      month,
      monthCalendar,
      dailySchedule.respects_holidays ?? true,
      dow,
    ));

    // Кандидаты на обязательный слот: непраздничные выходные без корректировки
    const candidates = [...new Set(dates)]
      .filter(date => validDays.has(date) && !adjustmentByEmployeeDate.has(`${empId}|${date}`))
      .sort();

    for (const date of candidates.slice(0, expected)) {
      exemptions.add(`${empId}|${date}`);
    }
  }

  return exemptions;
}
