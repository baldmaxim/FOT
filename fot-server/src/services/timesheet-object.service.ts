import { query, type DbExecutor } from '../config/postgres.js';
import { runMaybeParallel } from '../utils/db-parallel.js';
import type { TimeStatus } from '../types/index.js';
import { getInternalAccessPoints, PRESENCE_FAILURE_TYPE_IDS } from './skud-shared.service.js';
import {
  listObjectIdsForEmployees,
  listSelectableObjectsForEmployee,
  type ISelectableObject,
} from './employee-skud-object-access.service.js';
import {
  getAttributionObjectForEmployeeAt,
  listAttributionRowsForEmployees,
  resolveAttributionAt,
  type IAttributionRow,
} from './employee-object-attribution.service.js';
import { resolveSchedule, resolveSchedulesBulk, resolveSchedulesForPeriod, isNightShiftDay } from './schedule.service.js';
import { formatDateToISO } from '../utils/date.utils.js';
import {
  getAdjustmentPriority,
  NON_WORK_ADJUSTMENT_STATUSES,
  roundHours,
} from './time-calculation/primitives.js';

/** SELECT через клиент транзакции, если он передан, иначе через пул (см. DbExecutor). */
async function objectRows<T extends import('pg').QueryResultRow = import('pg').QueryResultRow>(
  exec: DbExecutor | undefined, sql: string, params?: readonly unknown[],
): Promise<T[]> {
  if (exec) return (await exec.query<T>(sql, params as unknown[] | undefined)).rows;
  return query<T>(sql, params);
}

const BATCH_SIZE = 500;

export const OBJECT_ADJUSTMENT_SOURCE_TYPE = 'manual_object';

/**
 * Распределение часов дневной корректировки по объектам. Живёт в metadata той же
 * строки attendance_adjustments (source_type='manual'): id, автор, вложения и
 * согласование при смене объектов не трогаются — в отличие от конверсии в
 * manual_object, которая пересоздавала запись и уносила файлы.
 */
export const OBJECT_ALLOCATIONS_KEY = 'object_allocations';
export const ALLOCATION_SOURCE_KEY = 'allocation_source';
/** Больше десяти объектов за день — заведомо ошибка ввода, а не реальный маршрут. */
export const MAX_OBJECT_ALLOCATIONS = 10;

export interface IObjectAllocation {
  object_id: string;
  object_name: string;
  /** Часы с точностью до сотых — тот же домен, что hours_override. */
  hours: number;
}

const roundHours2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Читает аллокации из metadata. Любой мусор (не массив, битые элементы, hours <= 0)
 * трактуется как «аллокаций нет»: выгрузки и табель не должны падать 500 из-за
 * руками поправленной строки.
 */
export const readObjectAllocations = (
  metadata: Record<string, unknown> | null | undefined,
): IObjectAllocation[] => {
  const raw = metadata?.[OBJECT_ALLOCATIONS_KEY];
  if (!Array.isArray(raw)) return [];

  const out: IObjectAllocation[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const objectId = typeof row.object_id === 'string' ? row.object_id.trim() : '';
    const hours = Number(row.hours);
    if (!objectId || !Number.isFinite(hours) || hours <= 0) continue;
    out.push({
      object_id: objectId,
      object_name: typeof row.object_name === 'string' ? row.object_name : '',
      hours: roundHours2(hours),
    });
  }
  return out;
};

/**
 * Канонический вид: сортировка по object_id и округление часов. Нужен, чтобы
 * перестановка строк в форме не считалась изменением и не плодила аудит.
 */
export const canonicalizeAllocations = (list: IObjectAllocation[]): IObjectAllocation[] =>
  [...list]
    .map(item => ({ ...item, hours: roundHours2(item.hours) }))
    .sort((left, right) => left.object_id.localeCompare(right.object_id));

/** Сравнение по бизнес-смыслу (объект + часы), имя объекта не участвует. */
export const allocationsEqual = (left: IObjectAllocation[], right: IObjectAllocation[]): boolean => {
  const a = canonicalizeAllocations(left);
  const b = canonicalizeAllocations(right);
  if (a.length !== b.length) return false;
  return a.every((item, index) =>
    item.object_id === b[index].object_id
    && Math.round(item.hours * 100) === Math.round(b[index].hours * 100));
};

/** Есть ли у дневной корректировки явное распределение по объектам. */
export const hasObjectAllocations = (
  metadata: Record<string, unknown> | null | undefined,
): boolean => readObjectAllocations(metadata).length > 0;

export const UNKNOWN_OBJECT_KEY = '__unknown_object__';
export const UNKNOWN_OBJECT_NAME = 'Не определён';

// Корректировка, мигрированная из day-level скриптом migrate-day-level-to-object-corrections.mjs:
// формально source_type='manual_object', но семантически это АВТОРИТЕТНЫЙ ИТОГ ДНЯ (исходно
// 'manual'/'leave_request'). Её надо обрабатывать как day-level — чистить СКУД дня, а не
// перекрывать лишь свой объект. Иначе СКУД на ДРУГИХ объектах того же дня складывается сверху
// и день задваивается (напр. К14 10ч корр. + К13 8ч35 СКУД = 18ч34 вместо 10ч).
export const isMigratedDayLevelAdjustment = (adjustment: {
  source_type: string;
  metadata?: Record<string, unknown> | null;
}): boolean =>
  adjustment.source_type === OBJECT_ADJUSTMENT_SOURCE_TYPE
  && adjustment.metadata?.migrated_from_day_level === true;

export interface IObjectAdjustmentSource {
  id: number;
  employee_id: number;
  work_date: string;
  hours_override: number | null;
  source_type: string;
  source_id: string;
  status: string;
  reason: string | null;
  updated_at: string;
  metadata: Record<string, unknown>;
  approval_status?: 'auto_approved' | 'pending' | 'approved' | 'rejected' | null;
}

export interface IAttendanceObjectEntry {
  adjustment_id: number | null;
  employee_id: number;
  work_date: string;
  object_key: string;
  object_id: string | null;
  object_name: string;
  hours_worked: number;
  display_hours_worked: number;
  base_hours_worked: number;
  is_correction: boolean;
  approval_status?: 'auto_approved' | 'pending' | 'approved' | 'rejected' | null;
  notes?: string | null;
  // true — это «эхо» day-level корректировки (manual/leave_request), размазанной на объект,
  // а не самостоятельная объектная корректировка (source_type='manual_object'). Модалка дня
  // прячет такие записи (day-level показывается отдельным блоком), чтобы не дублировать (#8).
  from_day_level?: boolean;
  // Автор и время объектной корректировки (#9) — заполняет attendance.service по adjustment_id.
  corrected_by_name?: string | null;
  corrected_at?: string | null;
}

export interface IRawFallbackSummary {
  employee_id: number;
  date: string;
  first_entry: string | null;
  last_exit: string | null;
  total_hours: number | null;
  total_minutes?: number | null;
  break_minutes?: number | null;
}

interface IRawEventRow {
  employee_id: number | null;
  event_date: string;
  event_time: string;
  access_point: string | null;
  direction: 'entry' | 'exit' | null;
}

interface ITravelObjectMappingRow {
  object_id: string;
  access_point_name: string;
}

interface ITravelObjectRow {
  id: string;
  name: string;
}

interface IAggregatedObjectEntry {
  adjustment_id: number | null;
  employee_id: number;
  work_date: string;
  object_key: string;
  object_id: string | null;
  object_name: string;
  base_minutes: number;
  effective_minutes: number;
  is_correction: boolean;
  notes?: string | null;
  from_day_level?: boolean;
}

const normalizeAccessPoint = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized || null;
};

const timeToSeconds = (value: string): number => {
  const [hours, minutes, seconds = 0] = value.split(':').map(Number);
  return hours * 3600 + minutes * 60 + seconds;
};

