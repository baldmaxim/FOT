import { supabase } from '../config/database.js';
import type { IProductionCalendarMonth, IResolvedSchedule, TimeStatus } from '../types/index.js';
import { getTravelHoursSummaryForRange } from './skud-travel.service.js';
import { getScheduleForDate, isWorkingDay, needsSkudCheck } from './schedule.service.js';
import { formatDateToISO } from '../utils/date.utils.js';
import {
  buildObjectAttendanceData,
  OBJECT_ADJUSTMENT_SOURCE_TYPE,
  type IAttendanceObjectEntry,
} from './timesheet-object.service.js';

const ADJUSTMENT_PRIORITY: Record<string, number> = {
  manual: 300,
  leave_request: 200,
  legacy_tender_timesheet: 100,
};

const NON_WORK_ADJUSTMENT_STATUSES = new Set<TimeStatus>([
  'absent', 'sick', 'vacation', 'dayoff', 'unpaid', 'educational_leave', 'remote',
]);

const BATCH_SIZE = 500;

export interface IAttendanceEmployee {
  id: number;
  full_name?: string | null;
  work_category?: string | null;
}

export interface IAttendanceAdjustment {
  id: number;
  employee_id: number;
  work_date: string;
  status: TimeStatus;
  hours_override: number | null;
  source_type: string;
  source_id: string;
  reason: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
  approval_status: 'auto_approved' | 'pending' | 'approved' | 'rejected';
  approval_comment: string | null;
  approved_by: string | null;
  approved_at: string | null;
}

export interface IAttendanceAdjustmentWithAuthor extends IAttendanceAdjustment {
  employee_full_name: string | null;
  author_name: string | null;
}

export interface IAttendanceEntry {
  id: number | null;
  employee_id: number;
  work_date: string;
  status: TimeStatus;
  hours_worked: number | null;
  display_hours_worked: number | null;
  base_hours_worked: number | null;
  travel_minutes_credited: number;
  travel_hours_credited: number;
  travel_delay_minutes: number;
  travel_segments_count: number;
  travel_problematic_segments: number;
  is_correction: boolean;
  reason?: string | null;
  notes?: string | null;
  first_entry?: string | null;
  last_exit?: string | null;
  corrected_at?: string | null;
  corrected_by_name?: string | null;
  corrected_by?: number | null;
  created_at?: string;
  updated_at?: string;
  object_detail_mode?: 'none' | 'available' | 'legacy_blocked';
  object_detail_message?: string | null;
  object_detail_count?: number;
  presence_covers_shift?: boolean;
}

export interface IAttendanceBuildResult {
  entries: IAttendanceEntry[];
  objectEntries: IAttendanceObjectEntry[];
  byEmployeeDate: Map<number, Map<string, IAttendanceEntry>>;
  objectEntriesByEmployeeDate: Map<number, Map<string, IAttendanceObjectEntry[]>>;
  skudMap: Map<number, Map<string, { hours: number; corrected: boolean }>>;
}

interface ISummaryRow {
  employee_id: number;
  date: string;
  first_entry: string | null;
  last_exit: string | null;
  total_hours: number | null;
  total_minutes?: number | null;
}

function roundHours(value: number): number {
  return Math.round(value * 100) / 100;
}

function clampToScheduleHours(value: number, plannedHours: number): number {
  return roundHours(Math.max(0, Math.min(value, plannedHours)));
}

function getPlannedHoursForScheduleOnDate(
  schedule: IResolvedSchedule | null | undefined,
  workDate: string,
): number | null {
  if (!schedule) return null;
  const [yearPart, monthPart, dayPart] = workDate.split('-').map(Number);
  return getScheduleForDate(schedule, new Date(yearPart, monthPart - 1, dayPart)).work_hours;
}

function getSummaryHours(summary: ISummaryRow): number {
  if (typeof summary.total_minutes === 'number') {
    return roundHours(summary.total_minutes / 60);
  }
  return roundHours(summary.total_hours || 0);
}

function getSummaryMinutes(summary: ISummaryRow): number {
  if (typeof summary.total_minutes === 'number') return summary.total_minutes;
  return Math.round((summary.total_hours || 0) * 60);
}

function parseTimeToSeconds(value: string): number {
  const [hours, minutes, seconds = 0] = value.split(':').map(Number);
  return hours * 3600 + minutes * 60 + (seconds || 0);
}

