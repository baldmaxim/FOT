import { loadAttendanceAdjustments } from './attendance.service.js';
import { loadCalendarMonth } from './schedule.service.js';
import { buildObjectAttendanceData } from './timesheet-object.service.js';
import { fetchEmployeeIdsForObjects } from './timesheet-objects-export.service.js';

/**
 * Средняя фактическая численность на объекте — показатель ВНЕ приказа, справочная
 * колонка отчёта.
 *
 *   средняя численность(M) = Σ человеко-дней с часами > 0 / production_calendar.norm_days(M)
 *
 * Это НЕ среднесписочная численность: настоящая ССЧ считается по списочному составу
 * с учётом неявок, а здесь — по явке из СКУД и объектных корректировок. Отсюда и
 * название колонки.
 *
 * Человеко-дни считаются все, включая выходные, поэтому рядом отдаётся вторая величина
 * `weekend_person_days` — чтобы завышение было видно, а не пряталось в среднем.
 *
 * Отдельный эндпоинт, а не часть отчёта: основной отчёт — чистый SQL и отвечает быстро,
 * а этот путь тянет skud_events по всем сотрудникам объектов помесячно. Смешав их,
 * мы бы утопили первый экран.
 */

export interface ObjectKpiHeadcountRow {
  skud_object_id: string;
  period_month: string;
  person_days: number;
  weekend_person_days: number;
  norm_days: number | null;
  /** null, когда в производственном календаре нет месяца: делить не на что. */
  avg_headcount: number | null;
}

/** Последний день месяца: локальные Date-конструкторы дают сдвиг в UTC-хостинге. */
function monthBounds(periodMonth: string): { start: string; end: string } {
  const [year, month] = periodMonth.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    start: `${periodMonth.slice(0, 7)}-01`,
    end: `${periodMonth.slice(0, 7)}-${String(lastDay).padStart(2, '0')}`,
  };
}

function eachMonth(monthFrom: string, monthTo: string): string[] {
  const months: string[] = [];
  const [fromYear, fromMonth] = monthFrom.split('-').map(Number);
  const [toYear, toMonth] = monthTo.split('-').map(Number);
  let cursor = fromYear * 12 + (fromMonth - 1);
  const last = toYear * 12 + (toMonth - 1);
  while (cursor <= last) {
    const year = Math.floor(cursor / 12);
    const month = (cursor % 12) + 1;
    months.push(`${year}-${String(month).padStart(2, '0')}-01`);
    cursor += 1;
  }
  return months;
}

export async function fetchObjectKpiHeadcount(params: {
  objectIds: string[];
  monthFrom: string;
  monthTo: string;
}): Promise<ObjectKpiHeadcountRow[]> {
  if (params.objectIds.length === 0) return [];

  const allowedObjects = new Set(params.objectIds);
  const result: ObjectKpiHeadcountRow[] = [];

  for (const periodMonth of eachMonth(params.monthFrom, params.monthTo)) {
    const { start, end } = monthBounds(periodMonth);

    // Сотрудники, отметившиеся на этих объектах за месяц — батчем, одним запросом.
    const employeeIds = await fetchEmployeeIdsForObjects(params.objectIds, start, end);

    const [year, month] = periodMonth.split('-').map(Number);
    const calendar = await loadCalendarMonth(year, month);
    const normDays = calendar?.norm_days ?? null;

    const holidays = new Set([
      ...(calendar?.holidays ?? []),
      ...(calendar?.mandatory_holidays ?? []),
    ]);

    // Счётчики заводим на все объекты скоупа, чтобы месяц без активности отдавал 0,
    // а не пропадал из ответа — иначе на фронте колонка осталась бы со скелетоном.
    const personDays = new Map<string, number>();
    const weekendDays = new Map<string, number>();
    for (const objectId of params.objectIds) {
      personDays.set(objectId, 0);
      weekendDays.set(objectId, 0);
    }

    if (employeeIds.length > 0) {
      const adjustments = await loadAttendanceAdjustments(employeeIds, start, end);
      const data = await buildObjectAttendanceData({
        employeeIds,
        startDate: start,
        endDate: end,
        adjustments,
      });

      // Повторная фильтрация обязательна: сотрудник объекта A приносит записи и по другим
      // объектам, где он работал в том же месяце. Без неё числа завышаются молча —
      // тот же шаг делает timesheet-objects-export.service.ts.
      const counted = new Set<string>();
      for (const entry of data.objectEntries) {
        if (!entry.object_id || !allowedObjects.has(entry.object_id)) continue;
        if (entry.display_hours_worked <= 0) continue;

        // Человеко-день — это пара «сотрудник + дата» на объекте. Несколько записей
        // за день (корректировка поверх СКУД) не должны считаться дважды.
        const key = `${entry.object_id}|${entry.employee_id}|${entry.work_date}`;
        if (counted.has(key)) continue;
        counted.add(key);

        personDays.set(entry.object_id, (personDays.get(entry.object_id) ?? 0) + 1);

        const weekday = new Date(`${entry.work_date}T00:00:00Z`).getUTCDay();
        if (weekday === 0 || weekday === 6 || holidays.has(entry.work_date)) {
          weekendDays.set(entry.object_id, (weekendDays.get(entry.object_id) ?? 0) + 1);
        }
      }
    }

    for (const objectId of params.objectIds) {
      const days = personDays.get(objectId) ?? 0;
      result.push({
        skud_object_id: objectId,
        period_month: periodMonth,
        person_days: days,
        weekend_person_days: weekendDays.get(objectId) ?? 0,
        norm_days: normDays,
        avg_headcount: normDays ? Number((days / normDays).toFixed(2)) : null,
      });
    }
  }

  return result;
}
