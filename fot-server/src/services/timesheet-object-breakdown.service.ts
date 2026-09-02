// Объектная разбивка часов для официальной версии табеля.
//
// Отвечает на вопрос 1С «на каком объекте и сколько часов был сотрудник». Собирается
// в той же транзакции, что и сама версия, и замораживается вместе с ней: считать на
// лету нельзя — живой расчёт зависит от текущих СКУД-событий, ростера, режима
// табелирования и привязки точек к объектам, и для одной revision давал бы разные
// ответы.
//
// Модуль чистый: никаких обращений к БД, весь вход передаётся аргументами. Это
// позволяет тестировать раскладку без поднятия схемы.

import crypto from 'node:crypto';
import { canonicalJson } from '../utils/canonical-json.js';
import {
  UNKNOWN_OBJECT_KEY,
  UNKNOWN_OBJECT_NAME,
  type IAttendanceObjectEntry,
} from './timesheet-object.service.js';
import {
  CURRENT_ACTIVITY_ADDRESS,
  DEFAULT_EXPORT_MODE,
  type IResolvedExportMode,
  type TimesheetExportMode,
} from './timesheet-export-mode.service.js';

/** Псевдо-объект режима «текущая деятельность»: реального skud_objects.id у него нет. */
export const CURRENT_ACTIVITY_KEY = '__current_activity__';

/** Часы ниже этого порога считаем нулём — тот же 0.001, что и в 1С-выгрузках. */
const HOURS_EPSILON = 0.001;

export interface IVersionObjectRow {
  /** null у «Текущей деятельности» и у нераспознанного объекта — различать по object_name. */
  object_id: string | null;
  object_key: string;
  object_name: string;
  object_address: string;
  total_hours: number;
  /** Только дни с положительными часами. Ключ — YYYY-MM-DD. */
  days: Record<string, number>;
}

export interface IVersionObjectsEmployee {
  employee_id: number;
  full_name: string | null;
  mode: TimesheetExportMode;
  total_hours: number;
  objects: IVersionObjectRow[];
}

export interface IVersionObjectsPayload {
  employees: IVersionObjectsEmployee[];
}

export type ObjectConfigErrorCode = 'PINNED_OBJECT_MISSING' | 'PINNED_OBJECT_NOT_FOUND';

export interface IObjectConfigError {
  employee_id: number;
  code: ObjectConfigErrorCode;
  message: string;
}

export interface IObjectMeta {
  name: string;
  address: string;
}

/** Дни сотрудника из основного payload версии: они и есть целевые итоги. */
export interface IEmployeeDaysSource {
  employee_id: number;
  full_name: string | null;
  days: Record<string, { hours: number }>;
}

export interface IBuildObjectBreakdownInput {
  /** Состав и часы — ИЗ payload версии, а не из живых таблиц. */
  employees: readonly IEmployeeDaysSource[];
  objectEntries: readonly IAttendanceObjectEntry[];
  /** Тот же фильтр владения днём, что и у основного payload. */
  ownsDay: (employeeId: number, date: string) => boolean;
  modeByEmployee: ReadonlyMap<number, IResolvedExportMode>;
  objectMetaById: ReadonlyMap<string, IObjectMeta>;
}

export interface IBuildObjectBreakdownResult {
  payload: IVersionObjectsPayload;
  configErrors: IObjectConfigError[];
  employeesCount: number;
  totalHours: number;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

const hasHours = (value: number): boolean => value > HOURS_EPSILON;

/**
 * Раскладывает целевые часы дня по весам методом наибольшего остатка в центичасах.
 *
 * Считаем именно от целевого итога версии, а не от суммы объектных интервалов:
 * dataMap обнуляет часы несогласованного выходного (includeExportDayHours), а
 * objectEntries такого фильтра не проходят — наивная группировка дала бы объектные
 * часы там, где в табеле ноль.
 *
 * Чистая: вход не мутируется, в отличие от distributeNetHoursAcrossObjects
 * в attendance.service.ts, который правит записи на месте.
 */
export function distributeHoursByWeights(targetHours: number, weights: readonly number[]): number[] {
  const totalCentihours = Math.max(0, Math.round((targetHours || 0) * 100));
  const safeWeights = weights.map(weight => Math.max(0, weight || 0));
  const sumWeight = safeWeights.reduce((sum, weight) => sum + weight, 0);
  if (totalCentihours === 0 || sumWeight <= 0) return safeWeights.map(() => 0);

  const exact = safeWeights.map(weight => (weight / sumWeight) * totalCentihours);
  const centihours = exact.map(value => Math.floor(value));
  let distributed = centihours.reduce((sum, value) => sum + value, 0);

  // Остаток раздаём по убыванию дробной части; при равенстве — по возрастанию индекса,
  // иначе раскладка зависела бы от нестабильности сортировки и хэш «плавал» бы.
  const byFractionDesc = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => (right.fraction - left.fraction) || (left.index - right.index));