function formatNowHMS(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

function computePresenceCoversShift(params: {
  firstEntry: string | null;
  lastExit: string | null;
  totalMinutes: number;
  plannedHours: number;
  lunchMinutes: number;
  workDate: string;
  todayStr: string;
  nowHMS: string;
}): boolean {
  const { firstEntry, lastExit, totalMinutes, plannedHours, lunchMinutes, workDate, todayStr, nowHMS } = params;
  if (!firstEntry) return false;
  const firstSec = parseTimeToSeconds(firstEntry);
  const lastSec = lastExit
    ? parseTimeToSeconds(lastExit)
    : (workDate === todayStr ? parseTimeToSeconds(nowHMS) : null);
  if (lastSec === null) return false;
  const spanSec = Math.max(0, lastSec - firstSec);
  const workSec = totalMinutes * 60;
  const gapsSec = Math.max(0, spanSec - workSec);
  return spanSec >= plannedHours * 3600 && gapsSec <= lunchMinutes * 60;
}

function getAdjustmentPriority(sourceType: string): number {
  return ADJUSTMENT_PRIORITY[sourceType] ?? 0;
}

function extractLegacyCorrectorId(metadata: Record<string, unknown>): number | null {
  const raw = metadata.legacy_corrected_by;
  return typeof raw === 'number' && Number.isInteger(raw) ? raw : null;
}

export async function loadAttendanceAdjustments(
  employeeIds: number[],
  startDate: string,
  endDate: string,
): Promise<IAttendanceAdjustment[]> {
  if (employeeIds.length === 0) return [];

  const adjustments: IAttendanceAdjustment[] = [];

  for (let index = 0; index < employeeIds.length; index += BATCH_SIZE) {
    const batch = employeeIds.slice(index, index + BATCH_SIZE);
    const { data, error } = await supabase
      .from('attendance_adjustments')
      .select('id, employee_id, work_date, status, hours_override, source_type, source_id, reason, created_by, updated_by, created_at, updated_at, metadata, approval_status, approval_comment, approved_by, approved_at')
      .in('employee_id', batch)
      .gte('work_date', startDate)
      .lte('work_date', endDate);

    if (error) throw error;

    adjustments.push(
      ...((data || []).map((row) => ({
        id: Number(row.id),
        employee_id: Number(row.employee_id),
        work_date: String(row.work_date),
        status: String(row.status) as TimeStatus,
        hours_override: typeof row.hours_override === 'number' ? row.hours_override : null,
        source_type: String(row.source_type),
        source_id: String(row.source_id ?? ''),
        reason: typeof row.reason === 'string' ? row.reason : null,
        created_by: typeof row.created_by === 'string' ? row.created_by : null,
        updated_by: typeof row.updated_by === 'string' ? row.updated_by : null,
        created_at: String(row.created_at),
        updated_at: String(row.updated_at ?? row.created_at),
        metadata: (row.metadata && typeof row.metadata === 'object' ? row.metadata : {}) as Record<string, unknown>,
        approval_status: (typeof row.approval_status === 'string' ? row.approval_status : 'auto_approved') as IAttendanceAdjustment['approval_status'],
        approval_comment: typeof row.approval_comment === 'string' ? row.approval_comment : null,
        approved_by: typeof row.approved_by === 'string' ? row.approved_by : null,
        approved_at: typeof row.approved_at === 'string' ? row.approved_at : null,
      })) satisfies IAttendanceAdjustment[]),
    );
  }

  return adjustments;
}

async function loadAdjustmentNames(adjustments: IAttendanceAdjustment[]): Promise<{
  userNames: Map<string, string>;
  legacyEmployeeNames: Map<number, string>;
}> {
  const userIds = [...new Set(adjustments.map((item) => item.created_by).filter((id): id is string => Boolean(id)))];
  const legacyEmployeeIds = [...new Set(adjustments.map((item) => extractLegacyCorrectorId(item.metadata)).filter((id): id is number => id != null))];

  const [usersRes, employeesRes] = await Promise.all([
    userIds.length > 0
      ? supabase.from('user_profiles').select('id, full_name').in('id', userIds)
      : Promise.resolve({ data: [], error: null }),
    legacyEmployeeIds.length > 0
      ? supabase.from('employees').select('id, full_name').in('id', legacyEmployeeIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (usersRes.error) throw usersRes.error;
  if (employeesRes.error) throw employeesRes.error;

  return {
    userNames: new Map((usersRes.data || []).map((row) => [String(row.id), String(row.full_name || '')])),
    legacyEmployeeNames: new Map((employeesRes.data || []).map((row) => [Number(row.id), String(row.full_name || '')])),
  };
}

async function loadDailySummaries(
  employeeIds: number[],
  startDate: string,
  endDate: string,
): Promise<ISummaryRow[]> {
  if (employeeIds.length === 0) return [];

  const rows: ISummaryRow[] = [];
  for (let index = 0; index < employeeIds.length; index += BATCH_SIZE) {
    const batch = employeeIds.slice(index, index + BATCH_SIZE);
    const { data, error } = await supabase
      .from('skud_daily_summary')
      .select('employee_id, date, first_entry, last_exit, total_hours, total_minutes')
      .in('employee_id', batch)
      .gte('date', startDate)
      .lte('date', endDate)
      .order('date', { ascending: true });

    if (error) throw error;
    rows.push(...((data || []) as ISummaryRow[]));
  }

  return rows;
}

export async function buildAttendanceEntries(params: {
  employees: IAttendanceEmployee[];
  startDate: string;
  endDate: string;
  dailySchedulesMap: Map<number, Map<string, IResolvedSchedule>>;
  calendarMonth: IProductionCalendarMonth | null;
  todayStr?: string;
  displayMode?: 'actual' | 'capped_to_schedule';
}): Promise<IAttendanceBuildResult> {
  const { employees, startDate, endDate, dailySchedulesMap, calendarMonth } = params;
  const todayStr = params.todayStr ?? formatDateToISO(new Date());
  const displayMode = params.displayMode ?? 'actual';
  const nowHMS = formatNowHMS(new Date());
  const employeeIds = employees.map((employee) => employee.id);

  const [summaries, adjustments, travelSummaries] = await Promise.all([
    loadDailySummaries(employeeIds, startDate, endDate),
    loadAttendanceAdjustments(employeeIds, startDate, endDate),
    getTravelHoursSummaryForRange({ employeeIds, startDate, endDate }),
  ]);

  const objectAttendanceData = await buildObjectAttendanceData({
    employeeIds,
    startDate,
    endDate,
    todayStr,
    adjustments,
  });
  const dailyAdjustments = adjustments.filter(adjustment => adjustment.source_type !== OBJECT_ADJUSTMENT_SOURCE_TYPE);
  const { userNames, legacyEmployeeNames } = await loadAdjustmentNames(dailyAdjustments);
  const entries: IAttendanceEntry[] = [];
  const byEmployeeDate = new Map<number, Map<string, IAttendanceEntry>>();
  const skudMap = new Map<number, Map<string, { hours: number; corrected: boolean }>>();

  const pushEntry = (entry: IAttendanceEntry): void => {
    entries.push(entry);
    if (!byEmployeeDate.has(entry.employee_id)) {
      byEmployeeDate.set(entry.employee_id, new Map());
    }
    byEmployeeDate.get(entry.employee_id)!.set(entry.work_date, entry);
  };

  for (const summary of summaries) {
    const hours = getSummaryHours(summary);
    if (!skudMap.has(summary.employee_id)) {
      skudMap.set(summary.employee_id, new Map());
    }
    skudMap.get(summary.employee_id)!.set(summary.date, { hours, corrected: false });
  }

  const sortedAdjustments = [...dailyAdjustments].sort((left, right) => {
    const priorityDiff = getAdjustmentPriority(right.source_type) - getAdjustmentPriority(left.source_type);
    if (priorityDiff !== 0) return priorityDiff;
    return new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime();
  });

  for (const adjustment of sortedAdjustments) {
    const key = `${adjustment.employee_id}_${adjustment.work_date}`;
    if (byEmployeeDate.get(adjustment.employee_id)?.has(adjustment.work_date)) {
      continue;
    }

    const travelSummary = travelSummaries.get(key);
    const legacyCorrectedBy = extractLegacyCorrectorId(adjustment.metadata);
    const correctedByName = adjustment.created_by
      ? userNames.get(adjustment.created_by) || null
      : (legacyCorrectedBy ? legacyEmployeeNames.get(legacyCorrectedBy) || null : null);

    const existingSkud = skudMap.get(adjustment.employee_id)?.get(adjustment.work_date);
    if (existingSkud) {
      existingSkud.corrected = true;
    }

    pushEntry({
      id: adjustment.id,
      employee_id: adjustment.employee_id,
      work_date: adjustment.work_date,
      status: adjustment.status,
      hours_worked: adjustment.hours_override,
      display_hours_worked: adjustment.hours_override,
      base_hours_worked: adjustment.hours_override,
      travel_minutes_credited: 0,
      travel_hours_credited: 0,
      travel_delay_minutes: travelSummary?.delayMinutes || 0,
      travel_segments_count: travelSummary?.segmentsCount || 0,
      travel_problematic_segments: travelSummary?.objectProblemSegmentsCount || 0,
      is_correction: true,
      reason: adjustment.reason,
      notes: adjustment.reason,
      corrected_at: adjustment.updated_at ?? adjustment.created_at,
      corrected_by_name: correctedByName,
      corrected_by: legacyCorrectedBy,
      created_at: adjustment.created_at,
      updated_at: adjustment.updated_at,
    });
  }

  for (const summary of summaries) {
    if (byEmployeeDate.get(summary.employee_id)?.has(summary.date)) continue;

    const key = `${summary.employee_id}_${summary.date}`;
    const travelSummary = travelSummaries.get(key);
    const baseHours = getSummaryHours(summary);
    const hoursWorked = roundHours(baseHours);
    const isPresent = baseHours > 0 || summary.first_entry !== null;

    const schedule = dailySchedulesMap.get(summary.employee_id)?.get(summary.date);
    let presenceCoversShift: boolean | undefined;
    if (!isPresent) {
      presenceCoversShift = false;
    } else if (schedule) {
      const [yearPart, monthPart, dayPart] = summary.date.split('-').map(Number);
      const dateObject = new Date(yearPart, monthPart - 1, dayPart);
      const plannedHours = getScheduleForDate(schedule, dateObject).work_hours;
      presenceCoversShift = computePresenceCoversShift({
        firstEntry: summary.first_entry,
        lastExit: summary.last_exit,
        totalMinutes: getSummaryMinutes(summary),
        plannedHours,
        lunchMinutes: schedule.lunch_minutes || 0,
        workDate: summary.date,
        todayStr,
        nowHMS,
      });
    }

    pushEntry({
      id: null,
      employee_id: summary.employee_id,
      work_date: summary.date,
      status: isPresent ? 'work' : 'absent',
      hours_worked: isPresent ? hoursWorked : 0,
      display_hours_worked: isPresent ? hoursWorked : 0,
      base_hours_worked: baseHours,
      travel_minutes_credited: 0,
      travel_hours_credited: 0,
      travel_delay_minutes: travelSummary?.delayMinutes || 0,
      travel_segments_count: travelSummary?.segmentsCount || 0,
      travel_problematic_segments: travelSummary?.objectProblemSegmentsCount || 0,
      is_correction: false,
      first_entry: summary.first_entry,
      last_exit: summary.last_exit,
      presence_covers_shift: presenceCoversShift,
    });
  }

  const [year, month] = startDate.split('-').map(Number);
  const daysInRange = new Date(year, month, 0).getDate();
  const rawFallbackSummaries = objectAttendanceData.rawFallbackSummaries;

  for (const employee of employees) {
    for (let day = 1; day <= daysInRange; day++) {
      const workDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (workDate < startDate || workDate > endDate) continue;
      if (workDate > todayStr) continue;
      if (byEmployeeDate.get(employee.id)?.has(workDate)) continue;

      const schedule = dailySchedulesMap.get(employee.id)?.get(workDate);
      if (!schedule) continue;

      const dateObject = new Date(year, month - 1, day);
      if (!isWorkingDay(schedule, dateObject, calendarMonth)) continue;

      const key = `${employee.id}_${workDate}`;
      const travelSummary = travelSummaries.get(key);

      if (needsSkudCheck(schedule, dateObject, calendarMonth)) {
        const rawSummary = rawFallbackSummaries.get(employee.id)?.get(workDate) || null;

        if (rawSummary) {
          const plannedHours = getScheduleForDate(schedule, dateObject).work_hours;
          const baseHours = getSummaryHours(rawSummary);
          const hoursWorked = roundHours(Math.min(baseHours, plannedHours));
          const isPresent = baseHours > 0 || rawSummary.first_entry !== null;

          if (!skudMap.has(employee.id)) {
            skudMap.set(employee.id, new Map());
          }
          skudMap.get(employee.id)!.set(workDate, { hours: hoursWorked, corrected: false });

          const presenceCoversShift = isPresent
            ? computePresenceCoversShift({
              firstEntry: rawSummary.first_entry,
              lastExit: rawSummary.last_exit,
              totalMinutes: getSummaryMinutes(rawSummary),
              plannedHours,
              lunchMinutes: schedule.lunch_minutes || 0,
              workDate,
              todayStr,
              nowHMS,
            })
            : false;

          pushEntry({
            id: null,
            employee_id: employee.id,
            work_date: workDate,
            status: isPresent ? 'work' : 'absent',
            hours_worked: isPresent ? hoursWorked : 0,
            display_hours_worked: isPresent ? hoursWorked : 0,
            base_hours_worked: baseHours,
            travel_minutes_credited: 0,
            travel_hours_credited: 0,
            travel_delay_minutes: travelSummary?.delayMinutes || 0,
            travel_segments_count: travelSummary?.segmentsCount || 0,
            travel_problematic_segments: travelSummary?.objectProblemSegmentsCount || 0,
            is_correction: false,
            first_entry: rawSummary.first_entry,
            last_exit: rawSummary.last_exit,
            presence_covers_shift: presenceCoversShift,
          });
        } else {
          pushEntry({
            id: null,
            employee_id: employee.id,
            work_date: workDate,
            status: 'absent',
            hours_worked: 0,
            display_hours_worked: 0,
            base_hours_worked: 0,
            travel_minutes_credited: 0,
            travel_hours_credited: 0,
            travel_delay_minutes: travelSummary?.delayMinutes || 0,
            travel_segments_count: travelSummary?.segmentsCount || 0,
            travel_problematic_segments: travelSummary?.objectProblemSegmentsCount || 0,
            is_correction: false,
            first_entry: null,
            last_exit: null,
            presence_covers_shift: false,
          });
        }
        continue;
      }

      const plannedHours = getScheduleForDate(schedule, dateObject).work_hours;
      pushEntry({
        id: null,
        employee_id: employee.id,
        work_date: workDate,
        status: 'remote',
        hours_worked: plannedHours,
        display_hours_worked: plannedHours,
        base_hours_worked: plannedHours,
        travel_minutes_credited: 0,
        travel_hours_credited: 0,
        travel_delay_minutes: travelSummary?.delayMinutes || 0,
        travel_segments_count: travelSummary?.segmentsCount || 0,
        travel_problematic_segments: travelSummary?.objectProblemSegmentsCount || 0,
        is_correction: false,
        first_entry: null,
        last_exit: null,
        presence_covers_shift: true,
      });
    }
  }

  const employeesWithMultiObjects = new Set<number>(
    [...objectAttendanceData.employeeDistinctObjectKeys.entries()]
      .filter(([, objectKeys]) => objectKeys.size > 1)
      .map(([employeeId]) => employeeId),
  );

  for (const entry of entries) {
    const dayObjectEntries = objectAttendanceData.objectEntriesByEmployeeDate
      .get(entry.employee_id)
      ?.get(entry.work_date) || [];
    const legacyMessage = objectAttendanceData.legacyBlockedDays.get(`${entry.employee_id}_${entry.work_date}`) || null;

    if (legacyMessage) {
      entry.object_detail_mode = 'legacy_blocked';
      entry.object_detail_message = legacyMessage;
      entry.object_detail_count = 0;
      continue;
    }

    if (dayObjectEntries.length === 0) {
      entry.object_detail_mode = 'none';
      entry.object_detail_message = null;
      entry.object_detail_count = 0;
      continue;
    }

    if (entry.is_correction && NON_WORK_ADJUSTMENT_STATUSES.has(entry.status)) {
      entry.object_detail_mode = employeesWithMultiObjects.has(entry.employee_id) ? 'available' : 'none';
      entry.object_detail_message = null;
      entry.object_detail_count = employeesWithMultiObjects.has(entry.employee_id) ? dayObjectEntries.length : 0;
      continue;
    }

    const totalHours = roundHours(dayObjectEntries.reduce((sum, item) => sum + item.hours_worked, 0));
    const totalBaseHours = roundHours(dayObjectEntries.reduce((sum, item) => sum + item.base_hours_worked, 0));
    entry.status = totalHours > 0 || entry.first_entry ? 'work' : entry.status;
    entry.hours_worked = totalHours;
    entry.display_hours_worked = totalHours;
    entry.base_hours_worked = totalBaseHours;
    entry.is_correction = entry.is_correction || dayObjectEntries.some(item => item.is_correction);
    entry.object_detail_mode = employeesWithMultiObjects.has(entry.employee_id) ? 'available' : 'none';
    entry.object_detail_message = null;
    entry.object_detail_count = employeesWithMultiObjects.has(entry.employee_id) ? dayObjectEntries.length : 0;
  }

  if (displayMode === 'capped_to_schedule') {
    for (const entry of entries) {
      const dayObjectEntries = objectAttendanceData.objectEntriesByEmployeeDate
        .get(entry.employee_id)
        ?.get(entry.work_date) || [];

      const employeeSchedule = dailySchedulesMap.get(entry.employee_id)?.get(entry.work_date);
      const plannedDayHours = getPlannedHoursForScheduleOnDate(employeeSchedule, entry.work_date);

      if (dayObjectEntries.length > 0) {
        const totalActualHours = roundHours(
          dayObjectEntries.reduce((sum, item) => sum + item.hours_worked, 0),
        );

        if (plannedDayHours != null && totalActualHours > plannedDayHours) {
          const scale = plannedDayHours / totalActualHours;
          let allocated = 0;
          dayObjectEntries.forEach((item, idx) => {
            const isLast = idx === dayObjectEntries.length - 1;
            const share = isLast
              ? roundHours(plannedDayHours - allocated)
              : roundHours(item.hours_worked * scale);
            item.display_hours_worked = share;
            item.hours_worked = share;
            item.base_hours_worked = share;
            allocated = roundHours(allocated + share);
          });
          entry.display_hours_worked = plannedDayHours;
        } else {
          for (const item of dayObjectEntries) {
            item.display_hours_worked = item.hours_worked;
            item.base_hours_worked = item.hours_worked;
          }
          entry.display_hours_worked = totalActualHours;
        }
      } else {
        entry.display_hours_worked = entry.hours_worked == null || plannedDayHours == null
          ? entry.hours_worked
          : clampToScheduleHours(entry.hours_worked, plannedDayHours);
      }

      entry.hours_worked = entry.display_hours_worked;
      entry.base_hours_worked = entry.display_hours_worked;
      entry.first_entry = null;
      entry.last_exit = null;
    }
  }

  entries.sort((left, right) => {
    if (left.employee_id !== right.employee_id) return left.employee_id - right.employee_id;
    return left.work_date.localeCompare(right.work_date);
  });

  return {
    entries,
    objectEntries: objectAttendanceData.objectEntries,
    byEmployeeDate,
    objectEntriesByEmployeeDate: objectAttendanceData.objectEntriesByEmployeeDate,
    skudMap,
  };
}

export type AdjustmentApprovalStatus = 'auto_approved' | 'pending' | 'approved' | 'rejected';

export async function upsertAttendanceAdjustment(input: {
  employee_id: number;
  work_date: string;
  status: TimeStatus;
  hours_override?: number | null;
  source_type: string;
  source_id?: string;
  reason?: string | null;
  created_by?: string | null;
  updated_by?: string | null;
  metadata?: Record<string, unknown>;
  approval_status?: AdjustmentApprovalStatus;
}): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = {
    employee_id: input.employee_id,
    work_date: input.work_date,
    status: input.status,
    hours_override: input.hours_override ?? null,
    source_type: input.source_type,
    source_id: input.source_id ?? input.source_type,
    reason: input.reason ?? null,
    created_by: input.created_by ?? null,
    updated_by: input.updated_by ?? input.created_by ?? null,
    metadata: input.metadata ?? {},
    updated_at: new Date().toISOString(),
  };
  if (input.approval_status) {
    payload.approval_status = input.approval_status;
    if (input.approval_status !== 'approved' && input.approval_status !== 'rejected') {
      payload.approved_by = null;
      payload.approved_at = null;
      payload.approval_comment = null;
    }
  }

  const result = await supabase
    .from('attendance_adjustments')
    .upsert(payload, { onConflict: 'employee_id,work_date,source_type,source_id' })
    .select('*')
    .single();

  if (result.error) throw result.error;

  return result.data as Record<string, unknown>;
}

export async function deleteAttendanceAdjustmentBySource(input: {
  employee_id: number;
  work_date: string;
  source_type: string;
  source_id: string;
}): Promise<void> {
  const result = await supabase
    .from('attendance_adjustments')
    .delete()
    .eq('employee_id', input.employee_id)
    .eq('work_date', input.work_date)
    .eq('source_type', input.source_type)
    .eq('source_id', input.source_id);

  if (result.error) throw result.error;
}

export async function getAttendanceAdjustmentById(id: number): Promise<Record<string, unknown> | null> {
  const result = await supabase
    .from('attendance_adjustments')
    .select('*')
    .eq('id', id)
    .single();

  if (result.error) {
    if (result.error.code === 'PGRST116') return null;
    throw result.error;
  }

  return result.data as Record<string, unknown>;
}

export async function updateAttendanceAdjustmentById(
  id: number,
  patch: Partial<Pick<IAttendanceAdjustment, 'status' | 'hours_override' | 'reason'>> & {
    created_by?: string | null;
    updated_by?: string | null;
    approval_status?: AdjustmentApprovalStatus;
  },
): Promise<Record<string, unknown> | null> {
  const updates: Record<string, unknown> = {
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.hours_override !== undefined ? { hours_override: patch.hours_override } : {}),
    ...(patch.reason !== undefined ? { reason: patch.reason } : {}),
    ...(patch.created_by !== undefined ? { created_by: patch.created_by } : {}),
    ...(patch.updated_by !== undefined ? { updated_by: patch.updated_by } : {}),
    updated_at: new Date().toISOString(),
  };
  if (patch.approval_status) {
    updates.approval_status = patch.approval_status;
    if (patch.approval_status !== 'approved' && patch.approval_status !== 'rejected') {
      updates.approved_by = null;
      updates.approved_at = null;
      updates.approval_comment = null;
    }
  }

  const result = await supabase
    .from('attendance_adjustments')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();

  if (result.error) {
    if (result.error.code === 'PGRST116') return null;
    throw result.error;
  }

  return result.data as Record<string, unknown>;
}

export async function deleteAttendanceAdjustmentById(id: number): Promise<boolean> {
  const result = await supabase
    .from('attendance_adjustments')
    .delete()
    .eq('id', id)
    .select('id')
    .maybeSingle();

  if (result.error) throw result.error;
  return Boolean(result.data);
}

export async function loadAttendanceAdjustmentsWithAuthors(
  employeeIds: number[],
  startDate: string,
  endDate: string,
): Promise<IAttendanceAdjustmentWithAuthor[]> {
  if (employeeIds.length === 0) return [];

  const adjustments = await loadAttendanceAdjustments(employeeIds, startDate, endDate);
  const manualAdjustments = adjustments.filter((item) => item.source_type !== OBJECT_ADJUSTMENT_SOURCE_TYPE);
  if (manualAdjustments.length === 0) return [];

  const authorIds = [...new Set(
    manualAdjustments
      .flatMap((item) => [item.updated_by, item.created_by])
      .filter((id): id is string => Boolean(id)),
  )];

  const employeeIdsPresent = [...new Set(manualAdjustments.map((item) => item.employee_id))];

  const [authorsRes, employeesRes] = await Promise.all([
    authorIds.length > 0
      ? supabase.from('user_profiles').select('id, full_name').in('id', authorIds)
      : Promise.resolve({ data: [], error: null }),
    employeeIdsPresent.length > 0
      ? supabase.from('employees').select('id, full_name').in('id', employeeIdsPresent)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (authorsRes.error) throw authorsRes.error;
  if (employeesRes.error) throw employeesRes.error;

  const authorNames = new Map((authorsRes.data || []).map((row) => [String(row.id), String(row.full_name || '')]));
  const employeeNames = new Map((employeesRes.data || []).map((row) => [Number(row.id), String(row.full_name || '')]));

  return manualAdjustments.map((item) => {
    const latestAuthorId = item.updated_by ?? item.created_by;
    return {
      ...item,
      employee_full_name: employeeNames.get(item.employee_id) ?? null,
      author_name: latestAuthorId ? authorNames.get(latestAuthorId) ?? null : null,
    };
  });
}
