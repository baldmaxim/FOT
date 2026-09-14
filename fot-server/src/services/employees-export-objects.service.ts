/**
 * «Экспорт сотрудников»: основной объект — тот, где сотрудник набрал больше
 * всего часов за период выгрузки. Источник часов — buildObjectAttendanceData
 * (СКУД по объектам + объектные корректировки), как в KPI объектов.
 */
import { loadAttendanceAdjustments } from './attendance.service.js';
import { buildObjectAttendanceData, type IAttendanceObjectEntry } from './timesheet-object.service.js';
import type { IExportPeriod } from './employees-export.service.js';

/**
 * Сотрудников на один проход. Расчёт по объектам синхронно грузит CPU, а сервер
 * работает одним процессом: меньший чанк + уступка event loop между чанками не
 * дают выгрузке на всю организацию подвешивать остальные запросы.
 */
export const EMPLOYEE_CHUNK_SIZE = 1000;

const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

const UNKNOWN_OBJECT_KEY = '__unknown_object__';

const collator = new Intl.Collator('ru');

type IObjectHoursEntry = Pick<
  IAttendanceObjectEntry,
  'employee_id' | 'object_key' | 'object_id' | 'object_name' | 'display_hours_worked'
>;

export interface IMainObject {
  objectId: string;
  objectName: string;
  /** Сумма часов на объекте за период, округлена до центичасов, > 0. */
  hours: number;
}

/** Только названия — для потребителей, которым id и часы не нужны. */
export function pickMainObject(entries: IObjectHoursEntry[]): Map<number, string> {
  const result = new Map<number, string>();
  for (const [employeeId, main] of pickMainObjectDetailed(entries)) result.set(employeeId, main.objectName);
  return result;
}

/**
 * Порядок объектов сотрудника: часы по убыванию, при равенстве — по названию, затем
 * по object_id. Один компаратор для расчёта на лету и для чтения снимка: SQL ORDER BY
 * с collation БД мог бы разойтись с Intl.Collator.
 */
export function compareObjectHours(a: IMainObject, b: IMainObject): number {
  if (a.hours !== b.hours) return b.hours - a.hours;
  const byName = collator.compare(a.objectName, b.objectName);
  if (byName !== 0) return byName;
  if (a.objectId === b.objectId) return 0;
  return a.objectId < b.objectId ? -1 : 1;
}

/**
 * Сначала суммирует часы по (сотрудник, объект) — отрицательные правки входят
 * в сумму, — затем оставляет объекты с итогом > 0 (округлён до центичасов до
 * сравнения) и сортирует их compareObjectHours. Объекты без id и «Не определён»
 * пропускаются — в результате object_id всегда непустой.
 */
export function sumObjectHoursByEmployee(entries: IObjectHoursEntry[]): Map<number, IMainObject[]> {
  const totals = new Map<number, Map<string, { name: string; hours: number }>>();

  for (const entry of entries) {
    if (!entry.object_id || entry.object_key === UNKNOWN_OBJECT_KEY) continue;
    const hours = Number(entry.display_hours_worked);
    if (!Number.isFinite(hours)) continue;

    let byObject = totals.get(entry.employee_id);
    if (!byObject) {
      byObject = new Map();
      totals.set(entry.employee_id, byObject);
    }
    const current = byObject.get(entry.object_id);
    if (current) current.hours += hours;
    else byObject.set(entry.object_id, { name: entry.object_name, hours });
  }

  const result = new Map<number, IMainObject[]>();
  for (const [employeeId, byObject] of totals) {
    const list: IMainObject[] = [];
    for (const [objectId, total] of byObject) {
      // Округление до центичасов гасит хвосты сложения float (0.1 + 0.2).
      const hours = Math.round(total.hours * 100) / 100;
      if (hours <= 0) continue;
      list.push({ objectId, objectName: total.name, hours });
    }
    if (list.length === 0) continue;
    list.sort(compareObjectHours);
    result.set(employeeId, list);
  }
  return result;
}

/** Первый объект списка — основной. */
export function mainObjectsFromLists(lists: Map<number, IMainObject[]>): Map<number, IMainObject> {
  const result = new Map<number, IMainObject>();
  for (const [employeeId, list] of lists) {
    if (list.length > 0) result.set(employeeId, list[0]);
  }
  return result;
}

/** Объект с максимальным итогом > 0; при равенстве — compareObjectHours. */
export function pickMainObjectDetailed(entries: IObjectHoursEntry[]): Map<number, IMainObject> {
  return mainObjectsFromLists(sumObjectHoursByEmployee(entries));
}

export async function loadMainObjectByEmployee(
  employeeIds: number[],
  period: IExportPeriod,
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  for (const [employeeId, main] of await loadMainObjectDetailedByEmployee(employeeIds, period)) {
    result.set(employeeId, main.objectName);
  }
  return result;
}

export async function loadMainObjectDetailedByEmployee(
  employeeIds: number[],
  period: IExportPeriod,
): Promise<Map<number, IMainObject>> {
  return mainObjectsFromLists(await loadObjectHoursByEmployee(employeeIds, period));
}

/** Все объекты с часами > 0 за период, отсортированные compareObjectHours. */
export async function loadObjectHoursByEmployee(
  employeeIds: number[],
  period: IExportPeriod,
): Promise<Map<number, IMainObject[]>> {
  const result = new Map<number, IMainObject[]>();

  for (let index = 0; index < employeeIds.length; index += EMPLOYEE_CHUNK_SIZE) {
    const chunk = employeeIds.slice(index, index + EMPLOYEE_CHUNK_SIZE);
    const adjustments = await loadAttendanceAdjustments(chunk, period.start, period.end);
    const data = await buildObjectAttendanceData({
      employeeIds: chunk,
      startDate: period.start,
      endDate: period.end,
      todayStr: period.end,
      adjustments,
    });
    for (const [employeeId, list] of sumObjectHoursByEmployee(data.objectEntries)) {
      result.set(employeeId, list);
    }
    await yieldToEventLoop();
  }

  return result;
}
