import { query } from '../config/postgres.js';
import type { TimeStatus } from '../types/index.js';
import { getInternalAccessPoints } from './skud-shared.service.js';
import { listObjectIdsForEmployees } from './employee-skud-object-access.service.js';
import {
  getAttributionObjectForEmployeeAt,
  listAttributionRowsForEmployees,
  resolveAttributionAt,
  type IAttributionRow,
} from './employee-object-attribution.service.js';
import { resolveSchedule, resolveSchedulesBulk } from './schedule.service.js';
import { formatDateToISO } from '../utils/date.utils.js';
import {
  getAdjustmentPriority,
  NON_WORK_ADJUSTMENT_STATUSES,
  roundHours,
} from './time-calculation/primitives.js';

const BATCH_SIZE = 500;

export const OBJECT_ADJUSTMENT_SOURCE_TYPE = 'manual_object';
export const UNKNOWN_OBJECT_KEY = '__unknown_object__';
export const UNKNOWN_OBJECT_NAME = 'Не определён';

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

const getSummaryEventStream = (events: IRawEventRow[], internalPoints: Set<string>): IRawEventRow[] => {
  const externalEvents = events.filter(event => {
    const point = normalizeAccessPoint(event.access_point);
    return !point || !internalPoints.has(point);
  });
  return [...externalEvents].sort((left, right) => left.event_time.localeCompare(right.event_time));
};

const buildRawFallbackSummary = (
  events: IRawEventRow[],
  internalPoints: Set<string>,
  workDate: string,
  todayStr: string,
): IRawFallbackSummary | null => {
  const summaryEvents = getSummaryEventStream(events, internalPoints);
  if (summaryEvents.length === 0) return null;

  let totalSeconds = 0;
  let openEntrySeconds: number | null = null;

  for (const event of summaryEvents) {
    if (event.direction === 'entry') {
      const seconds = timeToSeconds(event.event_time);
      // Повторная entry без exit: закрываем предыдущий открытый интервал на момент новой entry.
      if (openEntrySeconds !== null) {
        totalSeconds += Math.max(0, seconds - openEntrySeconds);
      }
      openEntrySeconds = seconds;
      continue;
    }

    if (event.direction === 'exit' && openEntrySeconds !== null) {
      totalSeconds += Math.max(0, timeToSeconds(event.event_time) - openEntrySeconds);
      openEntrySeconds = null;
    }
  }

  if (openEntrySeconds !== null && workDate === todayStr) {
    const now = new Date();
    const nowSeconds = timeToSeconds(formatTimeValue(now));
    if (nowSeconds > openEntrySeconds) {
      totalSeconds += nowSeconds - openEntrySeconds;
    }
  }

  const firstEntry = summaryEvents.find(event => event.direction === 'entry')?.event_time ?? null;
  const exitEvents = summaryEvents.filter(event => event.direction === 'exit');
  const lastExit = exitEvents.length > 0 ? exitEvents[exitEvents.length - 1].event_time : null;
  const totalMinutes = Math.round(totalSeconds / 60);

  if (!firstEntry && !lastExit && totalMinutes === 0) {
    return null;
  }

  return {
    employee_id: Number(summaryEvents[0].employee_id || 0),
    date: workDate,
    first_entry: firstEntry,
    last_exit: lastExit,
    total_hours: roundHours(totalMinutes / 60),
    total_minutes: totalMinutes,
  };
};

