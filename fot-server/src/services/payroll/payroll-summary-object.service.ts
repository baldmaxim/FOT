/**
 * «Свод»: объект строки, когда базовый объект месяца (payroll-month-attribution.service — закрытый табель,
 * затем режим месяца) — «Не определён». «Свод» показывает, какой объект сколько платит сотрудникам, поэтому
 * у каждого должен быть объект (решение 16.11.2026). Тем же путём — фильтр «Все объекты» на «Расчётах»
 * (payroll-month-profile.service.ts). От объекта строки зависит и категория «Офис» (payroll-summary.service.ts);
 * расчётный листок берёт базовый объект и этим модулем не пользуется.
 *
 * Порядок:
 *   1. режим месяца — закреплённый объект или «Офис» (нужен, когда в табеле больше часов «без объекта»);
 *   2. часы месяца правилом ночного объекта табелирования (loadTimesheetObjectHours): СКУД + объектные
 *      корректировки, офисы — суммой в «Офис», «без объекта» не считается; объекты, неактивные сейчас,
 *      считаются — в прошлом месяце площадка работала. Текущий месяц — по вчера;
 *   3. прежний объект, как у авторасчёта «нет часов — объект прежний»: ближайший из PREVIOUS_TIMESHEET_MONTHS
 *      прошлых месяцев, где в закрытом табеле есть часы на объекте, затем ближайший из PREVIOUS_HOURS_MONTHS
 *      прошлых месяцев с часами по проходам и объектным правкам. Уволенный в начале месяца, весь месяц в отпуске,
 *      расчёт при увольнении в следующем месяце — за них платит объект, где работали;
 *   4. объект бригады или отдела месяца — основной объект подач отдела (часы всех людей): новичок или бригадник
 *      без единого часа — за него платит объект, где работает бригада;
 *   5. текущий объект табелирования (окно «Режим табелирования» или авторасчёт) — ручка для остатка: назначили
 *      объект в окне — он и в «Своде»;
 *   6. иначе — «Не определён».
 */
import { performance } from 'node:perf_hooks';

import type { DbExecutor } from '../../config/postgres.js';
import { moscowTodayIso } from '../../utils/date.utils.js';
import { loadSkudObjects, loadTimesheetObjectHours } from '../employee-timesheet-object.service.js';
import { resolveExportModes } from '../timesheet-export-mode.service.js';
import {
  loadDepartmentMonthBreakdown,
  loadMonthBreakdown,
  monthPairKey,
  type IMonthAttribution,
} from './payroll-month-attribution.service.js';
import {
  fallbackSummaryObject,
  pickMainKnownObject,
  previousMonthStarts,
  summaryHoursPeriod,
  summaryObjectFromHours,
  SUMMARY_UNKNOWN,
  type ISummaryObject,
  type ISummaryObjectMeta,
} from './payroll-summary.attribution.js';

/** Сколько прошлых месяцев закрытых табелей смотреть за прежним объектом. */
export const PREVIOUS_TIMESHEET_MONTHS = 6;
/** Сколько прошлых месяцев проходов смотреть за прежним объектом. */
export const PREVIOUS_HOURS_MONTHS = 3;

/**
 * Сколько пар «Не определён», скольким объект дал каждый шаг, скольким считали часы месяца и за сколько мс
 * (часы прошлых месяцев — в том же hoursMs).
 */
export interface ISummaryObjectsStats {
  unknown: number;
  byMode: number;
  hoursEmployees: number;
  hoursMs: number;
  byPrevTimesheet: number;
  byPrevHours: number;
  byDepartment: number;
  byCurrentObject: number;
}

type StepStat = 'byPrevTimesheet' | 'byPrevHours' | 'byDepartment' | 'byCurrentObject';

/** Шаг, которым найден объект пары (API для ЗУП3 — object_source). */
export type SummaryObjectStep =
  | 'mode' | 'month_hours' | 'previous_timesheet' | 'previous_hours' | 'department' | 'current_object';

const STEP_OF: Record<StepStat, SummaryObjectStep> = {
  byPrevTimesheet: 'previous_timesheet',
  byPrevHours: 'previous_hours',
  byDepartment: 'department',
  byCurrentObject: 'current_object',
};

export interface IResolveSummaryObjectsOptions {
  /** Клиент транзакции (снимок API для ЗУП3); без него — пул. */
  exec?: DbExecutor;
  /** Сюда пишется шаг каждой найденной пары. */
  steps?: Map<string, SummaryObjectStep>;
}

/** Пары «сотрудник|YYYY-MM» по месяцам: месяц → сотрудники. */
const groupByMonth = (keys: Iterable<string>): Map<string, number[]> => {
  const byMonth = new Map<string, number[]>();
  for (const key of keys) {
    const [employeeId, month] = key.split('|');
    const list = byMonth.get(month);
    if (list) list.push(Number(employeeId));
    else byMonth.set(month, [Number(employeeId)]);
  }
  return byMonth;
};

/** Имя объекта — текущее из справочника СКУД (в разбивке — имя на момент закрытия табеля), как в attributeMonths. */
const withCurrentName = (object: ISummaryObject, meta: ReadonlyMap<string, ISummaryObjectMeta>): ISummaryObject => ({
  key: object.key,
  name: meta.get(object.key)?.name?.trim() || object.name,
});

/**
 * Объекты «Свода» для пар («сотрудник|YYYY-MM») с базовым «Не определён». В ответе — только пары,
 * которым объект нашёлся; остальные остаются «Не определён». stats — счётчики для замера «Свода».
 */
