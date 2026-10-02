/**
 * Объект табелирования сотрудника (миграция 288) — общие функции.
 *
 * Хранится в личном режиме 249: «Офис» = current_activity, объект = object + id.
 * Группа «Офис» — объекты с 1С-адресом «Текущая деятельность» (Полковая, Полковая 3,
 * Материальная группа, ИТ): адрес и есть то, что уходит в 1С, поэтому признак группы
 * и выгрузка разойтись не могут. Офисный объект нигде не хранится закреплённым —
 * canonicalizeMode переводит его в current_activity.
 */
import { query, type DbExecutor } from '../config/postgres.js';
import { getContractorRootId } from '../config/contractor.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import { loadAttendanceAdjustments } from './attendance.service.js';
import { buildObjectAttendanceData, type IAttendanceObjectEntry } from './timesheet-object.service.js';
import { sumObjectHoursByEmployee } from './employees-export-objects.service.js';
import {
  CURRENT_ACTIVITY_ADDRESS,
  DEFAULT_EXPORT_MODE,
  currentMonthStartMsk,
  resolveExportModes,
  type IResolvedExportMode,
  type TimesheetExportMode,
} from './timesheet-export-mode.service.js';

export const OFFICE_LABEL = 'Офис';
/** Ключ группы «Офис» в часах по объектам (вместо id объекта). */
export const OFFICE_VALUE = 'office';
/** Сотрудников на один проход расчёта часов (как в снимке основного объекта). */
const EMPLOYEE_CHUNK_SIZE = 1000;

export type TimesheetObjectSetBy = 'auto' | 'employee' | 'manager';

const collator = new Intl.Collator('ru');
const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

async function runQuery<T extends import('pg').QueryResultRow>(
  exec: DbExecutor | undefined, sql: string, params?: readonly unknown[],
): Promise<T[]> {
  if (exec) return (await exec.query<T>(sql, params as unknown[] | undefined)).rows;
  return query<T>(sql, params);
}

export function isOfficeAddress(altName: string | null | undefined): boolean {
  return (altName ?? '').trim().toLowerCase() === CURRENT_ACTIVITY_ADDRESS.toLowerCase();
}

export interface ISkudObjectInfo {
  id: string;
  name: string;
  alt_name: string | null;
  is_active: boolean;
}

/** Справочник объектов (их ~30): один запрос, без кэша — меняется из настроек СКУД. */
export async function loadSkudObjects(exec?: DbExecutor): Promise<Map<string, ISkudObjectInfo>> {
  const rows = await runQuery<ISkudObjectInfo>(
    exec,
    'SELECT id::text AS id, name, alt_name, is_active FROM skud_objects',
  );
  return new Map(rows.map(row => [row.id, row]));
}

/**
 * Офисный объект → current_activity. Любой путь записи режима проходит через неё:
 * в карточке «Офис», а в выгрузке по объектам сотрудник не должен попасть в файл
 * офисного объекта.
 */
export function canonicalizeMode(
  mode: TimesheetExportMode | null,
  objectId: string | null,
  objectsById: ReadonlyMap<string, ISkudObjectInfo>,
): { mode: TimesheetExportMode | null; objectId: string | null } {
  if (mode !== 'object') return { mode, objectId: null };
  const object = objectId ? objectsById.get(objectId) : undefined;
  if (object && isOfficeAddress(object.alt_name)) return { mode: 'current_activity', objectId: null };
  return { mode, objectId };
}

