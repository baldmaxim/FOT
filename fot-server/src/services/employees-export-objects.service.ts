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
 * Сначала суммирует часы по (сотрудник, объект) — отрицательные правки входят
 * в сумму, — затем выбирает объект с максимальным итогом > 0. При равенстве —
 * по названию, затем по object_id, чтобы результат не зависел от порядка записей.
 */
export function pickMainObjectDetailed(entries: IObjectHoursEntry[]): Map<number, IMainObject> {
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

  const result = new Map<number, IMainObject>();
  for (const [employeeId, byObject] of totals) {
    let best: { id: string; name: string; hours: number } | null = null;
    for (const [objectId, total] of byObject) {
      // Округление до центичасов гасит хвосты сложения float (0.1 + 0.2).
      const hours = Math.round(total.hours * 100) / 100;
      if (hours <= 0) continue;
      const candidate = { id: objectId, name: total.name, hours };
      if (
        !best
        || candidate.hours > best.hours
        || (candidate.hours === best.hours && (
          collator.compare(candidate.name, best.name) < 0
          || (collator.compare(candidate.name, best.name) === 0 && candidate.id < best.id)
        ))
      ) {
        best = candidate;
      }
    }
    if (best) result.set(employeeId, { objectId: best.id, objectName: best.name, hours: best.hours });
  }
  return result;
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
  const result = new Map<number, IMainObject>();

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
    for (const [employeeId, main] of pickMainObjectDetailed(data.objectEntries)) {
      result.set(employeeId, main);
    }
    await yieldToEventLoop();
  }

  return result;
}