const formatTimeValue = (date: Date): string => (
  `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
);

const NIGHT_WINDOW_SECONDS = 32 * 3600;

// Метка времени события как epoch-секунды (дата 'YYYY-MM-DD' + время суток). Нужна для
// парности через полночь: сравнение по времени суток ломается на ночных сменах.
const dateStrToEpochDay = (value: string): number => {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
};
const eventEpochSeconds = (event: IRawEventRow): number =>
  dateStrToEpochDay(String(event.event_date)) * 86_400 + timeToSeconds(event.event_time);
const nowEpochSeconds = (dateStr: string): number =>
  dateStrToEpochDay(dateStr) * 86_400 + timeToSeconds(formatTimeValue(new Date()));

const dayKey = (employeeId: number, workDate: string): string => `${employeeId}_${workDate}`;
const objectEntryKey = (employeeId: number, workDate: string, objectKey: string): string => `${employeeId}_${workDate}_${objectKey}`;

const getNormalizedInternalPoints = async (): Promise<Set<string>> => {
  const internalPoints = await getInternalAccessPoints();
  return new Set([...internalPoints].map(point => point.trim()).filter(Boolean));
};

const isMissingTableError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: string; message?: string | null; details?: string | null };
  return candidate.code === '42P01'
    || candidate.code === 'PGRST205'
    || candidate.message?.includes('does not exist') === true
    || candidate.details?.includes('does not exist') === true;
};

// Внешний поток событий сотрудника в хронологическом порядке (по epoch, не по времени суток —
// иначе ночные смены сортируются неверно). Внутренние точки исключаются из парного расчёта.
const getExternalStreamChrono = (events: IRawEventRow[], internalPoints: Set<string>): IRawEventRow[] => {
  const external = events.filter(event => {
    const point = normalizeAccessPoint(event.access_point);
    return !point || !internalPoints.has(point);
  });
  return external.sort((left, right) => eventEpochSeconds(left) - eventEpochSeconds(right));
};

// Дни-начала смены = календарные даты с ≥1 внешним входом, попадающие в [startDate, endDate].
// Утренний выход ночной смены (день без входа) началом не считается — он потребляется
// окном предыдущего дня (см. sliceShiftWindow).
const collectShiftStartDays = (stream: IRawEventRow[], startDate: string, endDate: string): string[] => {
  const days = new Set<string>();
  for (const event of stream) {
    if (event.direction !== 'entry') continue;
    const day = String(event.event_date).slice(0, 10);
    if (day >= startDate && day <= endDate) days.add(day);
  }
  return [...days].sort();
};

// Окно смены [первый вход дня; начало следующей смены | +32ч). Калька
// recalculate_skud_daily_summary (миграция 161/163): возвращает внешние события окна,
// которые могут пересекать полночь. isNight — ночной гейт (миграция 168): у дневной смены
// окно обрезается концом суток startDay, чтобы фантомный вечерний вход не закрывался
// выходом следующего утра (см. кейс Улмасов 1836, 15.05.2026).
const sliceShiftWindow = (stream: IRawEventRow[], startDay: string, isNight: boolean): IRawEventRow[] => {
  const firstEntry = stream.find(
    event => event.direction === 'entry' && String(event.event_date).slice(0, 10) === startDay,
  );
  if (!firstEntry) return [];
  const startTs = eventEpochSeconds(firstEntry);
  let windowEndTs = startTs + NIGHT_WINDOW_SECONDS;
  // Поток отсортирован по ts → первый вход на более поздней дате и есть начало следующей смены.
  for (const event of stream) {
    if (event.direction !== 'entry') continue;
    if (String(event.event_date).slice(0, 10) <= startDay) continue;
    const ts = eventEpochSeconds(event);
    if (ts > startTs) {
      windowEndTs = Math.min(windowEndTs, ts);
      break;
    }
  }
  // Дневная смена: окно не пересекает полночь — обрезаем по 00:00 следующего дня (строго <).
  if (!isNight) {
    const endOfDayTs = (dateStrToEpochDay(startDay) + 1) * 86_400;
    windowEndTs = Math.min(windowEndTs, endOfDayTs);
  }
  return stream.filter(event => {
    const ts = eventEpochSeconds(event);
    return ts >= startTs && ts < windowEndTs;
  });
};

// windowEvents — внешние события окна смены (sliceShiftWindow), отсортированы по epoch,
// могут пересекать полночь. workDate — день начала смены.
const buildRawFallbackSummary = (
  windowEvents: IRawEventRow[],
  workDate: string,
  todayStr: string,
): IRawFallbackSummary | null => {
  if (windowEvents.length === 0) return null;

  let totalSeconds = 0;
  // Перерыв = сумма гэпов МЕЖДУ закрытыми парами. Начисляется при ЗАКРЫТИИ следующей пары
  // (паритет с SQL-агрегатом, миграция 168, строки 197-204), а не при открытии входа —
  // иначе висячий незакрытый orphan-вход ложно добавил бы перерыв.
  let breakSeconds = 0;
  let prevPairExitEpoch: number | null = null;
  let openEntryEpoch: number | null = null;
  let openEntryPoint: string | null = null;

  for (const event of windowEvents) {
    if (event.direction === 'entry') {
      // Открытый вход затирается только при совпадении точки (повторный пробив того же
      // турникета); вход по другой точке открытый вход НЕ сбрасывает.
      // Строгая политика «только полные циклы», паритет с recalculate_skud_daily_summary (миграция 163).
      const point = normalizeAccessPoint(event.access_point);
      if (openEntryEpoch === null || point === openEntryPoint) {
        openEntryEpoch = eventEpochSeconds(event);
        openEntryPoint = point;
      }
      continue;
    }

    if (event.direction === 'exit' && openEntryEpoch !== null) {
      totalSeconds += Math.max(0, eventEpochSeconds(event) - openEntryEpoch);
      if (prevPairExitEpoch !== null) {
        breakSeconds += Math.max(0, openEntryEpoch - prevPairExitEpoch);
      }
      prevPairExitEpoch = eventEpochSeconds(event);
      openEntryEpoch = null;
      openEntryPoint = null;
    }
  }

  if (openEntryEpoch !== null && workDate === todayStr) {
    const now = nowEpochSeconds(todayStr);
    if (now > openEntryEpoch) {
      totalSeconds += now - openEntryEpoch;
      // Открытый интервал трактуется как закрытая пара → учитываем гэп перед ним.
      if (prevPairExitEpoch !== null) {
        breakSeconds += Math.max(0, openEntryEpoch - prevPairExitEpoch);
      }
    }
  }

  const firstEntry = windowEvents.find(event => event.direction === 'entry')?.event_time ?? null;
  const exitEvents = windowEvents.filter(event => event.direction === 'exit');
  const lastExit = exitEvents.length > 0 ? exitEvents[exitEvents.length - 1].event_time : null;
  const totalMinutes = Math.round(totalSeconds / 60);

  if (!firstEntry && !lastExit && totalMinutes === 0) {
    return null;
  }

  return {
    employee_id: Number(windowEvents[0].employee_id || 0),
    date: workDate,
    first_entry: firstEntry,
    last_exit: lastExit,
    total_hours: roundHours(totalMinutes / 60),
    total_minutes: totalMinutes,
    break_minutes: Math.round(breakSeconds / 60),
  };
};

// events — внешние события окна смены (sliceShiftWindow), отсортированы по epoch,
// могут пересекать полночь. workDate — день начала смены.
const buildObjectIntervals = ({
  events,
  accessPointToObjectId,
  objectNameById,
  workDate,
  todayStr,
}: {
  events: IRawEventRow[];
  accessPointToObjectId: Map<string, string>;
  objectNameById: Map<string, string>;
  workDate: string;
  todayStr: string;
}): Array<{
  object_key: string;
  object_id: string | null;
  object_name: string;
  minutes: number;
}> => {
  if (events.length === 0) return [];

  const intervals: Array<{
    object_key: string;
    object_id: string | null;
    object_name: string;
    minutes: number;
  }> = [];
  let openEntry: IRawEventRow | null = null;

  const pushInterval = (entryEvent: IRawEventRow, exitEvent: IRawEventRow | null, exitEpoch: number): void => {
    const startSeconds = eventEpochSeconds(entryEvent);
    const endSeconds = exitEpoch;
    if (endSeconds <= startSeconds) return;

    const entryPoint = normalizeAccessPoint(entryEvent.access_point);
    const exitPoint = normalizeAccessPoint(exitEvent?.access_point);
    const entryObjectId = entryPoint ? accessPointToObjectId.get(entryPoint) || null : null;
    const exitObjectId = exitPoint ? accessPointToObjectId.get(exitPoint) || null : null;
    const objectId = entryObjectId || exitObjectId || null;
    const objectKey = objectId || UNKNOWN_OBJECT_KEY;
    const objectName = objectId
      ? objectNameById.get(objectId) || UNKNOWN_OBJECT_NAME
      : UNKNOWN_OBJECT_NAME;

    intervals.push({
      object_key: objectKey,
      object_id: objectId,
      object_name: objectName,
      minutes: Math.round((endSeconds - startSeconds) / 60),
    });
  };

  for (const event of events) {
    if (event.direction === 'entry') {
      // Открытый вход затирается только при совпадении точки (повторный пробив того же
      // турникета); вход по другой точке открытый вход НЕ сбрасывает. Гэп вход→вход НЕ
      // считается отработанным. Паритет с buildRawFallbackSummary и
      // recalculate_skud_daily_summary (миграция 163).
      if (openEntry === null
          || normalizeAccessPoint(event.access_point) === normalizeAccessPoint(openEntry.access_point)) {
        openEntry = event;
      }
      continue;
    }

    if (event.direction === 'exit' && openEntry) {
      pushInterval(openEntry, event, eventEpochSeconds(event));
      openEntry = null;
    }
  }

  if (openEntry) {
    if (workDate === todayStr) {
      pushInterval(openEntry, null, nowEpochSeconds(todayStr));
    } else {
      // Прошлый день с entry без exit — фактических часов посчитать нельзя, но запись с
      // привязкой к объекту нужна: иначе сотрудник пропадает из режима «по объектам» и
      // руководитель не может проставить корректировку (см. кейс Тихонович, 02.05.2026).
      // Длительность 0 — фронт покажет строку с 0ч, клик откроет модалку корректировки.
      const entryPoint = normalizeAccessPoint(openEntry.access_point);
      const entryObjectId = entryPoint ? accessPointToObjectId.get(entryPoint) || null : null;
      const objectKey = entryObjectId || UNKNOWN_OBJECT_KEY;
      const objectName = entryObjectId
        ? objectNameById.get(entryObjectId) || UNKNOWN_OBJECT_NAME
        : UNKNOWN_OBJECT_NAME;
      intervals.push({
        object_key: objectKey,
        object_id: entryObjectId,
        object_name: objectName,
        minutes: 0,
      });
    }
  }

  return intervals;
};

const fetchRawEvents = async ({
  employeeIds,
  startDate,
  endDate,
  exec,
}: {
  employeeIds: number[];
  startDate: string;
  endDate: string;
  exec?: DbExecutor;
}): Promise<IRawEventRow[]> => {
  if (employeeIds.length === 0) return [];

  const rows: IRawEventRow[] = [];
  for (let index = 0; index < employeeIds.length; index += BATCH_SIZE) {
    const batch = employeeIds.slice(index, index + BATCH_SIZE);
    const data = await objectRows<IRawEventRow>(
      exec,
      `SELECT employee_id, event_date, event_time, access_point, direction
         FROM skud_events
        WHERE employee_id = ANY($1::int[])
          AND event_date >= $2
          AND event_date <= $3
        ORDER BY employee_id ASC, event_date ASC, event_time ASC`,
      [batch, startDate, endDate],
    );
    rows.push(...data);
  }

  return rows;
};

interface IHistoricalPrimaryRow {
  employee_id: number;
  object_id: string;
  object_name: string;
}

const fetchHistoricalPrimaryObjects = async (
  employeeIds: number[],
  windowStartDate: string,
  windowEndDate: string,
  exec?: DbExecutor,
): Promise<Map<number, { object_id: string; object_name: string }>> => {
  const out = new Map<number, { object_id: string; object_name: string }>();
  if (employeeIds.length === 0) return out;

  for (let index = 0; index < employeeIds.length; index += BATCH_SIZE) {
    const batch = employeeIds.slice(index, index + BATCH_SIZE);
    let rows: IHistoricalPrimaryRow[] = [];
    try {
      rows = await objectRows<IHistoricalPrimaryRow>(
        exec,
        `SELECT employee_id, object_id, object_name
           FROM (
             SELECT se.employee_id,
                    sap.object_id::text AS object_id,
                    so.name             AS object_name,
                    COUNT(*)::int       AS event_count,
                    ROW_NUMBER() OVER (
                      PARTITION BY se.employee_id
                      ORDER BY COUNT(*) DESC, so.name ASC
                    ) AS rn
               FROM skud_events se
               JOIN skud_object_access_points sap
                 ON BTRIM(sap.access_point_name) = BTRIM(se.access_point)
               JOIN skud_objects so
                 ON so.id = sap.object_id AND so.is_active = TRUE
              WHERE se.employee_id = ANY($1::int[])
                AND se.event_date >= $2::date
                AND se.event_date <= $3::date
                AND se.access_point IS NOT NULL
              GROUP BY se.employee_id, sap.object_id, so.name
           ) ranked
          WHERE rn = 1`,
        [batch, windowStartDate, windowEndDate],
      );
    } catch (err) {
      if (isMissingTableError(err)) return out;
      throw err;
    }
    for (const row of rows) {
      out.set(Number(row.employee_id), { object_id: row.object_id, object_name: row.object_name });
    }
  }
  return out;
};

// Whitelist типов отказов живёт в skud-shared, чтобы список объектов для выбора
// (employee-skud-object-access) и резолвер брали ровно один набор типов.
export { PRESENCE_FAILURE_TYPE_IDS };

export type ObjectResolutionSource =
  | 'skud_day'
  | 'failure_day'
  | 'remote_attribution'
  | 'history_90d';

/**
 * Результат подбора объекта дня.
 * 'ambiguous' — ТЕРМИНАЛЬНЫЙ исход: по отказам доступа лидируют несколько объектов
 * с одинаковым числом событий. Выбирать по алфавиту нельзя — это была бы та же
 * тихая догадка, из-за которой день уезжал на «Дом 56». Решает человек, поэтому
 * в history_90d не проваливаемся.
 */
export type ObjectResolution =
  | { kind: 'resolved'; object_id: string; object_name: string; source: ObjectResolutionSource }
  | { kind: 'ambiguous'; candidates: ISelectableObject[] }
  | { kind: 'none' };

interface IObjectVoteRow {
  object_id: string;
  object_name: string;
  event_count: number;
}

/**
 * Объект дня по ОТКАЗАМ доступа (skud_event_failures): человек приложил карту на
 * объекте — значит он там был, независимо от того, открылся турникет или нет.
 * Часов такое событие не даёт НИКОГДА, только объект.
 */
export async function resolveObjectFromFailuresAt(
  employeeId: number,
  workDate: string,
): Promise<ObjectResolution> {
  try {
    const rows = await query<IObjectVoteRow>(
      `SELECT sap.object_id::text AS object_id,
              so.name             AS object_name,
              COUNT(*)::int       AS event_count
         FROM skud_event_failures f
         JOIN skud_object_access_points sap
           ON BTRIM(sap.access_point_name) = BTRIM(f.access_point)
         JOIN skud_objects so
           ON so.id = sap.object_id AND so.is_active = TRUE
        WHERE f.employee_id = $1
          AND f.event_date = $2::date
          AND f.access_point IS NOT NULL
          AND f.failure_type_id = ANY($3::int[])
        GROUP BY sap.object_id, so.name
        ORDER BY event_count DESC, so.name ASC`,
      [employeeId, workDate, [...PRESENCE_FAILURE_TYPE_IDS]],
    );
    if (rows.length === 0) return { kind: 'none' };

    const topCount = Number(rows[0].event_count);
    const leaders = rows.filter(row => Number(row.event_count) === topCount);
    if (leaders.length > 1) {
      return {
        kind: 'ambiguous',
        candidates: leaders.map(row => ({
          object_id: row.object_id,
          object_name: row.object_name,
        })),
      };
    }

    return {
      kind: 'resolved',
      object_id: rows[0].object_id,
      object_name: rows[0].object_name,
      source: 'failure_day',
    };
  } catch (err) {
    if (!isMissingTableError(err)) throw err;
    return { kind: 'none' };
  }
}

/**
 * Подбор объекта для дневной корректировки с указанием ИСТОЧНИКА.
 * Порядок (первый сработавший выигрывает):
 *   1. успешные проходы дня             → skud_day            (факт)
 *   2. отказы доступа дня               → failure_day (факт) | ambiguous
 *   3. датированная привязка удалёнщика → remote_attribution
 *   4. максимум событий за 90 дней      → history_90d          (догадка)
 *
 * Успешный проход приоритетнее отказа: реальный вход надёжнее неудачной попытки.
 * Шаг 4 остаётся последним и намеренно самым слабым — он считает КОЛИЧЕСТВО, а не
 * свежесть, поэтому объект месячной давности может перевесить вчерашний.
 */
export async function resolveDayObjectDetailed(params: {
  employeeId: number;
  workDate: string;
  /** Если известен — избегаем лишнего resolveSchedule; иначе резолвим внутри. */
  scheduleType?: string;
}): Promise<ObjectResolution> {
  const { employeeId, workDate } = params;

  // 1) Объект с максимумом СКУД-событий за этот день.
  try {
    const sameDay = await query<{ object_id: string; object_name: string }>(
      `SELECT sap.object_id::text AS object_id,
              so.name             AS object_name,
              COUNT(*)::int       AS event_count
         FROM skud_events se
         JOIN skud_object_access_points sap
           ON BTRIM(sap.access_point_name) = BTRIM(se.access_point)
         JOIN skud_objects so
           ON so.id = sap.object_id AND so.is_active = TRUE
        WHERE se.employee_id = $1
          AND se.event_date = $2::date
          AND se.access_point IS NOT NULL
        GROUP BY sap.object_id, so.name
        ORDER BY event_count DESC, so.name ASC
        LIMIT 1`,
      [employeeId, workDate],
    );
    if (sameDay.length > 0) {
      return {
        kind: 'resolved',
        object_id: sameDay[0].object_id,
        object_name: sameDay[0].object_name,
        source: 'skud_day',
      };
    }
  } catch (err) {
    if (!isMissingTableError(err)) throw err;
    return { kind: 'none' };
  }

  // 2) Отказы доступа этого дня — факт присутствия на объекте: карта приложена,
  // турникет не пустил. Стоит ВЫШЕ привязки и 90-дневной истории, но НИЖЕ
  // реального прохода. Ничья по объектам терминальна (ambiguous), см. тип.
  const byFailures = await resolveObjectFromFailuresAt(employeeId, workDate);
  if (byFailures.kind !== 'none') return byFailures;

  // 3) Удалёнщик без СКУД в этот день: явная датированная привязка к объекту.
  // Стоит ВЫШЕ 90-дневной истории (человеческое решение приоритетнее устаревших
  // проходов), но НИЖЕ реального СКУД дня — поэтому реальный объект не маскируется.
  let isRemote = params.scheduleType === 'remote';
  if (params.scheduleType === undefined) {
    try {
      const sched = await resolveSchedule(employeeId, null, workDate);
      isRemote = sched.schedule_type === 'remote';
    } catch {
      isRemote = false;
    }
  }
  if (isRemote) {
    const pinned = await getAttributionObjectForEmployeeAt(employeeId, workDate);
    if (pinned) {
      return {
        kind: 'resolved',
        object_id: pinned.object_id,
        object_name: pinned.object_name,
        source: 'remote_attribution',
      };
    }
  }

  // 4) Объект с максимумом СКУД-событий за 90 дней до даты. Самый слабый источник:
  // считает количество, а не свежесть, поэтому стоит последним.
  try {
    const history = await query<{ object_id: string; object_name: string }>(
      `SELECT sap.object_id::text AS object_id,
              so.name             AS object_name,
              COUNT(*)::int       AS event_count
         FROM skud_events se
         JOIN skud_object_access_points sap
           ON BTRIM(sap.access_point_name) = BTRIM(se.access_point)
         JOIN skud_objects so
           ON so.id = sap.object_id AND so.is_active = TRUE
        WHERE se.employee_id = $1
          AND se.event_date BETWEEN ($2::date - INTERVAL '90 days')::date
                                AND ($2::date - INTERVAL '1 day')::date
          AND se.access_point IS NOT NULL
        GROUP BY sap.object_id, so.name
        ORDER BY event_count DESC, so.name ASC
        LIMIT 1`,
      [employeeId, workDate],
    );
    if (history.length > 0) {
      return {
        kind: 'resolved',
        object_id: history[0].object_id,
        object_name: history[0].object_name,
        source: 'history_90d',
      };
    }
  } catch (err) {
    if (!isMissingTableError(err)) throw err;
  }

  return { kind: 'none' };
}

export type AllocationValidationError =
  | { code: 'ALLOCATION_SUM_MISMATCH'; expected: number; actual: number }
  | { code: 'ALLOCATION_DUPLICATE_OBJECT'; object_id: string }
  | { code: 'ALLOCATION_TOO_MANY' }
  | { code: 'OBJECT_NOT_ALLOWED'; object_id: string; candidates: ISelectableObject[] };

/**
 * Проверяет присланное человеком распределение и подставляет имена объектов С СЕРВЕРА
 * (клиентскому object_name не доверяем — он попал бы в metadata и в выгрузки).
 *
 * keepObjectIds — объекты, уже сохранённые в этой корректировке: их разрешаем оставить,
 * даже если объект успели деактивировать, иначе старую правку нельзя было бы пересохранить.
 */
export async function validateRequestedAllocations(params: {
  employeeId: number;
  workDate: string;
  hours: number;
  requested: Array<{ object_id: string; hours: number }>;
  keepObjectIds?: string[];
}): Promise<
  | { ok: true; allocations: IObjectAllocation[] }
  | { ok: false; error: AllocationValidationError }
> {
  const { employeeId, workDate, hours, requested } = params;
  const keep = new Set(params.keepObjectIds ?? []);

  if (requested.length > MAX_OBJECT_ALLOCATIONS) {
    return { ok: false, error: { code: 'ALLOCATION_TOO_MANY' } };
  }

  const seen = new Set<string>();
  for (const item of requested) {
    if (seen.has(item.object_id)) {
      return { ok: false, error: { code: 'ALLOCATION_DUPLICATE_OBJECT', object_id: item.object_id } };
    }
    seen.add(item.object_id);
  }

  // Сравниваем в центичасах: домен hours_override — два знака после запятой.
  const expected = Math.round(hours * 100);
  const actual = requested.reduce((sum, item) => sum + Math.round(item.hours * 100), 0);
  if (expected !== actual) {
    return { ok: false, error: { code: 'ALLOCATION_SUM_MISMATCH', expected, actual } };
  }

  const selectable = await listSelectableObjectsForEmployee(employeeId, workDate);
  const nameById = new Map(selectable.map(item => [item.object_id, item.object_name]));

  const missingNames = requested
    .map(item => item.object_id)
    .filter(objectId => !nameById.has(objectId) && keep.has(objectId));
  if (missingNames.length > 0) {
    // Сохранённый ранее объект мог стать неактивным — имя берём напрямую из справочника.
    const rows = await query<{ id: string; name: string }>(
      `SELECT id::text AS id, name FROM skud_objects WHERE id = ANY($1::uuid[])`,
      [missingNames],
    );
    for (const row of rows) nameById.set(row.id, row.name);
  }

  const allocations: IObjectAllocation[] = [];
  for (const item of requested) {
    const name = nameById.get(item.object_id);
    if (!name) {
      return {
        ok: false,
        error: { code: 'OBJECT_NOT_ALLOWED', object_id: item.object_id, candidates: selectable },
      };
    }
    allocations.push({ object_id: item.object_id, object_name: name, hours: item.hours });
  }

  return { ok: true, allocations: canonicalizeAllocations(allocations) };
}

/** Один объект в предложении: сколько минут присутствия за ним подтверждено СКУД. */
export interface IAllocationSuggestionSlice {
  object_id: string;
  object_name: string;
  /** 0 — объект известен (непарный проход/отказ), но длительность из событий не выводится. */
  minutes: number;
}

export interface IDayAllocationSuggestion {
  distribution: IAllocationSuggestionSlice[];
  resolution_source: ObjectResolutionSource | 'skud_day_unpaired' | null;
  /** true — человек обязан подтвердить распределение: надёжных минут нет либо сигналы спорят. */
  requires_allocation: boolean;
  /** true — объект однозначно не определяется (вход на одном объекте, выход на другом; ничья). */
  ambiguous: boolean;
  candidates: ISelectableObject[];
}

interface IDayObjectEventRow {
  event_time: string;
  direction: 'entry' | 'exit' | null;
  access_point: string | null;
  object_id: string;
  object_name: string;
}

/**
 * ЧИТАЮЩИЙ резолвер ПОДСКАЗКИ для модалки корректировки. Умышленно отдельный от
 * buildObjectAttendanceData: тот считает весь объектный табель, и правка его правил
 * сдвинула бы исторические часы других сотрудников.
 *
 * Правило пары строже общего: вход и выход должны быть на ОДНОМ объекте. Вход на A и
 * выход на B не доказывают, сколько человек провёл на каждом (между ними дорога, обед,
 * пропущенные события) — такой день уходит в ambiguous, распределение задаёт человек.
 */
export async function resolveDayAllocationSuggestion(params: {
  employeeId: number;
  workDate: string;
  scheduleType?: string;
}): Promise<IDayAllocationSuggestion> {
  const { employeeId, workDate } = params;
  const empty: IDayAllocationSuggestion = {
    distribution: [],
    resolution_source: null,
    requires_allocation: true,
    ambiguous: false,
    candidates: [],
  };

  let rows: IDayObjectEventRow[] = [];
  try {
    rows = await query<IDayObjectEventRow>(
      `SELECT se.event_time::text AS event_time,
              se.direction,
              se.access_point,
              sap.object_id::text  AS object_id,
              so.name              AS object_name
         FROM skud_events se
         JOIN skud_object_access_points sap
           ON BTRIM(sap.access_point_name) = BTRIM(se.access_point)
         JOIN skud_objects so
           ON so.id = sap.object_id AND so.is_active = TRUE
        WHERE se.employee_id = $1
          AND se.event_date = $2::date
          AND se.access_point IS NOT NULL
        ORDER BY se.event_time ASC`,
      [employeeId, workDate],
    );
  } catch (err) {
    if (!isMissingTableError(err)) throw err;
    return empty;
  }

  const internalPoints = await getNormalizedInternalPoints();
  const events = rows.filter(row => {
    const point = normalizeAccessPoint(row.access_point);
    return point !== null && !internalPoints.has(point);
  });

  const nameById = new Map<string, string>();
  for (const row of events) nameById.set(row.object_id, row.object_name);

  const secondsOfDay = (value: string): number => {
    const [h, m, sec] = value.split(':');
    return (Number(h) || 0) * 3600 + (Number(m) || 0) * 60 + (Number(sec) || 0);
  };

  // Пары строим только внутри одного объекта; выход на другом объекте закрывает
  // открытый вход БЕЗ начисления минут и помечает день спорным.
  const minutesByObject = new Map<string, number>();
  let openObjectId: string | null = null;
  let openSeconds = 0;
  let crossObjectPair = false;

  for (const event of events) {
    if (event.direction === 'entry') {
      openObjectId = event.object_id;
      openSeconds = secondsOfDay(event.event_time);
      continue;
    }
    if (event.direction !== 'exit') continue;
    if (openObjectId === null) continue;

    if (openObjectId === event.object_id) {
      const seconds = Math.max(0, secondsOfDay(event.event_time) - openSeconds);
      minutesByObject.set(event.object_id, (minutesByObject.get(event.object_id) ?? 0) + Math.round(seconds / 60));
    } else {
      crossObjectPair = true;
    }
    openObjectId = null;
  }

  const pairedObjects = [...minutesByObject.entries()].filter(([, minutes]) => minutes > 0);
  const objectsWithEvents = [...nameById.keys()];

  if (pairedObjects.length > 0 && !crossObjectPair) {
    const unpaired = objectsWithEvents.filter(objectId => !minutesByObject.has(objectId));
    return {
      distribution: pairedObjects.map(([objectId, minutes]) => ({
        object_id: objectId,
        object_name: nameById.get(objectId) ?? UNKNOWN_OBJECT_NAME,
        minutes,
      })),
      resolution_source: 'skud_day',
      // Есть объект, где человек отметился, но пары нет — часы по нему знает только человек.
      requires_allocation: unpaired.length > 0,
      ambiguous: false,
      candidates: [],
    };
  }

  // Пар нет (или вход/выход на разных объектах): минут не выводим, объект подтверждает человек.
  const candidatesFromEvents: ISelectableObject[] = objectsWithEvents.map(objectId => ({
    object_id: objectId,
    object_name: nameById.get(objectId) ?? UNKNOWN_OBJECT_NAME,
  }));

  if (crossObjectPair || candidatesFromEvents.length > 1) {
    return {
      distribution: [],
      resolution_source: null,
      requires_allocation: true,
      ambiguous: true,
      candidates: candidatesFromEvents,
    };
  }

  if (candidatesFromEvents.length === 1) {
    return {
      distribution: [{ ...candidatesFromEvents[0], minutes: 0 }],
      resolution_source: 'skud_day_unpaired',
      requires_allocation: true,
      ambiguous: false,
      candidates: candidatesFromEvents,
    };
  }

  // Событий нет вовсе: отказы доступа → привязка удалёнщика → история 90 дней.
  const fallback = await resolveDayObjectDetailed({ employeeId, workDate, scheduleType: params.scheduleType });
  if (fallback.kind === 'ambiguous') {
    return {
      distribution: [],
      resolution_source: null,
      requires_allocation: true,
      ambiguous: true,
      candidates: fallback.candidates,
    };
  }
  if (fallback.kind === 'resolved') {
    return {
      distribution: [{ object_id: fallback.object_id, object_name: fallback.object_name, minutes: 0 }],
      resolution_source: fallback.source,
      requires_allocation: true,
      ambiguous: false,
      candidates: [{ object_id: fallback.object_id, object_name: fallback.object_name }],
    };
  }
  return empty;
}


const fetchObjectMappings = async (): Promise<{
  accessPointToObjectId: Map<string, string>;
  objectNameById: Map<string, string>;
}> => {
  let mappingsRows: ITravelObjectMappingRow[] = [];
  let objectsRows: ITravelObjectRow[] = [];

  try {
    mappingsRows = await query<ITravelObjectMappingRow>(
      'SELECT object_id, access_point_name FROM skud_object_access_points',
    );
  } catch (err) {
    if (isMissingTableError(err)) {
      return { accessPointToObjectId: new Map(), objectNameById: new Map() };
    }
    throw err;
  }

  try {
    objectsRows = await query<ITravelObjectRow>(
      'SELECT id, name FROM skud_objects WHERE is_active = true',
    );
  } catch (err) {
    if (isMissingTableError(err)) {
      return { accessPointToObjectId: new Map(), objectNameById: new Map() };
    }
    throw err;
  }

  const accessPointToObjectId = new Map<string, string>();
  for (const row of mappingsRows) {
    const point = normalizeAccessPoint(row.access_point_name);
    if (point) {
      accessPointToObjectId.set(point, row.object_id);
    }
  }

  const objectNameById = new Map<string, string>();
  for (const row of objectsRows) {
    objectNameById.set(row.id, row.name);
  }

  return { accessPointToObjectId, objectNameById };
};

const readAdjustmentObjectMetadata = (metadata: Record<string, unknown>): { object_id: string | null; object_name: string } => {
  const objectId = typeof metadata.object_id === 'string' && metadata.object_id.trim()
    ? metadata.object_id.trim()
    : null;
  const objectName = typeof metadata.object_name === 'string' && metadata.object_name.trim()
    ? metadata.object_name.trim()
    : UNKNOWN_OBJECT_NAME;

  return { object_id: objectId, object_name: objectName };
};

const toObjectEntry = (entry: IAggregatedObjectEntry): IAttendanceObjectEntry => ({
  adjustment_id: entry.adjustment_id,
  employee_id: entry.employee_id,
  work_date: entry.work_date,
  object_key: entry.object_key,
  object_id: entry.object_id,
  object_name: entry.object_name,
  hours_worked: roundHours(entry.effective_minutes / 60),
  display_hours_worked: roundHours(entry.effective_minutes / 60),
  base_hours_worked: roundHours(entry.base_minutes / 60),
  is_correction: entry.is_correction,
  notes: entry.notes ?? null,
  from_day_level: entry.from_day_level ?? false,
});

export async function buildObjectAttendanceData(params: {
  employeeIds: number[];
  startDate: string;
  endDate: string;
  todayStr?: string;
  adjustments: IObjectAdjustmentSource[];
  // Если false — пропускаем object-агрегацию (intervals, object adjustments, serialization),
  // но rawFallbackSummaries всё равно строим: они нужны табелю для дней без skud_daily_summary
  // в обоих режимах отображения. До фикса fallback гасился вместе с object-блоком, и день с
  // событиями, но без summary, показывался как «Н» (см. attendance.service.test 'employees view').
  includeObjectDetails?: boolean;
  // Клиент транзакции для материализации версии табеля: чтение ФАКТОВ (события СКУД,
  // историческая привязка по событиям) идёт через него. Справочники — маппинг точек
  // и список объектов — читаются как обычно, они за in-memory кэшем и меняются редко.
  exec?: DbExecutor;
}): Promise<{
  objectEntries: IAttendanceObjectEntry[];
  objectEntriesByEmployeeDate: Map<number, Map<string, IAttendanceObjectEntry[]>>;
  employeeDistinctObjectKeys: Map<number, Set<string>>;
  legacyBlockedDays: Map<string, string>;
  rawFallbackSummaries: Map<number, Map<string, IRawFallbackSummary>>;
}> {
  const { employeeIds, startDate, endDate, adjustments, exec } = params;
  const todayStr = params.todayStr ?? formatDateToISO(new Date());
  const includeObjectDetails = params.includeObjectDetails ?? true;
  // Тянем события на 2 дня вперёд за пределы периода: утреннее закрытие ночной смены
  // последних дней периода приходит уже следующей датой (см. sliceShiftWindow / миграция 161).
  const rawEventsEndDate = formatDateToISO(
    new Date(new Date(`${endDate}T00:00:00Z`).getTime() + 2 * 86400_000),
  );
  if (employeeIds.length === 0) {
    return {
      objectEntries: [],
      objectEntriesByEmployeeDate: new Map(),
      employeeDistinctObjectKeys: new Map(),
      legacyBlockedDays: new Map(),
      rawFallbackSummaries: new Map(),
    };
  }

  const [internalPoints, objectMappings, rawEvents, assignedObjectsByEmployee] = await runMaybeParallel(
    exec,
    () => getNormalizedInternalPoints(),
    () => (includeObjectDetails
      ? fetchObjectMappings()
      : Promise.resolve({ accessPointToObjectId: new Map<string, string>(), objectNameById: new Map<string, string>() })),
    () => fetchRawEvents({ employeeIds, startDate, endDate: rawEventsEndDate, exec }),
    () => (includeObjectDetails
      ? listObjectIdsForEmployees(employeeIds, exec)
      : Promise.resolve(new Map<number, string[]>())),
  );

  // Сотрудники без приписки в employee_skud_object_access — для них day-level
  // корректировку нужно прицепить к фактическому объекту, иначе попадёт в «Не определён».
  // Берём 90 дней до endDate включительно: даёт «основной» объект сотрудника по СКУД-истории.
  const employeesWithoutAssignment = includeObjectDetails
    ? employeeIds.filter(id => (assignedObjectsByEmployee.get(id) || []).length === 0)
    : [];
  const historicalPrimaryByEmployee = includeObjectDetails
    ? await fetchHistoricalPrimaryObjects(
        employeesWithoutAssignment,
        // endDate - 90д … endDate включительно
        formatDateToISO(new Date(new Date(`${endDate}T00:00:00Z`).getTime() - 90 * 86400_000)),
        endDate,
        exec,
      )
    : new Map<number, { object_id: string; object_name: string }>();

  // Удалёнщики: датированная привязка к объекту — фолбэк для day-level правки в
  // дни без СКУД (между реальным СКУД дня и 90-дневной историей). Реальный СКУД дня
  // остаётся приоритетнее, поэтому при выходе на работу реальный объект не маскируется.
  const remoteSchedulesByEmployee = includeObjectDetails
    ? await resolveSchedulesBulk(employeeIds.map(id => ({ id })), endDate, exec)
    : new Map();
  const remoteEmployeeIds = includeObjectDetails
    ? employeeIds.filter(id => remoteSchedulesByEmployee.get(id)?.schedule_type === 'remote')
    : [];
  const attributionRowsByEmployee = remoteEmployeeIds.length > 0
    ? await listAttributionRowsForEmployees(remoteEmployeeIds, startDate, endDate, exec)
    : new Map<number, IAttributionRow[]>();

  // Графики по дням периода — для ночного гейта окна (миграция 168): у дневной смены пара
  // вход→выход не пересекает полночь. Резолвим на весь период один раз.
  const schedulesByEmployeeDate = await resolveSchedulesForPeriod(
    employeeIds.map(id => ({ id })),
    startDate,
    endDate,
    exec,
  );

  const rawFallbackSummaries = new Map<number, Map<string, IRawFallbackSummary>>();
  const baseObjectEntries = new Map<string, IAggregatedObjectEntry>();
  const baseDistinctObjectKeys = new Map<string, Set<string>>();

  // Группируем по сотруднику (не по календарному дню): парность смены считается в 32ч-окне,
  // которое может пересекать полночь. Результат привязывается к дню НАЧАЛА смены.
  const eventsByEmployee = new Map<number, IRawEventRow[]>();
  for (const event of rawEvents) {
    if (!event.employee_id) continue;
    const bucket = eventsByEmployee.get(event.employee_id) || [];
    bucket.push(event);
    eventsByEmployee.set(event.employee_id, bucket);
  }

  for (const [employeeId, employeeEvents] of eventsByEmployee) {
    const externalStream = getExternalStreamChrono(employeeEvents, internalPoints);
    if (externalStream.length === 0) continue;

    for (const startDay of collectShiftStartDays(externalStream, startDate, endDate)) {
      const daySchedule = schedulesByEmployeeDate.get(employeeId)?.get(startDay);
      const isNight = daySchedule
        ? isNightShiftDay(daySchedule, new Date(`${startDay}T00:00:00`))
        : false;
      const windowEvents = sliceShiftWindow(externalStream, startDay, isNight);
      if (windowEvents.length === 0) continue;

      const rawSummary = buildRawFallbackSummary(windowEvents, startDay, todayStr);
      if (rawSummary) {
        if (!rawFallbackSummaries.has(employeeId)) {
          rawFallbackSummaries.set(employeeId, new Map());
        }
        rawFallbackSummaries.get(employeeId)!.set(startDay, rawSummary);
      }

      if (!includeObjectDetails) continue;

      const intervals = buildObjectIntervals({
        events: windowEvents,
        accessPointToObjectId: objectMappings.accessPointToObjectId,
        objectNameById: objectMappings.objectNameById,
        workDate: startDay,
        todayStr,
      });

      if (intervals.length === 0) continue;

      const splitKey = dayKey(employeeId, startDay);
      const dayObjects = baseDistinctObjectKeys.get(splitKey) || new Set<string>();
      for (const interval of intervals) {
        dayObjects.add(interval.object_key);
        const intervalKey = objectEntryKey(employeeId, startDay, interval.object_key);
        const existing = baseObjectEntries.get(intervalKey);
        if (existing) {
          existing.base_minutes += interval.minutes;
          existing.effective_minutes += interval.minutes;
          continue;
        }

        baseObjectEntries.set(intervalKey, {
          adjustment_id: null,
          employee_id: employeeId,
          work_date: startDay,
          object_key: interval.object_key,
          object_id: interval.object_id,
          object_name: interval.object_name,
          base_minutes: interval.minutes,
          effective_minutes: interval.minutes,
          is_correction: false,
          notes: null,
        });
      }
      baseDistinctObjectKeys.set(splitKey, dayObjects);
    }
  }

  if (!includeObjectDetails) {
    // Режим «По сотрудникам» / fallback-only: object-структуры не нужны, отдаём только summary.
    return {
      objectEntries: [],
      objectEntriesByEmployeeDate: new Map(),
      employeeDistinctObjectKeys: new Map(),
      legacyBlockedDays: new Map(),
      rawFallbackSummaries,
    };
  }

  // Мигрированные из day-level корректировки идут в dailyAdjustments (чистят СКУД дня,
  // авторитетный итог), а не в объектные (которые лишь перекрывают свой объект) — иначе
  // СКУД на других объектах дня задваивается.
  const objectAdjustments = adjustments
    .filter(adjustment => adjustment.source_type === OBJECT_ADJUSTMENT_SOURCE_TYPE
      && !isMigratedDayLevelAdjustment(adjustment))
    .sort((left, right) => new Date(left.updated_at).getTime() - new Date(right.updated_at).getTime());
  const dailyAdjustments = adjustments.filter(adjustment =>
    adjustment.source_type !== OBJECT_ADJUSTMENT_SOURCE_TYPE
    || isMigratedDayLevelAdjustment(adjustment));

  for (const adjustment of objectAdjustments) {
    const metadata = readAdjustmentObjectMetadata(adjustment.metadata);
    const objectKey = adjustment.source_id || UNKNOWN_OBJECT_KEY;
    const key = objectEntryKey(adjustment.employee_id, adjustment.work_date, objectKey);
    const existing = baseObjectEntries.get(key);
    const nextEntry: IAggregatedObjectEntry = existing || {
      adjustment_id: null,
      employee_id: adjustment.employee_id,
      work_date: adjustment.work_date,
      object_key: objectKey,
      object_id: metadata.object_id,
      object_name: metadata.object_name,
      base_minutes: 0,
      effective_minutes: 0,
      is_correction: false,
      notes: null,
    };

    nextEntry.adjustment_id = adjustment.id;
    nextEntry.object_id = nextEntry.object_id || metadata.object_id;
    nextEntry.object_name = nextEntry.object_name || metadata.object_name;
    nextEntry.effective_minutes = Math.max(0, Math.round((adjustment.hours_override || 0) * 60));
    nextEntry.is_correction = true;
    nextEntry.notes = adjustment.reason;
    baseObjectEntries.set(key, nextEntry);

    const splitKey = dayKey(adjustment.employee_id, adjustment.work_date);
    const dayObjects = baseDistinctObjectKeys.get(splitKey) || new Set<string>();
    dayObjects.add(objectKey);
    baseDistinctObjectKeys.set(splitKey, dayObjects);
  }

  // legacyBlockedDays больше не заполняется: общая дневная корректировка теперь
  // относится к приписке сотрудника, а не блокирует объектную детализацию.
  // Пустую Map сохраняем в контракте — её читает attendance.service.
  const legacyBlockedDays = new Map<string, string>();

  // Дни с явной объектной правкой (manual_object) приоритетнее общей корректировки.
  const objectAdjustedDays = new Set(
    objectAdjustments.map(adjustment => dayKey(adjustment.employee_id, adjustment.work_date)),
  );

  // Явная объектная правка с положительными часами авторитетна для дня: снимаем
  // НЕоткорректированные СКУД-объекты этого дня. Иначе их часы продолжают добавляться
  // к скорректированному объекту и дневной итог завышается — день с отметками на двух
  // точках одного ЖК (К13 + К14): правка только К13 не «срабатывала», итог = К13(правка)
  // + К14(СКУД) ≈ норма графика, и выгрузка «Как в 1С» схлопывала её в график.
  // Откорректированные объекты дня сохраняем; обнулённые/absence-правки (hours_override<=0)
  // чужие объекты не трогают — они гасят свой объект через ветку dailyAdjustments ниже.
  const authoritativeObjectDays = new Set(
    objectAdjustments
      .filter(adjustment => (adjustment.hours_override ?? 0) > 0)
      .map(adjustment => dayKey(adjustment.employee_id, adjustment.work_date)),
  );

  // Индекс entryKey по дню (employee_id_date): операции «все объект-записи дня» становятся
  // O(записей дня) вместо O(всех записей). Без индекса циклы ниже (тысячи day-level правок ×
  // десятки тысяч записей) деградировали в O(n²) и упирались в таймаут на больших выгрузках.
  const entriesByDay = new Map<string, Set<string>>();
  for (const [entryKey, entry] of baseObjectEntries) {
    const dKey = dayKey(entry.employee_id, entry.work_date);
    let daySet = entriesByDay.get(dKey);
    if (!daySet) { daySet = new Set(); entriesByDay.set(dKey, daySet); }
    daySet.add(entryKey);
  }
  // Удалить ВСЕ объект-записи дня (с поддержкой индекса).
  const deleteDayEntries = (dKey: string): void => {
    const daySet = entriesByDay.get(dKey);
    if (!daySet) return;
    for (const entryKey of daySet) baseObjectEntries.delete(entryKey);
    entriesByDay.delete(dKey);
  };

  for (const dKey of authoritativeObjectDays) {
    const daySet = entriesByDay.get(dKey);
    if (!daySet) continue;
    for (const entryKey of [...daySet]) {
      const entry = baseObjectEntries.get(entryKey);
      if (!entry || entry.is_correction) continue;
      baseObjectEntries.delete(entryKey);
      daySet.delete(entryKey);
      baseDistinctObjectKeys.get(dKey)?.delete(entry.object_key);
    }
  }

  const sortedDailyAdjustments = [...dailyAdjustments].sort((left, right) => {
    const diff = getAdjustmentPriority(right.source_type) - getAdjustmentPriority(left.source_type);
    if (diff !== 0) return diff;
    return new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime();
  });

  const seenSplitDays = new Set<string>();
  for (const adjustment of sortedDailyAdjustments) {
    const dKey = dayKey(adjustment.employee_id, adjustment.work_date);
    // Только авторитетная (top-priority) корректировка дня — та же, что задаёт
    // entry.hours_worked в attendance.service. Иначе объектная сумма ≠ дневной.
    if (seenSplitDays.has(dKey)) continue;
    seenSplitDays.add(dKey);
    if (objectAdjustedDays.has(dKey)) continue;

    const hoursOverride = adjustment.hours_override;
    // Корректировка «удалённая работа» с явными часами и согласованием — это
    // отработанный день (зеркалит attendance.service): часы распределяются по
    // объектам (attribution/historical/приписка), иначе объектная сумма ≠ дневной.
    const remoteNotApproved = adjustment.approval_status === 'pending'
      || adjustment.approval_status === 'rejected';
    const isRemoteWithHours = adjustment.status === 'remote'
      && hoursOverride != null && Number(hoursOverride) > 0 && !remoteNotApproved;
    const isNonWork = NON_WORK_ADJUSTMENT_STATUSES.has(adjustment.status as TimeStatus)
      && !isRemoteWithHours;

    // status='work' + hoursOverride=null = работал в выходной, часы из СКУД.
    // СКУД-записи уже корректны по объектам — оставляем как есть.
    if (adjustment.status === 'work' && hoursOverride == null) {
      continue;
    }

    // Авторитетная корректировка дня НЕ даёт отработанных часов
    // (обнулённый рабочий день: status=work + hours_override<=0; либо отсутствие:
    // отпуск/больничный/прогул/удалёнка). Снимаем СКУД-распределение дня, иначе
    // остаточный интервал переживёт корректировку и «по объектам» покажет
    // фантомные часы, расходясь с «по сотрудникам» (там day-level entry держит 0ч/статус).
    if (isNonWork || hoursOverride == null || hoursOverride <= 0) {
      deleteDayEntries(dKey);
      baseDistinctObjectKeys.delete(dKey);
      continue;
    }

    // Снимок реальных объектов дня ДО удаления СКУД-записей: объекты, где сотрудник
    // фактически отметился, с минутами присутствия. Это авторитетный сигнал «где был»,
    // важнее списка приписки (руководитель приписан к нескольким ЖК ради доступа,
    // а ходит на один — иначе скорректированные часы фантомно размазываются по приписке).
    const dayObjectMinutes = new Map<string, { object_name: string; minutes: number }>();
    for (const entryKey of entriesByDay.get(dKey) ?? []) {
      const entry = baseObjectEntries.get(entryKey);
      if (!entry) continue;
      if (entry.object_key === UNKNOWN_OBJECT_KEY || !entry.object_id) continue;
      const prev = dayObjectMinutes.get(entry.object_id);
      dayObjectMinutes.set(entry.object_id, {
        object_name: entry.object_name,
        minutes: (prev?.minutes || 0) + Math.max(0, entry.base_minutes),
      });
    }

    // Корректировка перекрывает фактические СКУД-события дня — иначе двойной счёт.
    deleteDayEntries(dKey);
    baseDistinctObjectKeys.delete(dKey);

    const assigned = (assignedObjectsByEmployee.get(adjustment.employee_id) || [])
      .filter(objectId => objectMappings.objectNameById.has(objectId));

    // Получатели скорректированных часов и веса распределения. Приоритет:
    // 1) единственная приписка — однозначный «домашний» объект; день-правка
    //    перекрывает случайные проходы по др. объектам (Бабышев: obj-b, не СКУД-obj-a);
    // 2) несколько приписок (или ноль) + реальный СКУД дня — распределяем по объектам
    //    фактического присутствия пропорц. минутам (приписка ≠ «где работал»: руководитель
    //    приписан к нескольким ЖК ради доступа, а ходит на один — Кулагин/Рыбалко);
    // 3) объект, выбранный миграцией day-level→object (metadata.object_id);
    // 4) удалёнщик — датированная привязка (employee_object_attribution);
    // 5) основной объект за 90 дней (historicalPrimaryByEmployee);
    // 6) нет сигнала — поровну по приписке (≥2 объектов);
    // 7) совсем ничего — UNKNOWN (редкий тру-фоллбек).
    // 0) Явное распределение, заданное человеком в дневной форме (metadata.object_allocations).
    // Сильнее любых сигналов СКУД и приписки: табельщица подтвердила, где человек работал.
    // Веса — сами часы аллокаций, поэтому деление ниже вернёт ровно введённые значения.
    const explicitAllocations = readObjectAllocations(adjustment.metadata);

    let targets: Array<{ objectKey: string; objectId: string | null; objectName: string; weight: number }>;
    if (explicitAllocations.length > 0) {
      targets = explicitAllocations.map(allocation => ({
        objectKey: allocation.object_id,
        objectId: allocation.object_id,
        // Имя из справочника: сохранённое в metadata могло устареть после переименования.
        objectName: objectMappings.objectNameById.get(allocation.object_id)
          || allocation.object_name
          || UNKNOWN_OBJECT_NAME,
        weight: Math.max(0, Math.round(allocation.hours * 100)),
      }));
    } else if (assigned.length === 1) {
      const objectId = assigned[0];
      targets = [{
        objectKey: objectId,
        objectId,
        objectName: objectMappings.objectNameById.get(objectId) || UNKNOWN_OBJECT_NAME,
        weight: 1,
      }];
    } else if (dayObjectMinutes.size > 0) {
      const anyMinutes = [...dayObjectMinutes.values()].some(value => value.minutes > 0);
      targets = [...dayObjectMinutes.entries()].map(([objectId, value]) => ({
        objectKey: objectId,
        objectId,
        objectName: value.object_name,
        weight: anyMinutes ? value.minutes : 1,
      }));
    } else {
      const remoteAttribution = attributionRowsByEmployee.size > 0
        ? resolveAttributionAt(attributionRowsByEmployee.get(adjustment.employee_id), adjustment.work_date)
        : null;
      const migratedMeta = isMigratedDayLevelAdjustment(adjustment)
        ? readAdjustmentObjectMetadata(adjustment.metadata)
        : null;
      const migratedFallback = migratedMeta?.object_id
        ? { object_id: migratedMeta.object_id, object_name: migratedMeta.object_name }
        : null;
      const single = migratedFallback
        ?? remoteAttribution
        ?? historicalPrimaryByEmployee.get(adjustment.employee_id)
        ?? null;
      if (single) {
        targets = [{ objectKey: single.object_id, objectId: single.object_id, objectName: single.object_name, weight: 1 }];
      } else {
        targets = assigned.length > 0
          ? assigned.map(objectId => ({
            objectKey: objectId,
            objectId,
            objectName: objectMappings.objectNameById.get(objectId) || UNKNOWN_OBJECT_NAME,
            weight: 1,
          }))
          : [{ objectKey: UNKNOWN_OBJECT_KEY, objectId: null, objectName: UNKNOWN_OBJECT_NAME, weight: 1 }];
      }
    }

    // Делим в центичасах (2 знака — домен roundHours) пропорционально весам.
    // Метод наибольшего остатка — сумма долей точно равна скорректированным часам.
    const totalCentihours = Math.max(0, Math.round(hoursOverride * 100));
    const sumWeight = targets.reduce((sum, target) => sum + target.weight, 0);
    const exactShares = targets.map(target => (sumWeight > 0 ? (totalCentihours * target.weight) / sumWeight : 0));
    const centihoursByTarget = exactShares.map(value => Math.floor(value));
    let distributed = centihoursByTarget.reduce((sum, value) => sum + value, 0);
    const byFractionDesc = exactShares
      .map((value, index) => ({ index, frac: value - Math.floor(value) }))
      .sort((left, right) => right.frac - left.frac);
    for (let k = 0; distributed < totalCentihours && targets.length > 0; k += 1) {
      centihoursByTarget[byFractionDesc[k % targets.length].index] += 1;
      distributed += 1;
    }
    const dayObjects = baseDistinctObjectKeys.get(dKey) || new Set<string>();
    const daySet = entriesByDay.get(dKey) ?? new Set<string>();
    entriesByDay.set(dKey, daySet);
    targets.forEach((target, index) => {
      const centihours = centihoursByTarget[index];
      const newKey = objectEntryKey(adjustment.employee_id, adjustment.work_date, target.objectKey);
      baseObjectEntries.set(newKey, {
        adjustment_id: adjustment.id,
        employee_id: adjustment.employee_id,
        work_date: adjustment.work_date,
        object_key: target.objectKey,
        object_id: target.objectId,
        object_name: target.objectName,
        base_minutes: 0,
        // центичасы → минуты: roundHours(effective_minutes/60) даст ровно centihours/100.
        effective_minutes: centihours * 0.6,
        is_correction: true,
        notes: adjustment.reason,
        // Эхо day-level корректировки (не самостоятельная объектная) — модалка дня его прячет (#8).
        from_day_level: true,
      });
      daySet.add(newKey);
      dayObjects.add(target.objectKey);
    });
    baseDistinctObjectKeys.set(dKey, dayObjects);
  }

  const objectEntries: IAttendanceObjectEntry[] = [];
  const objectEntriesByEmployeeDate = new Map<number, Map<string, IAttendanceObjectEntry[]>>();
  const employeeDistinctObjectKeys = new Map<number, Set<string>>();

  for (const entry of baseObjectEntries.values()) {
    const objectEntry = toObjectEntry(entry);
    objectEntries.push(objectEntry);

    if (!objectEntriesByEmployeeDate.has(objectEntry.employee_id)) {
      objectEntriesByEmployeeDate.set(objectEntry.employee_id, new Map());
    }
    const employeeDays = objectEntriesByEmployeeDate.get(objectEntry.employee_id)!;
    const dayEntries = employeeDays.get(objectEntry.work_date) || [];
    dayEntries.push(objectEntry);
    employeeDays.set(objectEntry.work_date, dayEntries);

    if (!employeeDistinctObjectKeys.has(objectEntry.employee_id)) {
      employeeDistinctObjectKeys.set(objectEntry.employee_id, new Set());
    }
    employeeDistinctObjectKeys.get(objectEntry.employee_id)!.add(objectEntry.object_key);
  }

  objectEntries.sort((left, right) => {
    if (left.employee_id !== right.employee_id) return left.employee_id - right.employee_id;
    if (left.work_date !== right.work_date) return left.work_date.localeCompare(right.work_date);
    return left.object_name.localeCompare(right.object_name, 'ru');
  });

  for (const byDate of objectEntriesByEmployeeDate.values()) {
    for (const [date, items] of byDate) {
      byDate.set(date, items.sort((left, right) => left.object_name.localeCompare(right.object_name, 'ru')));
    }
  }

  return {
    objectEntries,
    objectEntriesByEmployeeDate,
    employeeDistinctObjectKeys,
    legacyBlockedDays,
    rawFallbackSummaries,
  };
}