/** 'YYYY-MM-DD' → число дней в месяце. */
function daysInMonth(isoDate: string): number {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Первое число прошлого месяца по МСК. */
export function previousMonthStartMsk(now: Date = new Date()): string {
  const current = new Date(`${currentMonthStartMsk(now)}T00:00:00Z`);
  current.setUTCMonth(current.getUTCMonth() - 1);
  return current.toISOString().slice(0, 10);
}

/** Последний день месяца monthStart. */
export function monthEnd(monthStart: string): string {
  return `${monthStart.slice(0, 8)}${String(daysInMonth(monthStart)).padStart(2, '0')}`;
}

/**
 * Отделы подрядчиков: корень «Подрядные организации» и всё поддерево (функция БД
 * возвращает и сам корень). Корня нет — ошибка: молча включить подрядчиков нельзя.
 */
export async function loadContractorDepartmentIds(exec?: DbExecutor): Promise<string[]> {
  const rootId = await getContractorRootId();
  if (!rootId) throw new Error('Не найден корень «Подрядные организации» — расчёт объекта табелирования остановлен');
  const rows = await runQuery<{ id: string }>(
    exec,
    'SELECT id::text AS id FROM public.get_descendant_department_ids($1::uuid[])',
    [[rootId]],
  );
  return [...new Set([rootId, ...rows.map(row => row.id)])];
}

/** Часы сотрудника на объекте табелирования («Офис» — суммой офисов). */
export interface ITimesheetObjectHours {
  /** 'office' или id объекта. */
  value: string;
  label: string;
  /** null у «Офиса». */
  objectId: string | null;
  hours: number;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Порядок: часы по убыванию, при равенстве — по названию, затем по значению. */
export function compareTimesheetObjectHours(a: ITimesheetObjectHours, b: ITimesheetObjectHours): number {
  if (a.hours !== b.hours) return b.hours - a.hours;
  const byLabel = collator.compare(a.label, b.label);
  if (byLabel !== 0) return byLabel;
  if (a.value === b.value) return 0;
  return a.value < b.value ? -1 : 1;
}

/**
 * Объекты сотрудника → объекты табелирования: только активные (includeInactive — и
 * неактивные: для подписи, где человек работал), офисы суммируются в «Офис», в итоге —
 * только с часами > 0, по compareTimesheetObjectHours.
 */
export function groupObjectHours(
  list: ReadonlyArray<{ objectId: string; hours: number }>,
  objectsById: ReadonlyMap<string, ISkudObjectInfo>,
  options: { includeInactive?: boolean } = {},
): ITimesheetObjectHours[] {
  const groups = new Map<string, ITimesheetObjectHours>();
  for (const item of list) {
    const object = objectsById.get(item.objectId);
    if (!object || (!object.is_active && !options.includeInactive)) continue;
    const office = isOfficeAddress(object.alt_name);
    const value = office ? OFFICE_VALUE : object.id;
    const group = groups.get(value) ?? {
      value,
      label: office ? OFFICE_LABEL : object.name,
      objectId: office ? null : object.id,
      hours: 0,
    };
    group.hours += item.hours;
    groups.set(value, group);
  }
  return [...groups.values()]
    .map(group => ({ ...group, hours: round2(group.hours) }))
    .filter(group => group.hours > 0)
    .sort(compareTimesheetObjectHours);
}

/**
 * Часы сотрудников по объектам табелирования за период. Метрика — та же, что у
 * основного объекта (display_hours_worked: СКУД + объектные корректировки).
 * todayStr — сегодня по МСК: незакрытый вход прошлого дня часов не даёт, а
 * сегодняшний считается до текущего момента.
 */
export async function loadTimesheetObjectHours(
  employeeIds: number[],
  period: { start: string; end: string },
  options: { todayStr?: string; exec?: DbExecutor; objectsById?: ReadonlyMap<string, ISkudObjectInfo> } = {},
): Promise<Map<number, ITimesheetObjectHours[]>> {
  const result = new Map<number, ITimesheetObjectHours[]>();
  const ids = [...new Set(employeeIds.filter(id => Number.isInteger(id) && id > 0))];
  if (ids.length === 0 || period.start > period.end) return result;

  const objectsById = options.objectsById ?? await loadSkudObjects(options.exec);
  const todayStr = options.todayStr ?? moscowTodayIso();

  for (let index = 0; index < ids.length; index += EMPLOYEE_CHUNK_SIZE) {
    const chunk = ids.slice(index, index + EMPLOYEE_CHUNK_SIZE);
    const adjustments = await loadAttendanceAdjustments(chunk, period.start, period.end, options.exec);
    const data = await buildObjectAttendanceData({
      employeeIds: chunk,
      startDate: period.start,
      endDate: period.end,
      todayStr,
      adjustments,
      exec: options.exec,
    });
    for (const [employeeId, list] of sumObjectHoursByEmployee(data.objectEntries)) {
      const grouped = groupObjectHours(list, objectsById);
      if (grouped.length > 0) result.set(employeeId, grouped);
    }
    if (index + EMPLOYEE_CHUNK_SIZE < ids.length) await yieldToEventLoop();
  }
  return result;
}

/** Подпись режима: «Офис», имя объекта или null («По СКУД» / нет объекта). */
export function labelForResolved(
  resolved: IResolvedExportMode,
  objectsById: ReadonlyMap<string, ISkudObjectInfo>,
): string | null {
  if (resolved.mode === 'current_activity') return OFFICE_LABEL;
  if (resolved.mode === 'object' && resolved.pinnedObjectId) {
    const object = objectsById.get(resolved.pinnedObjectId);
    if (!object) return null;
    return isOfficeAddress(object.alt_name) ? OFFICE_LABEL : object.name;
  }
  return null;
}

/** skud от правила рабочих (timesheet-object-worker-rule.ts): пару skud/auto пишет только оно. */
export function isWorkerSkudMode(resolved: IResolvedExportMode): boolean {
  return resolved.mode === 'skud' && resolved.setBy === 'auto';
}

/**
 * Подпись рабочего: объекты с часами за период через запятую — по убыванию часов, офисы
 * одним «Офисом», неактивные объекты тоже (человек там работал). Часов нет — null.
 */
export function workerObjectsLabel(
  list: ReadonlyArray<{ objectId: string; hours: number }> | undefined,
  objectsById: ReadonlyMap<string, ISkudObjectInfo>,
): string | null {
  if (!list || list.length === 0) return null;
  const groups = groupObjectHours(list, objectsById, { includeInactive: true });
  return groups.length > 0 ? groups.map(group => group.label).join(', ') : null;
}

/**
 * Подписи объекта табелирования для списка сотрудников. month — месяц табеля: для
 * прошедшего месяца личный режим берётся из фиксации (миграция 288). objectEntries —
 * объектные часы показанного периода (табель): рабочему подпись — его объекты через
 * запятую. Без них у рабочего подписи нет (карточка, ЛК).
 */
export async function loadTimesheetObjectLabels(
  employeeIds: number[],
  month?: string | null,
  options: { objectEntries?: IAttendanceObjectEntry[] } = {},
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  const ids = [...new Set(employeeIds.filter(id => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return result;
  const [modes, objectsById] = await Promise.all([
    resolveExportModes(ids, undefined, month ? { month } : undefined),
    loadSkudObjects(),
  ]);
  const workedObjects = options.objectEntries ? sumObjectHoursByEmployee(options.objectEntries) : null;
  for (const id of ids) {
    const resolved = modes.get(id) ?? DEFAULT_EXPORT_MODE;
    const label = labelForResolved(resolved, objectsById)
      ?? (workedObjects && isWorkerSkudMode(resolved) ? workerObjectsLabel(workedObjects.get(id), objectsById) : null);
    if (label) result.set(id, label);
  }
  return result;
}

export interface ITimesheetObjectAutoState {
  enabled: boolean;
  baseline_month: string;
  frozen_month: string;
  objects_rebuilt_month: string;
  applied_date: string | null;
}

/** Состояние ночного расчёта; null — миграция 288 не применена или строки нет. */
export async function readTimesheetObjectState(
  exec?: DbExecutor,
  forUpdate = false,
): Promise<ITimesheetObjectAutoState | null> {
  const rows = await runQuery<ITimesheetObjectAutoState>(
    exec,
    `SELECT enabled,
            baseline_month::text        AS baseline_month,
            frozen_month::text          AS frozen_month,
            objects_rebuilt_month::text AS objects_rebuilt_month,
            applied_date::text          AS applied_date
       FROM timesheet_object_auto_state
      WHERE singleton${forUpdate ? '\n      FOR UPDATE' : ''}`,
  );
  return rows[0] ?? null;
}
