import { supabase } from '../config/database.js';
import type { IProductionCalendarMonth, IResolvedSchedule, TimeStatus } from '../types/index.js';
import { getTravelHoursSummaryForRange, travelMinutesToHours } from './skud-travel.service.js';
import { getScheduleForDate, isWorkingDay, needsSkudCheck } from './schedule.service.js';

const ADJUSTMENT_PRIORITY: Record<string, number> = {
  manual: 300,
  leave_request: 200,
  legacy_tender_timesheet: 100,
};

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
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
}

export interface IAttendanceEntry {
  id: number | null;
  employee_id: number;
  work_date: string;
  status: TimeStatus;
  hours_worked: number | null;
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
}

export interface IAttendanceBuildResult {
  entries: IAttendanceEntry[];
  byEmployeeDate: Map<number, Map<string, IAttendanceEntry>>;
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

function getSummaryHours(summary: ISummaryRow): number {
  if (typeof summary.total_minutes === 'number') {
    return roundHours(summary.total_minutes / 60);
  }
  return roundHours(summary.total_hours || 0);
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
      .select('id, employee_id, work_date, status, hours_override, source_type, source_id, reason, created_by, created_at, updated_at, metadata')
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
        created_at: String(row.created_at),
        updated_at: String(row.updated_at ?? row.created_at),
        metadata: (row.metadata && typeof row.metadata === 'object' ? row.metadata : {}) as Record<string, unknown>,
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
}): Promise<IAttendanceBuildResult> {
  const { employees, startDate, endDate, dailySchedulesMap, calendarMonth } = params;
  const todayStr = params.todayStr ?? new Date().toISOString().slice(0, 10);
  const employeeIds = employees.map((employee) => employee.id);

  const [summaries, adjustments, travelSummaries] = await Promise.all([
    loadDailySummaries(employeeIds, startDate, endDate),
    loadAttendanceAdjustments(employeeIds, startDate, endDate),
    getTravelHoursSummaryForRange({ employeeIds, startDate, endDate }),
  ]);

  const { userNames, legacyEmployeeNames } = await loadAdjustmentNames(adjustments);
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

  const sortedAdjustments = [...adjustments].sort((left, right) => {
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
    const travelMinutes = travelSummary?.creditedMinutes || 0;
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
      base_hours_worked: adjustment.hours_override,
      travel_minutes_credited: travelMinutes,
      travel_hours_credited: travelMinutesToHours(travelMinutes),
      travel_delay_minutes: travelSummary?.delayMinutes || 0,
      travel_segments_count: travelSummary?.segmentsCount || 0,
      travel_problematic_segments: travelSummary?.problematicSegmentsCount || 0,
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
    const travelMinutes = travelSummary?.creditedMinutes || 0;
    const baseHours = getSummaryHours(summary);
    const travelHours = travelMinutesToHours(travelMinutes);
    const hoursWorked = roundHours(baseHours + travelHours);
    const isPresent = baseHours > 0 || summary.first_entry !== null || travelMinutes > 0;

    pushEntry({
      id: null,
      employee_id: summary.employee_id,
      work_date: summary.date,
      status: isPresent ? 'work' : 'absent',
      hours_worked: isPresent ? hoursWorked : 0,
      base_hours_worked: baseHours,
      travel_minutes_credited: travelMinutes,
      travel_hours_credited: travelHours,
      travel_delay_minutes: travelSummary?.delayMinutes || 0,
      travel_segments_count: travelSummary?.segmentsCount || 0,
      travel_problematic_segments: travelSummary?.problematicSegmentsCount || 0,
      is_correction: false,
      first_entry: summary.first_entry,
      last_exit: summary.last_exit,
    });
  }

  const [year, month] = startDate.split('-').map(Number);
  const daysInRange = new Date(year, month, 0).getDate();

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
      if (needsSkudCheck(schedule, dateObject, calendarMonth)) continue;

      const plannedHours = getScheduleForDate(schedule, dateObject).work_hours;
      pushEntry({
        id: null,
        employee_id: employee.id,
        work_date: workDate,
        status: 'remote',
        hours_worked: plannedHours,
        base_hours_worked: plannedHours,
        travel_minutes_credited: 0,
        travel_hours_credited: 0,
        travel_delay_minutes: 0,
        travel_segments_count: 0,
        travel_problematic_segments: 0,
        is_correction: false,
        first_entry: null,
        last_exit: null,
      });
    }
  }

  entries.sort((left, right) => {
    if (left.employee_id !== right.employee_id) return left.employee_id - right.employee_id;
    return left.work_date.localeCompare(right.work_date);
  });

  return { entries, byEmployeeDate, skudMap };
}

export async function upsertAttendanceAdjustment(input: {
  employee_id: number;
  work_date: string;
  status: TimeStatus;
  hours_override?: number | null;
  source_type: string;
  source_id?: string;
  reason?: string | null;
  created_by?: string | null;
}): Promise<Record<string, unknown>> {
  const payload = {
    employee_id: input.employee_id,
    work_date: input.work_date,
    status: input.status,
    hours_override: input.hours_override ?? null,
    source_type: input.source_type,
    source_id: input.source_id ?? input.source_type,
    reason: input.reason ?? null,
    created_by: input.created_by ?? null,
    updated_at: new Date().toISOString(),
  };

  const result = await supabase
    .from('attendance_adjustments')
    .upsert(payload, { onConflict: 'employee_id,work_date,source_type,source_id' })
    .select('*')
    .single();

  if (result.error) throw result.error;

  return result.data as Record<string, unknown>;
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
  patch: Partial<Pick<IAttendanceAdjustment, 'status' | 'hours_override' | 'reason'>> & { created_by?: string | null },
): Promise<Record<string, unknown> | null> {
  const updates = {
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.hours_override !== undefined ? { hours_override: patch.hours_override } : {}),
    ...(patch.reason !== undefined ? { reason: patch.reason } : {}),
    ...(patch.created_by !== undefined ? { created_by: patch.created_by } : {}),
    updated_at: new Date().toISOString(),
  };

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
