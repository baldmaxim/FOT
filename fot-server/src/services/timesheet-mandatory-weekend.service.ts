import { resolveSchedulesForPeriod, loadCalendarMonth, isHolidayOnWorkday } from './schedule.service.js';
import { listNonHolidayWeekendDays, type WeekendDow } from './timesheet-weekend-days.util.js';

/**
 * Освобождает от «работы в выходной» первые `expected_{saturdays|sundays}_per_month`
 * отработанных непраздничных Сб/Вс месяца БЕЗ корректировки — это плановые
 * (обязательные по графику) выходные, входящие в норму. На обязательные слоты
 * претендуют только дни без корректировки; дни с корректировкой не освобождаются
 * (это явно помеченный «лишний» выход) и слоты не занимают.
 *
 * Праздник, выпавший на БУДНИЙ рабочий день графика (например 12 июня — пятница),
 * засчитывается как обязательная суббота и КОНКУРИРУЕТ за тот же субботний слот
 * (expected_saturdays_per_month) наравне с непраздничными субботами месяца —
 * не освобождается «бесплатно». Праздничные Сб/Вс под это правило НЕ попадают
 * (см. isHolidayOnWorkday).
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

  const calendarCache = new Map<string, Awaited<ReturnType<typeof loadCalendarMonth>>>();
  const getCalendar = async (year: number, month: number) => {
    const ckey = `${year}-${month}`;
    if (!calendarCache.has(ckey)) {
      calendarCache.set(ckey, await loadCalendarMonth(year, month));
    }
    return calendarCache.get(ckey) ?? null;
  };

  // Праздники-будни, зачтённые в субботнюю квоту. Их пускаем кандидатами в субботнюю
  // группу наряду с непраздничными субботами (validDays).
  const holidayWorkday = new Set<string>();

  // Группируем СКУД-выходные по (employee, год-месяц, dow). Праздник-будень кладём
  // в субботнюю группу (dow=6), создавая её при необходимости — это покрывает случай
  // «отработан только праздник, фактических суббот в периоде нет».
  const groups = new Map<string, { empId: number; year: number; month: number; dow: WeekendDow; dates: string[] }>();
  const pushToGroup = (empId: number, year: number, month: number, dow: WeekendDow, date: string): void => {
    const key = `${empId}|${year}-${month}|${dow}`;
    let group = groups.get(key);
    if (!group) {
      group = { empId, year, month, dow, dates: [] };
      groups.set(key, group);
    }
    group.dates.push(date);
  };

  for (const row of weekendSkudRows) {
    const { employee_id: empId, date } = row;
    const dateObj = new Date(`${date}T00:00:00`);
    const year = dateObj.getFullYear();
    const month = dateObj.getMonth() + 1;
    const schedule = schedules.get(empId)?.get(date);
    if (schedule && isHolidayOnWorkday(schedule, dateObj, await getCalendar(year, month))) {
      holidayWorkday.add(`${empId}|${date}`);
      pushToGroup(empId, year, month, 6, date);
      continue;
    }
    const dow = dateObj.getDay();
    if (dow !== 0 && dow !== 6) continue;
    pushToGroup(empId, year, month, dow as WeekendDow, date);
  }

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

    // Кандидаты на обязательный слот: непраздничные выходные дня недели + праздники-будни
    // (для субботней группы), все без корректировки. Сортируем и берём первые expected —
    // праздник-будень конкурирует за слот с обычной субботой.
    const candidates = [...new Set(dates)]
      .filter(date =>
        (validDays.has(date) || holidayWorkday.has(`${empId}|${date}`))
        && !adjustmentByEmployeeDate.has(`${empId}|${date}`),
      )
      .sort();

    for (const date of candidates.slice(0, expected)) {
      exemptions.add(`${empId}|${date}`);
    }
  }

  return exemptions;
}
