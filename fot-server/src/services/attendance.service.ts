import { supabase } from '../config/database.js';
import type { IProductionCalendarMonth, IResolvedSchedule, TimeStatus } from '../types/index.js';
import { getTravelHoursSummaryForRange } from './skud-travel.service.js';
import { getScheduleForDate, getShiftDurationHours, isPreHoliday, isWorkingDay, needsSkudCheck } from './schedule.service.js';
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

// Статусы отсутствия, которые засчитываются как полный рабочий день при пустом hours_override:
// часы берутся из планового графика. Для удалёнки исторически уже работало; теперь то же
// для отпуска/больничного и т.п. — иначе в табеле они показывались как недоработка.
const ABSENCE_STATUSES_AS_WORKED = new Set<TimeStatus>([
  'vacation', 'sick', 'dayoff', 'remote', 'educational_leave', 'unpaid', 'absent',
]);

const BATCH_SIZE = 2000;

// In-memory кэш ФИО авторов корректировок: один админ обычно создаёт сотни
// корректировок, повторно тянуть его имя в каждом GET /timesheet — лишняя работа.
const NAME_CACHE_TTL = 5 * 60_000;
const userNameCache = new Map<string, { name: string; expiresAt: number }>();
const legacyEmployeeNameCache = new Map<number, { name: string; expiresAt: number }>();

function readUserNameCache(ids: string[]): { hits: Map<string, string>; misses: string[] } {
  const hits = new Map<string, string>();
  const misses: string[] = [];
  const now = Date.now();
  for (const id of ids) {
    const cached = userNameCache.get(id);
    if (cached && cached.expiresAt > now) hits.set(id, cached.name);
    else misses.push(id);
  }
  return { hits, misses };
}

function readLegacyEmployeeNameCache(ids: number[]): { hits: Map<number, string>; misses: number[] } {
  const hits = new Map<number, string>();
  const misses: number[] = [];
  const now = Date.now();
  for (const id of ids) {
    const cached = legacyEmployeeNameCache.get(id);
    if (cached && cached.expiresAt > now) hits.set(id, cached.name);
    else misses.push(id);
  }
  return { hits, misses };
}