export const resolveSummaryObjects = async (
  attribution: ReadonlyMap<string, IMonthAttribution>,
  now: Date = new Date(),
  stats?: ISummaryObjectsStats,
  options: IResolveSummaryObjectsOptions = {},
): Promise<Map<string, ISummaryObject>> => {
  const { exec, steps } = options;
  const result = new Map<string, ISummaryObject>();
  const unknown = [...attribution].filter(([, item]) => item.object.key === SUMMARY_UNKNOWN.key);
  if (stats) stats.unknown += unknown.length;
  if (unknown.length === 0) return result;

  // Без exec вызовы — прежние (их аргументы сверяют тесты «Свода»).
  const objects = await (exec ? loadSkudObjects(exec) : loadSkudObjects());
  const meta = new Map<string, ISummaryObjectMeta>(
    [...objects.values()].map(object => [object.id, { name: object.name, address: object.alt_name }]),
  );
  const today = moscowTodayIso(now);
  const remaining = new Set<string>();
  const found = (key: string, object: ISummaryObject, step: StepStat): void => {
    result.set(key, object);
    steps?.set(key, STEP_OF[step]);
    remaining.delete(key);
    if (stats) stats[step] += 1;
  };
  const objectHours = async (employeeIds: number[], monthStart: string) => {
    const period = summaryHoursPeriod(monthStart, today);
    if (!period || employeeIds.length === 0) return null;
    const started = performance.now();
    const hours = await loadTimesheetObjectHours(employeeIds, period, {
      ...(exec ? { exec } : {}),
      todayStr: today,
      objectsById: objects,
      includeInactive: true,
    });
    if (stats) stats.hoursMs += performance.now() - started;
    return hours;
  };

  // 1. Режим месяца.
  for (const [key, item] of unknown) {
    const byMode = fallbackSummaryObject(item.mode, meta);
    if (byMode.key !== SUMMARY_UNKNOWN.key) {
      result.set(key, byMode);
      steps?.set(key, 'mode');
      if (stats) stats.byMode += 1;
    } else {
      remaining.add(key);
    }
  }

  // 2. Часы месяца, пачкой по месяцу.
  for (const [month, employeeIds] of groupByMonth([...remaining])) {
    const hours = await objectHours(employeeIds, `${month}-01`);
    if (!hours) continue;
    if (stats) stats.hoursEmployees += employeeIds.length;
    for (const employeeId of employeeIds) {
      const object = summaryObjectFromHours(hours.get(employeeId)?.[0]);
      if (object) {
        remaining.delete(monthPairKey(employeeId, month));
        result.set(monthPairKey(employeeId, month), object);
        steps?.set(monthPairKey(employeeId, month), 'month_hours');
      }
    }
  }

  // 3а. Прежний объект по закрытым табелям: один запрос на все прошлые месяцы всех пар.
  if (remaining.size > 0) {
    const pairs = [...remaining].map(key => key.split('|'));
    const employeeIds = [...new Set(pairs.map(([employeeId]) => Number(employeeId)))];
    const monthStarts = [...new Set(pairs.flatMap(([, month]) => previousMonthStarts(month, PREVIOUS_TIMESHEET_MONTHS)))];
    const breakdown = await (exec
      ? loadMonthBreakdown(monthStarts, employeeIds, undefined, exec)
      : loadMonthBreakdown(monthStarts, employeeIds));
    for (const [employeeId, month] of pairs) {
      for (const previous of previousMonthStarts(month, PREVIOUS_TIMESHEET_MONTHS)) {
        const object = pickMainKnownObject(breakdown.get(monthPairKey(Number(employeeId), previous.slice(0, 7))) ?? []);
        if (object) {
          found(monthPairKey(Number(employeeId), month), withCurrentName(object, meta), 'byPrevTimesheet');
          break;
        }
      }
    }
  }

  // 3б. Прежний объект по проходам: месяц за месяцем назад, только кому ещё не нашёлся.
  for (const [month, employeeIds] of groupByMonth([...remaining])) {
    let left = employeeIds;
    for (const previous of previousMonthStarts(month, PREVIOUS_HOURS_MONTHS)) {
      if (left.length === 0) break;
      const hours = await objectHours(left, previous);
      if (!hours) continue;
      left = left.filter(employeeId => {
        const object = summaryObjectFromHours(hours.get(employeeId)?.[0]);
        if (!object) return true;
        found(monthPairKey(employeeId, month), object, 'byPrevHours');
        return false;
      });
    }
  }

  // 4. Объект бригады или отдела месяца.
  if (remaining.size > 0) {
    const departmentOf = new Map([...remaining].map(key => [key, attribution.get(key)?.departmentId ?? null]));
    const departmentIds = [...new Set([...departmentOf.values()].filter((id): id is string => id !== null))];
    const months = [...new Set([...remaining].map(key => `${key.split('|')[1]}-01`))];
    const departments = await (exec
      ? loadDepartmentMonthBreakdown(months, departmentIds, exec)
      : loadDepartmentMonthBreakdown(months, departmentIds));
    for (const [key, departmentId] of departmentOf) {
      if (!departmentId) continue;
      const object = pickMainKnownObject(departments.get(`${departmentId}|${key.split('|')[1]}`) ?? []);
      if (object) found(key, withCurrentName(object, meta), 'byDepartment');
    }
  }

  // 5. Текущий объект табелирования (живой режим: окно «Режим табелирования» или авторасчёт).
  if (remaining.size > 0) {
    const ids = [...new Set([...remaining].map(key => Number(key.split('|')[0])))];
    const modes = await (exec ? resolveExportModes(ids, exec) : resolveExportModes(ids));
    for (const key of [...remaining]) {
      const object = fallbackSummaryObject(modes.get(Number(key.split('|')[0])), meta);
      if (object.key !== SUMMARY_UNKNOWN.key) found(key, object, 'byCurrentObject');
    }
  }
  return result;
};
