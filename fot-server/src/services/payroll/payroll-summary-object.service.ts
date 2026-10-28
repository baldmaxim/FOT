/**
 * «Свод»: объект строки, когда базовый объект месяца (payroll-month-attribution.service — закрытый табель,
 * затем режим месяца) — «Не определён». Только для строки «Свода»: категория и расчётный листок берут
 * базовый объект и этим модулем не пользуются.
 *
 * Порядок:
 *   1. режим месяца — закреплённый объект или «Офис» (нужен, когда в табеле больше часов «без объекта»);
 *   2. часы месяца правилом ночного объекта табелирования (loadTimesheetObjectHours): СКУД + объектные
 *      корректировки, офисы — суммой в «Офис», «без объекта» не считается; объекты, неактивные сейчас,
 *      считаются — в прошлом месяце площадка работала. Текущий месяц — по вчера;
 *   3. иначе — «Не определён».
 */
import { performance } from 'node:perf_hooks';

import { moscowTodayIso } from '../../utils/date.utils.js';
import { loadSkudObjects, loadTimesheetObjectHours } from '../employee-timesheet-object.service.js';
import { monthPairKey, type IMonthAttribution } from './payroll-month-attribution.service.js';
import {
  fallbackSummaryObject,
  summaryHoursPeriod,
  summaryObjectFromHours,
  SUMMARY_UNKNOWN,
  type ISummaryObject,
  type ISummaryObjectMeta,
} from './payroll-summary.attribution.js';

/** Сколько пар «Не определён», скольким объект дал режим месяца, скольким считали часы и за сколько мс. */
export interface ISummaryObjectsStats {
  unknown: number;
  byMode: number;
  hoursEmployees: number;
  hoursMs: number;
}

/**
 * Объекты «Свода» для пар («сотрудник|YYYY-MM») с базовым «Не определён». В ответе — только пары,
 * которым объект нашёлся; остальные остаются «Не определён». stats — счётчики для замера «Свода».
 */
export const resolveSummaryObjects = async (
  attribution: ReadonlyMap<string, IMonthAttribution>,
  now: Date = new Date(),
  stats?: ISummaryObjectsStats,
): Promise<Map<string, ISummaryObject>> => {
  const result = new Map<string, ISummaryObject>();
  const unknown = [...attribution].filter(([, item]) => item.object.key === SUMMARY_UNKNOWN.key);
  if (stats) stats.unknown += unknown.length;
  if (unknown.length === 0) return result;

  const objects = await loadSkudObjects();
  const meta = new Map<string, ISummaryObjectMeta>(
    [...objects.values()].map(object => [object.id, { name: object.name, address: object.alt_name }]),
  );

  // Режим месяца; кому он объекта не дал — часы, пачкой по месяцу.
  const byMonth = new Map<string, number[]>();
  for (const [key, item] of unknown) {
    const byMode = fallbackSummaryObject(item.mode, meta);
    if (byMode.key !== SUMMARY_UNKNOWN.key) {
      result.set(key, byMode);
      if (stats) stats.byMode += 1;
      continue;
    }
    const [employeeId, month] = key.split('|');
    const list = byMonth.get(month);
    if (list) list.push(Number(employeeId));
    else byMonth.set(month, [Number(employeeId)]);
  }

  const today = moscowTodayIso(now);
  for (const [month, employeeIds] of byMonth) {
    const period = summaryHoursPeriod(`${month}-01`, today);
    if (!period) continue;
    const hoursStarted = performance.now();
    const hours = await loadTimesheetObjectHours(employeeIds, period, {
      todayStr: today,
      objectsById: objects,
      includeInactive: true,
    });
    if (stats) {
      stats.hoursEmployees += employeeIds.length;
      stats.hoursMs += performance.now() - hoursStarted;
    }
    for (const employeeId of employeeIds) {
      const object = summaryObjectFromHours(hours.get(employeeId)?.[0]);
      if (object) result.set(monthPairKey(employeeId, month), object);
    }
  }
  return result;
};