const buildObjectIntervals = ({
  events,
  internalPoints,
  accessPointToObjectId,
  objectNameById,
  workDate,
  todayStr,
}: {
  events: IRawEventRow[];
  internalPoints: Set<string>;
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
  const summaryEvents = getSummaryEventStream(events, internalPoints);
  if (summaryEvents.length === 0) return [];

  const intervals: Array<{
    object_key: string;
    object_id: string | null;
    object_name: string;
    minutes: number;
  }> = [];
  let openEntry: IRawEventRow | null = null;

  const pushInterval = (entryEvent: IRawEventRow, exitEvent: IRawEventRow | null, exitTime: string): void => {
    const startSeconds = timeToSeconds(entryEvent.event_time);
    const endSeconds = timeToSeconds(exitTime);
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

  for (const event of summaryEvents) {
    if (event.direction === 'entry') {
      // Если уже есть открытая entry без exit — закрываем её на момент новой entry,
      // иначе третья+ точка теряется (последовательность entry1-entry2-exit3 раньше отдавала
      // только пару entry1-exit3, а entry2 игнорировалась).
      if (openEntry) {
        pushInterval(openEntry, event, event.event_time);
      }
      openEntry = event;
      continue;
    }

    if (event.direction === 'exit' && openEntry) {
      pushInterval(openEntry, event, event.event_time);
      openEntry = null;
    }
  }

  if (openEntry) {
    if (workDate === todayStr) {
      pushInterval(openEntry, null, formatTimeValue(new Date()));
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
}: {
  employeeIds: number[];
  startDate: string;
  endDate: string;
}): Promise<IRawEventRow[]> => {
  if (employeeIds.length === 0) return [];

  const rows: IRawEventRow[] = [];
  for (let index = 0; index < employeeIds.length; index += BATCH_SIZE) {
    const batch = employeeIds.slice(index, index + BATCH_SIZE);
    const data = await query<IRawEventRow>(
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
): Promise<Map<number, { object_id: string; object_name: string }>> => {
  const out = new Map<number, { object_id: string; object_name: string }>();
  if (employeeIds.length === 0) return out;

  for (let index = 0; index < employeeIds.length; index += BATCH_SIZE) {
    const batch = employeeIds.slice(index, index + BATCH_SIZE);
    let rows: IHistoricalPrimaryRow[] = [];
    try {
      rows = await query<IHistoricalPrimaryRow>(
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

export async function resolveDayObjectForAdjustment(params: {
  employeeId: number;
  workDate: string;
  /** Если известен — избегаем лишнего resolveSchedule; иначе резолвим внутри. */
  scheduleType?: string;
}): Promise<{ object_id: string; object_name: string } | null> {
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
      return { object_id: sameDay[0].object_id, object_name: sameDay[0].object_name };
    }
  } catch (err) {
    if (!isMissingTableError(err)) throw err;
    return null;
  }

  // 1.5) Удалёнщик без СКУД в этот день: явная датированная привязка к объекту.
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
    if (pinned) return pinned;
  }

  // 2) Объект с максимумом СКУД-событий за 90 дней до даты.
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
      return { object_id: history[0].object_id, object_name: history[0].object_name };
    }
  } catch (err) {
    if (!isMissingTableError(err)) throw err;
  }

  return null;
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
}): Promise<{
  objectEntries: IAttendanceObjectEntry[];
  objectEntriesByEmployeeDate: Map<number, Map<string, IAttendanceObjectEntry[]>>;
  employeeDistinctObjectKeys: Map<number, Set<string>>;
  legacyBlockedDays: Map<string, string>;
  rawFallbackSummaries: Map<number, Map<string, IRawFallbackSummary>>;
}> {
  const { employeeIds, startDate, endDate, adjustments } = params;
  const todayStr = params.todayStr ?? formatDateToISO(new Date());
  const includeObjectDetails = params.includeObjectDetails ?? true;
  if (employeeIds.length === 0) {
    return {
      objectEntries: [],
      objectEntriesByEmployeeDate: new Map(),
      employeeDistinctObjectKeys: new Map(),
      legacyBlockedDays: new Map(),
      rawFallbackSummaries: new Map(),
    };
  }

  const [internalPoints, objectMappings, rawEvents, assignedObjectsByEmployee] = await Promise.all([
    getNormalizedInternalPoints(),
    includeObjectDetails
      ? fetchObjectMappings()
      : Promise.resolve({ accessPointToObjectId: new Map<string, string>(), objectNameById: new Map<string, string>() }),
    fetchRawEvents({ employeeIds, startDate, endDate }),
    includeObjectDetails
      ? listObjectIdsForEmployees(employeeIds)
      : Promise.resolve(new Map<number, string[]>()),
  ]);

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
      )
    : new Map<number, { object_id: string; object_name: string }>();

  // Удалёнщики: датированная привязка к объекту — фолбэк для day-level правки в
  // дни без СКУД (между sameDayMajority и 90-дневной историей). Реальный СКУД дня
  // остаётся приоритетнее, поэтому при выходе на работу реальный объект не маскируется.
  const remoteSchedulesByEmployee = includeObjectDetails
    ? await resolveSchedulesBulk(employeeIds.map(id => ({ id })), endDate)
    : new Map();
  const remoteEmployeeIds = includeObjectDetails
    ? employeeIds.filter(id => remoteSchedulesByEmployee.get(id)?.schedule_type === 'remote')
    : [];
  const attributionRowsByEmployee = remoteEmployeeIds.length > 0
    ? await listAttributionRowsForEmployees(remoteEmployeeIds, startDate, endDate)
    : new Map<number, IAttributionRow[]>();

  const rawFallbackSummaries = new Map<number, Map<string, IRawFallbackSummary>>();
  const baseObjectEntries = new Map<string, IAggregatedObjectEntry>();
  const baseDistinctObjectKeys = new Map<string, Set<string>>();
  const eventsByEmployeeDate = new Map<string, IRawEventRow[]>();

  for (const event of rawEvents) {
    if (!event.employee_id) continue;
    const key = dayKey(event.employee_id, event.event_date);
    const bucket = eventsByEmployeeDate.get(key) || [];
    bucket.push(event);
    eventsByEmployeeDate.set(key, bucket);
  }

  for (const [key, events] of eventsByEmployeeDate) {
    const separatorIndex = key.indexOf('_');
    const employeeId = Number(key.slice(0, separatorIndex));
    const workDate = key.slice(separatorIndex + 1);
    const rawSummary = buildRawFallbackSummary(events, internalPoints, workDate, todayStr);

    if (rawSummary) {
      if (!rawFallbackSummaries.has(employeeId)) {
        rawFallbackSummaries.set(employeeId, new Map());
      }
      rawFallbackSummaries.get(employeeId)!.set(workDate, rawSummary);
    }

    if (!includeObjectDetails) continue;

    const intervals = buildObjectIntervals({
      events,
      internalPoints,
      accessPointToObjectId: objectMappings.accessPointToObjectId,
      objectNameById: objectMappings.objectNameById,
      workDate,
      todayStr,
    });

    if (intervals.length === 0) continue;

    const dayObjects = baseDistinctObjectKeys.get(key) || new Set<string>();
    for (const interval of intervals) {
      dayObjects.add(interval.object_key);
      const intervalKey = objectEntryKey(employeeId, workDate, interval.object_key);
      const existing = baseObjectEntries.get(intervalKey);
      if (existing) {
        existing.base_minutes += interval.minutes;
        existing.effective_minutes += interval.minutes;
        continue;
      }

      baseObjectEntries.set(intervalKey, {
        adjustment_id: null,
        employee_id: employeeId,
        work_date: workDate,
        object_key: interval.object_key,
        object_id: interval.object_id,
        object_name: interval.object_name,
        base_minutes: interval.minutes,
        effective_minutes: interval.minutes,
        is_correction: false,
        notes: null,
      });
    }
    baseDistinctObjectKeys.set(key, dayObjects);
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

  const objectAdjustments = adjustments
    .filter(adjustment => adjustment.source_type === OBJECT_ADJUSTMENT_SOURCE_TYPE)
    .sort((left, right) => new Date(left.updated_at).getTime() - new Date(right.updated_at).getTime());
  const dailyAdjustments = adjustments.filter(adjustment => adjustment.source_type !== OBJECT_ADJUSTMENT_SOURCE_TYPE);

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

    const isNonWork = NON_WORK_ADJUSTMENT_STATUSES.has(adjustment.status as TimeStatus);
    const hoursOverride = adjustment.hours_override;

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
      for (const entryKey of [...baseObjectEntries.keys()]) {
        if (entryKey.startsWith(`${dKey}_`)) baseObjectEntries.delete(entryKey);
      }
      baseDistinctObjectKeys.delete(dKey);
      continue;
    }

    // Снимок СКУД-распределения дня ДО удаления — нужен для fallback'а ниже,
    // если у сотрудника нет приписки в employee_skud_object_access.
    let sameDayBest: { object_id: string; object_name: string; minutes: number } | null = null;
    for (const [entryKey, entry] of baseObjectEntries) {
      if (!entryKey.startsWith(`${dKey}_`)) continue;
      if (entry.object_key === UNKNOWN_OBJECT_KEY || !entry.object_id) continue;
      if (!sameDayBest || entry.base_minutes > sameDayBest.minutes) {
        sameDayBest = { object_id: entry.object_id, object_name: entry.object_name, minutes: entry.base_minutes };
      }
    }
    const sameDayMajority = sameDayBest
      ? { object_id: sameDayBest.object_id, object_name: sameDayBest.object_name }
      : null;

    // Корректировка перекрывает фактические СКУД-события дня — иначе двойной счёт.
    for (const entryKey of [...baseObjectEntries.keys()]) {
      if (entryKey.startsWith(`${dKey}_`)) baseObjectEntries.delete(entryKey);
    }
    baseDistinctObjectKeys.delete(dKey);

    const assigned = (assignedObjectsByEmployee.get(adjustment.employee_id) || [])
      .filter(objectId => objectMappings.objectNameById.has(objectId));
    let targets: Array<{ objectKey: string; objectId: string | null; objectName: string }>;
    if (assigned.length > 0) {
      targets = assigned.map(objectId => ({
        objectKey: objectId,
        objectId,
        objectName: objectMappings.objectNameById.get(objectId) || UNKNOWN_OBJECT_NAME,
      }));
    } else {
      // Сотрудник без приписки: цепляем правку к фактическому объекту,
      // 1) если в этот день есть СКУД — к объекту с максимумом минут (реальный СКУД);
      // 2) удалёнщик — к датированной привязке (employee_object_attribution);
      // 3) иначе — к основному объекту за 90 дней (historicalPrimaryByEmployee);
      // 4) совсем нет данных — оставляем UNKNOWN (редкий тру-фоллбек).
      const remoteAttribution = attributionRowsByEmployee.size > 0
        ? resolveAttributionAt(attributionRowsByEmployee.get(adjustment.employee_id), adjustment.work_date)
        : null;
      const fallback = sameDayMajority
        ?? remoteAttribution
        ?? historicalPrimaryByEmployee.get(adjustment.employee_id)
        ?? null;
      targets = fallback
        ? [{ objectKey: fallback.object_id, objectId: fallback.object_id, objectName: fallback.object_name }]
        : [{ objectKey: UNKNOWN_OBJECT_KEY, objectId: null, objectName: UNKNOWN_OBJECT_NAME }];
    }

    // Делим в центичасах (2 знака — домен roundHours), чтобы сумма долей точно
    // равнялась скорректированным часам без копеечных «остатков» в объектном виде.
    const totalCentihours = Math.max(0, Math.round(hoursOverride * 100));
    const perTarget = Math.floor(totalCentihours / targets.length);
    const remainder = totalCentihours - perTarget * targets.length;
    const dayObjects = baseDistinctObjectKeys.get(dKey) || new Set<string>();
    targets.forEach((target, index) => {
      const centihours = perTarget + (index < remainder ? 1 : 0);
      baseObjectEntries.set(
        objectEntryKey(adjustment.employee_id, adjustment.work_date, target.objectKey),
        {
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
        },
      );
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