  for (let k = 0; distributed < totalCentihours; k += 1) {
    const target = byFractionDesc[k % byFractionDesc.length];
    if (!target) break;
    centihours[target.index] = (centihours[target.index] ?? 0) + 1;
    distributed += 1;
  }

  return centihours.map(value => value / 100);
}

interface IBucketSeed {
  object_id: string | null;
  object_key: string;
  object_name: string;
  object_address: string;
}

interface IBucket extends IBucketSeed {
  days: Map<string, number>;
}

const bucketOf = (
  buckets: Map<string, IBucket>,
  key: string,
  make: () => IBucketSeed,
): IBucket => {
  const existing = buckets.get(key);
  if (existing) return existing;
  const created: IBucket = { ...make(), days: new Map() };
  buckets.set(key, created);
  return created;
};

const addHours = (bucket: IBucket, date: string, hours: number): void => {
  bucket.days.set(date, round2((bucket.days.get(date) ?? 0) + hours));
};

const unknownBucketSeed = (): IBucketSeed => ({
  object_id: null,
  object_key: UNKNOWN_OBJECT_KEY,
  object_name: UNKNOWN_OBJECT_NAME,
  object_address: '',
});

const currentActivitySeed = (): IBucketSeed => ({
  object_id: null,
  object_key: CURRENT_ACTIVITY_KEY,
  object_name: CURRENT_ACTIVITY_ADDRESS,
  object_address: CURRENT_ACTIVITY_ADDRESS,
});

/** Индекс объектных записей: employee_id → дата → записи. */
function indexObjectEntries(
  entries: readonly IAttendanceObjectEntry[],
): Map<number, Map<string, IAttendanceObjectEntry[]>> {
  const index = new Map<number, Map<string, IAttendanceObjectEntry[]>>();
  for (const entry of entries) {
    let byDate = index.get(entry.employee_id);
    if (!byDate) {
      byDate = new Map();
      index.set(entry.employee_id, byDate);
    }
    const bucket = byDate.get(entry.work_date);
    if (bucket) bucket.push(entry);
    else byDate.set(entry.work_date, [entry]);
  }
  return index;
}

/**
 * Резолвит закреплённый объект режима 'object'.
 *
 * Excel-выгрузка на битой настройке падает громко, но ронять здесь нельзя: этот код
 * выполняется в транзакции закрытия табеля, и исключение остановило бы работу всем.
 * Поэтому часы уходят в «Не определён», а факт поломки едет в config_errors — по нему
 * публичный API отдаст 409 вместо молча неверных данных.
 */
function resolvePinnedSeed(
  employeeId: number,
  resolved: IResolvedExportMode,
  objectMetaById: ReadonlyMap<string, IObjectMeta>,
  configErrors: IObjectConfigError[],
): (() => IBucketSeed) | null {
  if (!resolved.pinnedObjectId) {
    configErrors.push({
      employee_id: employeeId,
      code: 'PINNED_OBJECT_MISSING',
      message: 'Режим «объект» без закреплённого объекта',
    });
    return null;
  }
  const meta = objectMetaById.get(resolved.pinnedObjectId);
  if (!meta) {
    configErrors.push({
      employee_id: employeeId,
      code: 'PINNED_OBJECT_NOT_FOUND',
      message: `Закреплённый объект ${resolved.pinnedObjectId} не найден`,
    });
    return null;
  }
  const pinnedId = resolved.pinnedObjectId;
  return () => ({
    object_id: pinnedId,
    object_key: pinnedId,
    object_name: meta.name,
    object_address: meta.address,
  });
}

