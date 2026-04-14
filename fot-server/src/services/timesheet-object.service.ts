import { supabase } from '../config/database.js';
import { getInternalAccessPoints } from './skud-shared.service.js';
import { formatDateToISO } from '../utils/date.utils.js';

const BATCH_SIZE = 500;

export const OBJECT_ADJUSTMENT_SOURCE_TYPE = 'manual_object';
export const UNKNOWN_OBJECT_KEY = '__unknown_object__';
export const UNKNOWN_OBJECT_NAME = 'Не определён';
export const LEGACY_OBJECT_DETAIL_MESSAGE = 'День скорректирован общей корректировкой. Для объектной правки снимите общую корректировку и внесите часы по объектам.';

export interface IObjectAdjustmentSource {
  id: number;
  employee_id: number;
  work_date: string;
  hours_override: number | null;
  source_type: string;
  source_id: string;
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
  base_hours_worked: number;
  is_correction: boolean;
  notes?: string | null;
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
}

const normalizeAccessPoint = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const normalized = value.trim();
  return normalized || null;
};

const roundHours = (value: number): number => Math.round(value * 100) / 100;

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
  const source = externalEvents.length > 0 ? externalEvents : events;
  return [...source].sort((left, right) => left.event_time.localeCompare(right.event_time));
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
      if (openEntrySeconds === null) {
        openEntrySeconds = timeToSeconds(event.event_time);
      }
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
    const objectId = [entryPoint, exitPoint]
      .map(point => (point ? accessPointToObjectId.get(point) || null : null))
      .find((value): value is string => Boolean(value)) || null;
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
      if (openEntry === null) {
        openEntry = event;
      }
      continue;
    }

    if (event.direction === 'exit' && openEntry) {
      pushInterval(openEntry, event, event.event_time);
      openEntry = null;
    }
  }

  if (openEntry && workDate === todayStr) {
    pushInterval(openEntry, null, formatTimeValue(new Date()));
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
    const { data, error } = await supabase
      .from('skud_events')
      .select('employee_id, event_date, event_time, access_point, direction')
      .in('employee_id', batch)
      .gte('event_date', startDate)
      .lte('event_date', endDate)
      .order('employee_id', { ascending: true })
      .order('event_date', { ascending: true })
      .order('event_time', { ascending: true });

    if (error) throw error;
    rows.push(...((data || []) as IRawEventRow[]));
  }

  return rows;
};

const fetchObjectMappings = async (): Promise<{
  accessPointToObjectId: Map<string, string>;
  objectNameById: Map<string, string>;
}> => {
  const [mappingsResult, objectsResult] = await Promise.all([
    supabase
      .from('skud_object_access_points')
      .select('object_id, access_point_name'),
    supabase
      .from('skud_objects')
      .select('id, name')
      .eq('is_active', true),
  ]);

  if (mappingsResult.error) {
    if (isMissingTableError(mappingsResult.error)) {
      return { accessPointToObjectId: new Map(), objectNameById: new Map() };
    }
    throw mappingsResult.error;
  }
  if (objectsResult.error) {
    if (isMissingTableError(objectsResult.error)) {
      return { accessPointToObjectId: new Map(), objectNameById: new Map() };
    }
    throw objectsResult.error;
  }

  const accessPointToObjectId = new Map<string, string>();
  for (const row of (mappingsResult.data || []) as ITravelObjectMappingRow[]) {
    const point = normalizeAccessPoint(row.access_point_name);
    if (point) {
      accessPointToObjectId.set(point, row.object_id);
    }
  }

  const objectNameById = new Map<string, string>();
  for (const row of (objectsResult.data || []) as ITravelObjectRow[]) {
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
  base_hours_worked: roundHours(entry.base_minutes / 60),
  is_correction: entry.is_correction,
  notes: entry.notes ?? null,
});

export async function buildObjectAttendanceData(params: {
  employeeIds: number[];
  startDate: string;
  endDate: string;
  todayStr?: string;
  adjustments: IObjectAdjustmentSource[];
}): Promise<{
  objectEntries: IAttendanceObjectEntry[];
  objectEntriesByEmployeeDate: Map<number, Map<string, IAttendanceObjectEntry[]>>;
  employeeDistinctObjectKeys: Map<number, Set<string>>;
  legacyBlockedDays: Map<string, string>;
  rawFallbackSummaries: Map<number, Map<string, IRawFallbackSummary>>;
}> {
  const { employeeIds, startDate, endDate, adjustments } = params;
  const todayStr = params.todayStr ?? formatDateToISO(new Date());
  if (employeeIds.length === 0) {
    return {
      objectEntries: [],
      objectEntriesByEmployeeDate: new Map(),
      employeeDistinctObjectKeys: new Map(),
      legacyBlockedDays: new Map(),
      rawFallbackSummaries: new Map(),
    };
  }

  const [internalPoints, objectMappings, rawEvents] = await Promise.all([
    getNormalizedInternalPoints(),
    fetchObjectMappings(),
    fetchRawEvents({ employeeIds, startDate, endDate }),
  ]);

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

  const legacyBlockedDays = new Map<string, string>();
  for (const adjustment of dailyAdjustments) {
    const key = dayKey(adjustment.employee_id, adjustment.work_date);
    const distinctObjects = baseDistinctObjectKeys.get(key);
    if (distinctObjects && distinctObjects.size > 1) {
      legacyBlockedDays.set(key, LEGACY_OBJECT_DETAIL_MESSAGE);
    }
  }

  const objectEntries: IAttendanceObjectEntry[] = [];
  const objectEntriesByEmployeeDate = new Map<number, Map<string, IAttendanceObjectEntry[]>>();
  const employeeDistinctObjectKeys = new Map<number, Set<string>>();

  for (const entry of [...baseObjectEntries.values()]
    .filter(item => !legacyBlockedDays.has(dayKey(item.employee_id, item.work_date))))
  {
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