export interface IAttendanceEmployee {
  id: number;
  full_name?: string | null;
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
  approval_status?: 'auto_approved' | 'pending' | 'approved' | 'rejected' | null;
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

interface IObjectAttendanceData {
  objectEntries: IAttendanceObjectEntry[];
  objectEntriesByEmployeeDate: Map<number, Map<string, IAttendanceObjectEntry[]>>;
  employeeDistinctObjectKeys: Map<number, Set<string>>;
  legacyBlockedDays: Map<string, string>;
  rawFallbackSummaries: Map<number, Map<string, ISummaryRow>>;
}

interface ISummaryRow {
  employee_id: number;
  date: string;
  first_entry: string | null;
  last_exit: string | null;
  total_hours: number | null;
  total_minutes?: number | null;
  break_hours?: number | null;
  break_minutes?: number | null;
}

function roundHours(value: number): number {
  return Math.round(value * 100) / 100;
}

function clampToScheduleHours(value: number, plannedHours: number): number {
  return roundHours(Math.max(0, Math.min(value, plannedHours)));
}

// Длина смены = work_end − work_start (с учётом day_overrides). Отличается от
// work_hours тем, что включает обед: например, при 09:00–18:00 + work_hours=7.5
// возвращает 9 (тогда как work_hours = 7.5). Используется для cap фактических
// часов в табеле руководителя — чтобы реальное присутствие в офисе не обрезалось
// до нормы (раньше показывал 7:30 даже если человек был 9 часов).
function getShiftLengthHoursForScheduleOnDate(
  schedule: IResolvedSchedule | null | undefined,
  workDate: string,
): number | null {
  if (!schedule) return null;
  const [yearPart, monthPart, dayPart] = workDate.split('-').map(Number);
  const day = getScheduleForDate(schedule, new Date(yearPart, monthPart - 1, dayPart));
  return roundHours(getShiftDurationHours(day));
}

function getSummaryBreakMinutes(summary: ISummaryRow): number {
  if (typeof summary.break_minutes === 'number') return summary.break_minutes;
  return Math.round((summary.break_hours || 0) * 60);
}

/**
 * Оплачиваемое время за день: paid = span − max(lunch_quota, time_outside).
 * skud_daily_summary.total_minutes хранит «время в офисе» (= span − break),
 * break_minutes хранит сумму гэпов между парами (= time_outside).
 * Эквивалентная форма: paid = total − max(0, lunch − break).
 *
 * Поведение: обед всегда вычитается. Если человек не выходил (break=0) — штраф = lunch_quota.
 * Если выходил больше lunch_quota — штраф = реальное время вне офиса (его «съел» сам).
 * Если в пределах lunch_quota — штраф = lunch_quota (ровно одна квота).
 */
function computeSummaryPaidMinutes(summary: ISummaryRow, lunchMinutes: number): number {
  const total = typeof summary.total_minutes === 'number'
    ? summary.total_minutes
    : Math.round((summary.total_hours || 0) * 60);
  const outside = getSummaryBreakMinutes(summary);
  const lunch = Math.max(0, lunchMinutes || 0);
  return Math.max(0, total - Math.max(0, lunch - outside));
}

function computeSummaryPaidHours(summary: ISummaryRow, lunchMinutes: number): number {
  return roundHours(computeSummaryPaidMinutes(summary, lunchMinutes) / 60);
}

function createEmptyObjectAttendanceData(): IObjectAttendanceData {
  return {
    objectEntries: [],
    objectEntriesByEmployeeDate: new Map(),
    employeeDistinctObjectKeys: new Map(),
    legacyBlockedDays: new Map(),
    rawFallbackSummaries: new Map(),
  };
}

function buildObjectAdjustmentTotals(
  adjustments: IAttendanceAdjustment[],
): Map<string, { hours: number; count: number; latest: IAttendanceAdjustment }> {
  const totals = new Map<string, { hours: number; count: number; latest: IAttendanceAdjustment }>();
  for (const adjustment of adjustments) {
    if (adjustment.source_type !== OBJECT_ADJUSTMENT_SOURCE_TYPE) continue;
    const key = `${adjustment.employee_id}_${adjustment.work_date}`;
    const current = totals.get(key);
    const hours = Math.max(0, adjustment.hours_override || 0);
    if (!current) {
      totals.set(key, { hours, count: 1, latest: adjustment });
      continue;
    }
    current.hours = roundHours(current.hours + hours);
    current.count += 1;
    if (new Date(adjustment.updated_at).getTime() > new Date(current.latest.updated_at).getTime()) {
      current.latest = adjustment;
    }
  }
  return totals;
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
  shiftDurationHours: number;
  lunchMinutes: number;
  workDate: string;
  todayStr: string;
  nowHMS: string;
}): boolean {
  const { firstEntry, lastExit, totalMinutes, shiftDurationHours, lunchMinutes, workDate, todayStr, nowHMS } = params;
  if (!firstEntry) return false;
  const firstSec = parseTimeToSeconds(firstEntry);
  const lastSec = lastExit
    ? parseTimeToSeconds(lastExit)
    : (workDate === todayStr ? parseTimeToSeconds(nowHMS) : null);
  if (lastSec === null) return false;
  const spanSec = Math.max(0, lastSec - firstSec);
  const workSec = totalMinutes * 60;
  const gapsSec = Math.max(0, spanSec - workSec);
  return spanSec >= shiftDurationHours * 3600 && gapsSec <= lunchMinutes * 60;
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

  // Сначала смотрим в in-memory кэш — большая часть авторов повторяется между вызовами.
  const { hits: userHits, misses: userMisses } = readUserNameCache(userIds);
  const { hits: legacyHits, misses: legacyMisses } = readLegacyEmployeeNameCache(legacyEmployeeIds);

  const [usersRes, employeesRes] = await Promise.all([
    userMisses.length > 0
      ? supabase.from('user_profiles').select('id, full_name').in('id', userMisses)
      : Promise.resolve({ data: [], error: null }),
    legacyMisses.length > 0
      ? supabase.from('employees').select('id, full_name').in('id', legacyMisses)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (usersRes.error) throw usersRes.error;
  if (employeesRes.error) throw employeesRes.error;

  const expiresAt = Date.now() + NAME_CACHE_TTL;
  const userNames = new Map(userHits);
  for (const row of usersRes.data || []) {
    const id = String(row.id);
    const name = String(row.full_name || '');
    userNames.set(id, name);
    userNameCache.set(id, { name, expiresAt });
  }
  const legacyEmployeeNames = new Map(legacyHits);
  for (const row of employeesRes.data || []) {
    const id = Number(row.id);
    const name = String(row.full_name || '');
    legacyEmployeeNames.set(id, name);
    legacyEmployeeNameCache.set(id, { name, expiresAt });
  }

  return { userNames, legacyEmployeeNames };
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
      .select('employee_id, date, first_entry, last_exit, total_hours, total_minutes, break_hours, break_minutes')
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
  includeObjectDetails?: boolean;
}): Promise<IAttendanceBuildResult> {
  const { employees, startDate, endDate, dailySchedulesMap, calendarMonth } = params;
  const todayStr = params.todayStr ?? formatDateToISO(new Date());
  const displayMode = params.displayMode ?? 'actual';
  const includeObjectDetails = params.includeObjectDetails ?? true;
  const nowHMS = formatNowHMS(new Date());
  const employeeIds = employees.map((employee) => employee.id);

  const [summaries, adjustments, travelSummaries] = await Promise.all([
    loadDailySummaries(employeeIds, startDate, endDate),
    loadAttendanceAdjustments(employeeIds, startDate, endDate),
    getTravelHoursSummaryForRange({ employeeIds, startDate, endDate }),
  ]);

  const objectAttendanceData = includeObjectDetails
    ? await buildObjectAttendanceData({
      employeeIds,
      startDate,
      endDate,
      todayStr,
      adjustments,
    })
    : createEmptyObjectAttendanceData();
  const objectAdjustmentTotals = includeObjectDetails
    ? new Map<string, { hours: number; count: number; latest: IAttendanceAdjustment }>()
    : buildObjectAdjustmentTotals(adjustments);
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
    const skudMapSchedule = dailySchedulesMap.get(summary.employee_id)?.get(summary.date);
    const hours = computeSummaryPaidHours(summary, skudMapSchedule?.lunch_minutes || 0);
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

    const adjSchedule = dailySchedulesMap.get(adjustment.employee_id)?.get(adjustment.work_date);
    const [adjY, adjM, adjD] = adjustment.work_date.split('-').map(Number);
    const adjDate = new Date(adjY, adjM - 1, adjD);
    const isAdjWorkingDay = adjSchedule ? isWorkingDay(adjSchedule, adjDate, calendarMonth) : true;

    // Не-присутствие (отпуск/больничный/отгул/удалёнка/обучение/неоплачиваемый/прогул) в выходной
    // или праздник не должно давать часов: иначе при норме 0 любые часы превращаются в переработку.
    let effectiveHours: number | null;
    if (NON_WORK_ADJUSTMENT_STATUSES.has(adjustment.status) && !isAdjWorkingDay) {
      effectiveHours = 0;
    } else if (adjustment.hours_override != null) {
      effectiveHours = adjustment.hours_override;
    } else if (ABSENCE_STATUSES_AS_WORKED.has(adjustment.status) && adjSchedule) {
      effectiveHours = isAdjWorkingDay ? getScheduleForDate(adjSchedule, adjDate).work_hours : 0;
    } else {
      effectiveHours = null;
    }

    pushEntry({
      id: adjustment.id,
      employee_id: adjustment.employee_id,
      work_date: adjustment.work_date,
      status: adjustment.status,
      hours_worked: effectiveHours,
      display_hours_worked: effectiveHours,
      base_hours_worked: effectiveHours,
      // Корректировка от руководителя — авторитетное значение часов; travel в часы не прибавляем,
      // но оставляем delay/problematic для отображения проблемного дня в табеле.
      travel_minutes_credited: 0,
      travel_hours_credited: 0,
      travel_delay_minutes: travelSummary?.delayMinutes || 0,
      travel_segments_count: travelSummary?.segmentsCount || 0,
      travel_problematic_segments: travelSummary?.problematicSegmentsCount || 0,
      is_correction: true,
      reason: adjustment.reason,
      notes: adjustment.reason,
      approval_status: adjustment.approval_status,
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
    const schedule = dailySchedulesMap.get(summary.employee_id)?.get(summary.date);
    const baseHours = computeSummaryPaidHours(summary, schedule?.lunch_minutes || 0);
    const travelCreditedMinutes = travelSummary?.creditedMinutes || 0;
    const travelCreditedHours = roundHours(travelCreditedMinutes / 60);
    const hoursWorked = roundHours(baseHours + travelCreditedHours);
    const isPresent = baseHours > 0 || summary.first_entry !== null;
    let presenceCoversShift: boolean | undefined;
    if (!isPresent) {
      presenceCoversShift = false;
    } else if (schedule) {
      const [yearPart, monthPart, dayPart] = summary.date.split('-').map(Number);
      const dateObject = new Date(yearPart, monthPart - 1, dayPart);
      // Предпраздничный день — смена сокращена на 1ч, span должен сравниваться с укороченной длительностью.
      const baseShiftHours = getShiftDurationHours(getScheduleForDate(schedule, dateObject));
      const shiftDurationHours = Math.max(0, baseShiftHours - (isPreHoliday(dateObject, schedule, calendarMonth) ? 1 : 0));
      presenceCoversShift = computePresenceCoversShift({
        firstEntry: summary.first_entry,
        lastExit: summary.last_exit,
        totalMinutes: getSummaryMinutes(summary),
        shiftDurationHours,
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
      travel_minutes_credited: travelCreditedMinutes,
      travel_hours_credited: travelCreditedHours,
      travel_delay_minutes: travelSummary?.delayMinutes || 0,
      travel_segments_count: travelSummary?.segmentsCount || 0,
      travel_problematic_segments: travelSummary?.problematicSegmentsCount || 0,
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

        const travelCreditedMinutes = travelSummary?.creditedMinutes || 0;
        const travelCreditedHours = roundHours(travelCreditedMinutes / 60);

        if (rawSummary) {
          const plannedHours = getScheduleForDate(schedule, dateObject).work_hours;
          const baseHours = computeSummaryPaidHours(rawSummary, schedule.lunch_minutes || 0);
          const hoursWorked = roundHours(Math.min(baseHours + travelCreditedHours, plannedHours));
          const isPresent = baseHours > 0 || rawSummary.first_entry !== null;

          if (!skudMap.has(employee.id)) {
            skudMap.set(employee.id, new Map());
          }
          skudMap.get(employee.id)!.set(workDate, { hours: hoursWorked, corrected: false });

          const baseShiftHours = getShiftDurationHours(getScheduleForDate(schedule, dateObject));
          const shiftDurationHours = Math.max(0, baseShiftHours - (isPreHoliday(dateObject, schedule, calendarMonth) ? 1 : 0));
          const presenceCoversShift = isPresent
            ? computePresenceCoversShift({
              firstEntry: rawSummary.first_entry,
              lastExit: rawSummary.last_exit,
              totalMinutes: getSummaryMinutes(rawSummary),
              shiftDurationHours,
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
            travel_minutes_credited: travelCreditedMinutes,
            travel_hours_credited: travelCreditedHours,
            travel_delay_minutes: travelSummary?.delayMinutes || 0,
            travel_segments_count: travelSummary?.segmentsCount || 0,
            travel_problematic_segments: travelSummary?.problematicSegmentsCount || 0,
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
            travel_minutes_credited: travelCreditedMinutes,
            travel_hours_credited: travelCreditedHours,
            travel_delay_minutes: travelSummary?.delayMinutes || 0,
            travel_segments_count: travelSummary?.segmentsCount || 0,
            travel_problematic_segments: travelSummary?.problematicSegmentsCount || 0,
            is_correction: false,
            first_entry: null,
            last_exit: null,
            presence_covers_shift: false,
          });
        }
        continue;
      }

      const plannedHours = getScheduleForDate(schedule, dateObject).work_hours;
      const remoteTravelCreditedMinutes = travelSummary?.creditedMinutes || 0;
      const remoteTravelCreditedHours = roundHours(remoteTravelCreditedMinutes / 60);
      pushEntry({
        id: null,
        employee_id: employee.id,
        work_date: workDate,
        status: 'remote',
        hours_worked: plannedHours,
        display_hours_worked: plannedHours,
        base_hours_worked: plannedHours,
        travel_minutes_credited: remoteTravelCreditedMinutes,
        travel_hours_credited: remoteTravelCreditedHours,
        travel_delay_minutes: travelSummary?.delayMinutes || 0,
        travel_segments_count: travelSummary?.segmentsCount || 0,
        travel_problematic_segments: travelSummary?.problematicSegmentsCount || 0,
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

    // Дневная корректировка с явным hours_override — приоритет над СКУД-объектами.
    // Иначе ввод 8:59 в модалке «Корректировка» затирался агрегатом из object_entries (см. plan).
    if (entry.is_correction && entry.id != null && entry.hours_worked != null) {
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

  if (!includeObjectDetails && objectAdjustmentTotals.size > 0) {
    for (const [key, total] of objectAdjustmentTotals) {
      const separatorIndex = key.indexOf('_');
      const employeeId = Number(key.slice(0, separatorIndex));
      const workDate = key.slice(separatorIndex + 1);
      const existing = byEmployeeDate.get(employeeId)?.get(workDate);

      if (existing?.is_correction && existing.id != null) {
        continue;
      }

      const hours = roundHours(total.hours);
      const patch = {
        id: total.latest.id,
        status: (hours > 0 ? 'work' : 'absent') as TimeStatus,
        hours_worked: hours,
        display_hours_worked: hours,
        base_hours_worked: hours,
        is_correction: true,
        reason: total.latest.reason,
        notes: total.latest.reason,
        approval_status: total.latest.approval_status,
        corrected_at: total.latest.updated_at ?? total.latest.created_at,
        created_at: total.latest.created_at,
        updated_at: total.latest.updated_at,
        object_detail_mode: 'none' as const,
        object_detail_message: null,
        object_detail_count: 0,
      };

      if (existing) {
        Object.assign(existing, patch);
        continue;
      }

      pushEntry({
        employee_id: employeeId,
        work_date: workDate,
        travel_minutes_credited: 0,
        travel_hours_credited: 0,
        travel_delay_minutes: 0,
        travel_segments_count: 0,
        travel_problematic_segments: 0,
        ...patch,
      });
    }
  }

  // Безусловно заполняем display_hours_worked = clamp(hours_worked, plannedDayHours)
  // для всех entries — независимо от displayMode. Это даёт фронту оба значения
  // (entry.hours_worked = факт, entry.display_hours_worked = урезанное под график)
  // и позволяет per-role show_actual_hours переключать показ в обе стороны:
  // selectVisibleHours(entry, true) → hours_worked, (entry, false) → display_hours_worked.
  // Раньше при displayMode='actual' display_hours_worked оставался undefined для не-объектных
  // кейсов → переключение факт→урезано на фронте не работало (фолбэк давал тот же hours_worked).
  for (const entry of entries) {
    if (entry.is_correction && entry.id != null) continue;

    const employeeSchedule = dailySchedulesMap.get(entry.employee_id)?.get(entry.work_date);
    const shiftLengthHours = getShiftLengthHoursForScheduleOnDate(employeeSchedule, entry.work_date);
    const dayObjectEntries = objectAttendanceData.objectEntriesByEmployeeDate
      .get(entry.employee_id)
      ?.get(entry.work_date) || [];

    if (dayObjectEntries.length > 0) {
      const totalActualHours = roundHours(
        dayObjectEntries.reduce((sum, item) => sum + item.hours_worked, 0),
      );
      entry.display_hours_worked = (shiftLengthHours != null && totalActualHours > shiftLengthHours)
        ? shiftLengthHours
        : totalActualHours;
    } else if (entry.hours_worked != null && shiftLengthHours != null) {
      entry.display_hours_worked = clampToScheduleHours(entry.hours_worked, shiftLengthHours);
    } else {
      entry.display_hours_worked = entry.hours_worked;
    }
  }

  if (displayMode === 'capped_to_schedule') {
    for (const entry of entries) {
      // Корректировка с явным hours_override авторитетна — не режем под смену,
      // иначе у руководителя в модалке отображается урезанное значение, отличное от того,
      // что он сам сохранил (и что админ видит в «Согласованиях»).
      if (entry.is_correction && entry.id != null) continue;

      const dayObjectEntries = objectAttendanceData.objectEntriesByEmployeeDate
        .get(entry.employee_id)
        ?.get(entry.work_date) || [];

      const employeeSchedule = dailySchedulesMap.get(entry.employee_id)?.get(entry.work_date);
      const shiftLengthHours = getShiftLengthHoursForScheduleOnDate(employeeSchedule, entry.work_date);

      if (dayObjectEntries.length > 0) {
        const totalActualHours = roundHours(
          dayObjectEntries.reduce((sum, item) => sum + item.hours_worked, 0),
        );

        if (shiftLengthHours != null && totalActualHours > shiftLengthHours) {
          const scale = shiftLengthHours / totalActualHours;
          let allocated = 0;
          dayObjectEntries.forEach((item, idx) => {
            const isLast = idx === dayObjectEntries.length - 1;
            const share = isLast
              ? roundHours(shiftLengthHours - allocated)
              : roundHours(item.hours_worked * scale);
            item.display_hours_worked = share;
            item.hours_worked = share;
            item.base_hours_worked = share;
            allocated = roundHours(allocated + share);
          });
          entry.display_hours_worked = shiftLengthHours;
        } else {
          for (const item of dayObjectEntries) {
            item.display_hours_worked = item.hours_worked;
            item.base_hours_worked = item.hours_worked;
          }
          entry.display_hours_worked = totalActualHours;
        }
      } else {
        entry.display_hours_worked = entry.hours_worked == null || shiftLengthHours == null
          ? entry.hours_worked
          : clampToScheduleHours(entry.hours_worked, shiftLengthHours);
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