export function buildVersionObjectBreakdown(
  input: IBuildObjectBreakdownInput,
): IBuildObjectBreakdownResult {
  const entriesByEmployee = indexObjectEntries(input.objectEntries);
  const configErrors: IObjectConfigError[] = [];
  const employees: IVersionObjectsEmployee[] = [];

  for (const source of input.employees) {
    const employeeId = source.employee_id;
    const resolved = input.modeByEmployee.get(employeeId) ?? DEFAULT_EXPORT_MODE;

    // Целевые часы — из payload версии. Дни с нулём (буквенные статусы, несогласованный
    // выходной) объектных строк не порождают: они уже описаны в days самого табеля,
    // и дублировать их разбивкой значит открыть дорогу двойному учёту.
    const targets = Object.entries(source.days)
      .map(([date, value]) => [date, value?.hours ?? 0] as const)
      .filter(([, hours]) => hasHours(hours))
      .sort((left, right) => left[0].localeCompare(right[0]));

    const buckets = new Map<string, IBucket>();
    const pinnedSeed = resolved.mode === 'object'
      ? resolvePinnedSeed(employeeId, resolved, input.objectMetaById, configErrors)
      : null;

    for (const [date, targetHours] of targets) {
      if (!input.ownsDay(employeeId, date)) continue;

      if (resolved.mode === 'current_activity') {
        addHours(bucketOf(buckets, CURRENT_ACTIVITY_KEY, currentActivitySeed), date, targetHours);
        continue;
      }

      if (resolved.mode === 'object') {
        const seed = pinnedSeed ?? unknownBucketSeed;
        addHours(bucketOf(buckets, seed().object_key, seed), date, targetHours);
        continue;
      }

      // skud: веса — фактические объектные интервалы этого дня.
      const dayEntries = entriesByEmployee.get(employeeId)?.get(date) ?? [];
      const weightByKey = new Map<string, { weight: number; entry: IAttendanceObjectEntry }>();
      for (const entry of dayEntries) {
        const weight = Math.max(0, entry.hours_worked || 0);
        const current = weightByKey.get(entry.object_key);
        if (current) current.weight += weight;
        else weightByKey.set(entry.object_key, { weight, entry });
      }

      const keys = [...weightByKey.keys()].sort();
      const shares = distributeHoursByWeights(
        targetHours,
        keys.map(key => weightByKey.get(key)!.weight),
      );
      const distributed = shares.reduce((sum, value) => sum + value, 0);

      if (!hasHours(distributed)) {
        // Проходов нет (или все нулевые), а часы в табеле есть — целиком в «Не определён».
        // Молча терять их нельзя: сумма по объектам обязана сходиться с днём табеля.
        addHours(bucketOf(buckets, UNKNOWN_OBJECT_KEY, unknownBucketSeed), date, targetHours);
        continue;
      }

      keys.forEach((key, position) => {
        const hours = shares[position] ?? 0;
        if (!hasHours(hours)) return;
        const entry = weightByKey.get(key)!.entry;
        const bucket = bucketOf(buckets, key, () => ({
          object_id: entry.object_id,
          object_key: entry.object_key,
          object_name: entry.object_name,
          object_address: entry.object_id
            ? (input.objectMetaById.get(entry.object_id)?.address ?? entry.object_name)
            : '',
        }));
        addHours(bucket, date, hours);
      });
    }

    // Сортировка по (имя, ключ): имена объектов не уникальны, и без второго критерия
    // хэш зависел бы от порядка входных записей.
    const objects: IVersionObjectRow[] = [...buckets.values()]
      .map(bucket => {
        const days: Record<string, number> = {};
        let total = 0;
        for (const date of [...bucket.days.keys()].sort()) {
          const hours = bucket.days.get(date)!;
          if (!hasHours(hours)) continue;
          days[date] = hours;
          total += hours;
        }
        return {
          object_id: bucket.object_id,
          object_key: bucket.object_key,
          object_name: bucket.object_name,
          object_address: bucket.object_address,
          total_hours: round2(total),
          days,
        };
      })
      .filter(row => Object.keys(row.days).length > 0)
      .sort((left, right) => (
        left.object_name.localeCompare(right.object_name, 'ru')
        || left.object_key.localeCompare(right.object_key)
      ));

    employees.push({
      employee_id: employeeId,
      full_name: source.full_name,
      mode: resolved.mode,
      total_hours: round2(objects.reduce((sum, row) => sum + row.total_hours, 0)),
      objects,
    });
  }

  employees.sort((left, right) => left.employee_id - right.employee_id);
  configErrors.sort((left, right) => (
    left.employee_id - right.employee_id || left.code.localeCompare(right.code)
  ));

  return {
    payload: { employees },
    configErrors,
    employeesCount: employees.length,
    totalHours: round2(employees.reduce((sum, employee) => sum + employee.total_hours, 0)),
  };
}

/**
 * md5 пары { payload, config_errors } — намеренно НЕ одного payload.
 *
 * Сценарий: режим «объект» без закреплённого объекта починили на «skud», но проходов у
 * человека нет. payload остаётся прежним («Не определён»), а config_errors опустевает.
 * Хэш только по payload этого не заметил бы, новой редакции не появилось бы, и версия
 * навсегда осталась бы с ответом 409 INVALID_EXPORT_MODE_CONFIG.
 */
export function computeObjectsContentHash(
  payload: IVersionObjectsPayload,
  configErrors: readonly IObjectConfigError[],
): string {
  return crypto
    .createHash('md5')
    .update(canonicalJson({ payload, config_errors: configErrors }))
    .digest('hex');
}
