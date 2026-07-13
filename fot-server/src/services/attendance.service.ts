import { query, queryOne } from '../config/postgres.js';
import type { Pool, PoolClient } from 'pg';
import type { IProductionCalendarMonth, IResolvedSchedule, TimeStatus } from '../types/index.js';

/**
 * Исполнитель SQL: клиент транзакции (withTransaction). Если не передан —
 * upsert/supersede ходят через module-level query/queryOne (пул). Позволяет
 * вызывать их как самостоятельно, так и внутри транзакции вызывающего кода.
 */
export type DbExecutor = Pool | PoolClient;

/** SELECT-many: через tx-клиент, если передан, иначе через пул (mockable query). */
async function sqlRows<T extends import('pg').QueryResultRow = import('pg').QueryResultRow>(
  exec: DbExecutor | undefined, sql: string, params: readonly unknown[],
): Promise<T[]> {
  if (exec) return (await exec.query<T>(sql, params as unknown[])).rows;
  return query<T>(sql, params);
}

/** SELECT-one: первая строка или null (см. sqlRows). */
async function sqlOne<T extends import('pg').QueryResultRow = import('pg').QueryResultRow>(
  exec: DbExecutor | undefined, sql: string, params: readonly unknown[],
): Promise<T | null> {
  if (exec) return (await exec.query<T>(sql, params as unknown[])).rows[0] ?? null;
  return queryOne<T>(sql, params);
}
import { getTravelHoursSummaryForRange } from './skud-travel.service.js';
import { getScheduleForDate, getShiftDurationHours, isPreHoliday, isWorkingDay, needsSkudCheck } from './schedule.service.js';
import { formatDateToISO } from '../utils/date.utils.js';
import {
  ABSENCE_STATUSES_AS_WORKED,
  getAdjustmentPriority,
  NON_WORK_ADJUSTMENT_STATUSES,
  roundHours,
} from './time-calculation/primitives.js';
import {
  buildObjectAttendanceData,
  isMigratedDayLevelAdjustment,
  OBJECT_ADJUSTMENT_SOURCE_TYPE,
  type IAttendanceObjectEntry,
} from './timesheet-object.service.js';

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
  approver_name: string | null;
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
  approved_at?: string | null;
  approved_by_name?: string | null;
  created_at?: string;
  updated_at?: string;
  object_detail_mode?: 'none' | 'available' | 'legacy_blocked';
  object_detail_message?: string | null;
  object_detail_count?: number;
  presence_covers_shift?: boolean;
  // Перерыв за день (сумма гэпов между парами вход→выход) из skud_daily_summary. Для дней
  // без summary не задаётся — ЛК показывает строку «Перерыв» только при > 0.
  break_minutes?: number | null;
  // true, если за день у сотрудника в attendance_adjustments есть хотя бы одна
  // запись с source_type='manual_object'. Такие записи нельзя удалить через
  // DELETE /api/timesheet/:id (контроллер вернёт 409) — фронт по этому флагу
  // прячет кнопку «Снять корректировку» в режиме «По сотрудникам».
  has_object_adjustments?: boolean;
  // true, если часы дня заданы ЯВНОЙ ручной правкой (hours_override > 0 у day-level,
  // либо объектная корректировка manual_object). Отличает «табельщица проставила N часов»
  // от СКУД-факта/согласованного выхода. 1С-экспорт по этому флагу НЕ режет день под норму
  // графика (обычная СКУД-переработка — режется). Не выставляется для hours_override=0
  // (обнулённый день / обязательная суббота с часами из СКУД).
  hours_overridden?: boolean;
  // Источник авторитетной корректировки дня (leave_request | manual | legacy | ...).
  // Фронт по нему отличает материализованную заявку (status='work' + source_type='leave_request')
  // от обычного СКУД-дня и понимает, можно ли добавить «Удалёнку» поверх согласованного выхода.
  source_type?: string | null;
  // «Спутник» — согласованный выход в выходной (leave_request/work), поверх которого
  // лежит авторитетная day-level корректировка «Удалёнка» (manual/remote). Заполняется
  // ТОЛЬКО когда обе строки сосуществуют: ведущая entry = remote (часы), companion = work
  // (одобрение выхода для отображения). Часы у companion не показываем — они на ведущей.
  companion_work_request?: {
    id: number;
    approval_status: 'auto_approved' | 'pending' | 'approved' | 'rejected' | null;
    approved_at: string | null;
    approved_by_name: string | null;
    reason: string | null;
  } | null;
}

export interface IAttendanceBuildResult {
  entries: IAttendanceEntry[];
  objectEntries: IAttendanceObjectEntry[];
  byEmployeeDate: Map<number, Map<string, IAttendanceEntry>>;
  objectEntriesByEmployeeDate: Map<number, Map<string, IAttendanceObjectEntry[]>>;
  skudMap: Map<number, Map<string, { hours: number; corrected: boolean }>>;
}

// «Реальный сигнал» дня: корректировка/adjustment (id), явный is_correction,
// СКУД-присутствие (first_entry/last_exit), часы > 0 или зачтённые travel-сегменты.
// Синтетические заглушки status='absent' (id: null, без СКУД, 0 часов), которыми
// buildAttendanceEntries дозаполняет рабочие по графику дни, сигналом не считаются.
// Единый критерий «сотрудник без активности за период» для фильтра нулевой
// активности в GET /api/timesheet и для 1С-экспортов (excludeZeroActivity).
export function hasRealActivity(entry: IAttendanceEntry): boolean {
  return entry.id != null ||
    entry.is_correction ||
    entry.first_entry != null ||
    entry.last_exit != null ||
    (entry.hours_worked ?? 0) > 0 ||
    (entry.base_hours_worked ?? 0) > 0 ||
    (entry.travel_segments_count ?? 0) > 0;
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

/**
 * Распределяет дневной НЕТТО-итог часов (обед уже вычтен в computeSummaryPaidHours)
 * по объектным записям пропорционально их сырым минутам присутствия. Сумма долей точно
 * равна netHours (метод наибольшего остатка в центичасах). Пишет hours_worked/display/base.
 * Нужно, т.к. объектные интервалы — сырое присутствие БЕЗ обеда: задавать ими дневной итог
 * нельзя (обед теряется), но разбивку по объектам надо привести к итогу с обедом.
 */
function distributeNetHoursAcrossObjects(
  objectEntries: IAttendanceObjectEntry[],
  netHours: number,
): void {
  if (objectEntries.length === 0) return;
  const totalCentihours = Math.max(0, Math.round((netHours || 0) * 100));
  const weights = objectEntries.map(item => Math.max(0, item.hours_worked));
  const sumWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (sumWeight <= 0 || totalCentihours === 0) {
    for (const item of objectEntries) {
      item.hours_worked = 0;
      item.display_hours_worked = 0;
      item.base_hours_worked = 0;
    }
    return;
  }
  const exactShares = weights.map(weight => (totalCentihours * weight) / sumWeight);
  const centihours = exactShares.map(value => Math.floor(value));
  let distributed = centihours.reduce((sum, value) => sum + value, 0);
  const byFractionDesc = exactShares
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((left, right) => right.frac - left.frac);
  for (let k = 0; distributed < totalCentihours; k += 1) {
    centihours[byFractionDesc[k % centihours.length].index] += 1;
    distributed += 1;
  }
  objectEntries.forEach((item, index) => {
    const hours = roundHours(centihours[index] / 100);
    item.hours_worked = hours;
    item.display_hours_worked = hours;
    item.base_hours_worked = hours;
  });
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
  let lastSec = lastExit
    ? parseTimeToSeconds(lastExit)
    : (workDate === todayStr ? parseTimeToSeconds(nowHMS) : null);
  if (lastSec === null) return false;
  // Ночная смена: выход (08:00) раньше входа (20:00) по времени суток — значит
  // смена перешла через полночь, добавляем сутки, иначе span отрицательный.
  if (lastSec < firstSec) lastSec += 24 * 3600;
  const spanSec = Math.max(0, lastSec - firstSec);
  const workSec = totalMinutes * 60;
  const gapsSec = Math.max(0, spanSec - workSec);
  return spanSec >= shiftDurationHours * 3600 && gapsSec <= lunchMinutes * 60;
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
    const data = await query<{
      id: number;
      employee_id: number;
      work_date: string;
      status: string;
      hours_override: number | string | null;
      source_type: string;
      source_id: string | null;
      reason: string | null;
      created_by: string | null;
      updated_by: string | null;
      created_at: string;
      updated_at: string | null;
      metadata: unknown;
      approval_status: string | null;
      approval_comment: string | null;
      approved_by: string | null;
      approved_at: string | null;
    }>(
      `SELECT id, employee_id, work_date, status, hours_override, source_type, source_id, reason,
              created_by, updated_by, created_at, updated_at, metadata,
              approval_status, approval_comment, approved_by, approved_at
         FROM attendance_adjustments
         WHERE employee_id = ANY($1::int[])
           AND work_date >= $2
           AND work_date <= $3`,
      [batch, startDate, endDate],
    );

    adjustments.push(
      ...(data.map((row) => ({
        id: Number(row.id),
        employee_id: Number(row.employee_id),
        work_date: String(row.work_date),
        status: String(row.status) as TimeStatus,
        hours_override: row.hours_override != null ? Number(row.hours_override) : null,
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
  const userIds = [...new Set([
    ...adjustments.map((item) => item.created_by).filter((id): id is string => Boolean(id)),
    ...adjustments.map((item) => item.approved_by).filter((id): id is string => Boolean(id)),
  ])];
  const legacyEmployeeIds = [...new Set(adjustments.map((item) => extractLegacyCorrectorId(item.metadata)).filter((id): id is number => id != null))];

  // Сначала смотрим в in-memory кэш — большая часть авторов повторяется между вызовами.
  const { hits: userHits, misses: userMisses } = readUserNameCache(userIds);
  const { hits: legacyHits, misses: legacyMisses } = readLegacyEmployeeNameCache(legacyEmployeeIds);

  const [userRows, employeeRows] = await Promise.all([
    userMisses.length > 0
      ? query<{ id: string; full_name: string | null }>(
        `SELECT id, full_name FROM user_profiles WHERE id = ANY($1::uuid[])`,
        [userMisses],
      )
      : Promise.resolve([] as Array<{ id: string; full_name: string | null }>),
    legacyMisses.length > 0
      ? query<{ id: number; full_name: string | null }>(
        `SELECT id, full_name FROM employees WHERE id = ANY($1::int[])`,
        [legacyMisses],
      )
      : Promise.resolve([] as Array<{ id: number; full_name: string | null }>),
  ]);

  const expiresAt = Date.now() + NAME_CACHE_TTL;
  const userNames = new Map(userHits);
  for (const row of userRows) {
    const id = String(row.id);
    const name = String(row.full_name || '');
    userNames.set(id, name);
    userNameCache.set(id, { name, expiresAt });
  }
  const legacyEmployeeNames = new Map(legacyHits);
  for (const row of employeeRows) {
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
    const data = await query<ISummaryRow>(
      `SELECT employee_id, date, first_entry, last_exit, total_hours, total_minutes, break_hours, break_minutes
         FROM skud_daily_summary
         WHERE employee_id = ANY($1::int[])
           AND date >= $2
           AND date <= $3
         ORDER BY date ASC`,
      [batch, startDate, endDate],
    );
    rows.push(...data);
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
  // Синтезировать day-level запись для дней, где есть ТОЛЬКО объектная корректировка
  // (без СКУД и без day-level записи). Включается ЯВНО лишь для интерактивного табеля
  // (режим «по сотрудникам»), чтобы такие дни были видны (#3). Потребители расчёта
  // зарплаты / Excel-экспорта / дашборда вызывают сервис напрямую без этого флага и
  // НЕ должны затрагиваться (иначе object-only день начал бы считаться отработанным).
  synthesizeObjectOnlyDays?: boolean;
  // Персистить пересчитанные сегменты «Дороги» в skud_travel_segments. По умолчанию true
  // (интерактивный табель/дашборд обновляют кэш). Read-only экспорты ставят false —
  // сводка считается в памяти, а тяжёлый DELETE+INSERT не выполняется.
  persistTravelSegments?: boolean;
}): Promise<IAttendanceBuildResult> {
  const { employees, startDate, endDate, dailySchedulesMap, calendarMonth } = params;
  const todayStr = params.todayStr ?? formatDateToISO(new Date());
  const displayMode = params.displayMode ?? 'actual';
  const includeObjectDetails = params.includeObjectDetails ?? true;
  const synthesizeObjectOnlyDays = params.synthesizeObjectOnlyDays ?? false;
  const persistTravelSegments = params.persistTravelSegments ?? true;
  const nowHMS = formatNowHMS(new Date());
  const employeeIds = employees.map((employee) => employee.id);

  const [summaries, adjustments, travelSummaries] = await Promise.all([
    loadDailySummaries(employeeIds, startDate, endDate),
    loadAttendanceAdjustments(employeeIds, startDate, endDate),
    getTravelHoursSummaryForRange({ employeeIds, startDate, endDate, persist: persistTravelSegments }),
  ]);

  // Всегда строим rawFallbackSummaries — они нужны fallback-пути для дней без skud_daily_summary
  // (см. цикл по employees ниже, ветка needsSkudCheck → rawSummary). Object-агрегация выполняется
  // только в режиме «По объектам». До фикса fallback гасился вместе с object-блоком, и день с
  // событиями, но без summary, рендерился как «Н».
  const objectAttendanceData = employeeIds.length > 0
    ? await buildObjectAttendanceData({
      employeeIds,
      startDate,
      endDate,
      todayStr,
      adjustments,
      includeObjectDetails,
    })
    : createEmptyObjectAttendanceData();
  // Суммы объектных корректировок по дню нужны в ОБОИХ режимах:
  //  • !includeObjectDetails — свернуть объекты в дневную запись;
  //  • includeObjectDetails  — ДОБРАТЬ дни, где есть ТОЛЬКО объектная корректировка
  //    (без СКУД и без day-level записи), иначе такой день невидим в «по сотрудникам» (#3).
  const objectAdjustmentTotals = buildObjectAdjustmentTotals(adjustments);
  // Мигрированные из day-level правки трактуем как day-level (авторитетный итог дня),
  // а не как объектные — иначе в режиме без детализации объектов (зарплата) они вовсе
  // игнорировались, а в объектном — задваивали день с СКУД на других объектах.
  const dailyAdjustments = adjustments.filter(adjustment =>
    adjustment.source_type !== OBJECT_ADJUSTMENT_SOURCE_TYPE
    || isMigratedDayLevelAdjustment(adjustment));
  // Имена авторов резолвим по ВСЕМ корректировкам (включая объектные), чтобы показывать
  // автора и у корректировок «по объекту» (#9), а не только у day-level.
  const { userNames, legacyEmployeeNames } = await loadAdjustmentNames(adjustments);

  // #9: автор/время объектных корректировок — заполняем по adjustment_id. objectEntries и
  // objectEntriesByEmployeeDate ссылаются на одни и те же объекты, мутируем один раз.
  const adjustmentMetaById = new Map<number, { created_by: string | null; updated_at: string; approval_status: string }>();
  for (const adjustment of adjustments) {
    adjustmentMetaById.set(adjustment.id, {
      created_by: adjustment.created_by,
      updated_at: adjustment.updated_at,
      approval_status: adjustment.approval_status,
    });
  }
  for (const objectEntry of objectAttendanceData.objectEntries) {
    if (objectEntry.adjustment_id == null) continue;
    const meta = adjustmentMetaById.get(objectEntry.adjustment_id);
    if (!meta) continue;
    objectEntry.corrected_by_name = meta.created_by ? userNames.get(meta.created_by) ?? null : null;
    objectEntry.corrected_at = meta.updated_at;
    objectEntry.approval_status = meta.approval_status as 'auto_approved' | 'pending' | 'approved' | 'rejected' | null;
  }
  const entries: IAttendanceEntry[] = [];
  const byEmployeeDate = new Map<number, Map<string, IAttendanceEntry>>();
  const skudMap = new Map<number, Map<string, { hours: number; corrected: boolean }>>();
  // Обеденная квота к вычету за день (в часах), по `${employee_id}_${date}`. Считается из
  // того же графика, что и summary-итог: max(0, lunch − outside). Объектная агрегация
  // вычитает её из сырой объектной суммы, иначе обед терялся (объекты — сырое присутствие).
  const lunchCutByKey = new Map<string, number>();

  const pushEntry = (entry: IAttendanceEntry): void => {
    entries.push(entry);
    if (!byEmployeeDate.has(entry.employee_id)) {
      byEmployeeDate.set(entry.employee_id, new Map());
    }
    byEmployeeDate.get(entry.employee_id)!.set(entry.work_date, entry);
  };

  for (const summary of summaries) {
    const skudMapSchedule = dailySchedulesMap.get(summary.employee_id)?.get(summary.date);
    const [yearPart, monthPart, dayPart] = summary.date.split('-').map(Number);
    const dateObject = new Date(yearPart, monthPart - 1, dayPart);
    const effectiveLunchMinutes = skudMapSchedule
      ? getScheduleForDate(skudMapSchedule, dateObject).lunch_minutes
      : 0;
    const hours = computeSummaryPaidHours(summary, effectiveLunchMinutes);
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

  // Согласованные выходы (leave_request/work) по дню — чтобы прицепить companion к
  // ведущей remote-entry, когда удалёнка лежит поверх согласованной заявки.
  const workRequestByKey = new Map<string, IAttendanceAdjustment>();
  for (const adj of dailyAdjustments) {
    if (adj.source_type === 'leave_request' && adj.status === 'work') {
      workRequestByKey.set(`${adj.employee_id}_${adj.work_date}`, adj);
    }
  }

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
    const approvedByName = adjustment.approved_by
      ? userNames.get(adjustment.approved_by) || null
      : null;

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
    // ИСКЛЮЧЕНИЕ — ручная корректировка «удалённая работа» в выходной с явными часами и
    // согласованием: начальник отдела отмечает удалённый выход поверх согласованной заявки
    // «работа в выходной». Такие часы зачитываются (проваливаются в ветку hours_override ниже).
    const adjNotApproved = adjustment.approval_status === 'pending' || adjustment.approval_status === 'rejected';
    const isRemoteWithHours = adjustment.status === 'remote'
      && adjustment.hours_override != null && Number(adjustment.hours_override) > 0
      && !adjNotApproved;
    let effectiveHours: number | null;
    if (NON_WORK_ADJUSTMENT_STATUSES.has(adjustment.status) && !isAdjWorkingDay && !isRemoteWithHours) {
      effectiveHours = 0;
    } else if (adjustment.status === 'work' && !isAdjWorkingDay && adjustment.hours_override === 0) {
      // 'work' в выходной с hours_override=0 → не обнулять, взять часы из СКУД (обязательная суббота)
      const notApproved = adjustment.approval_status === 'pending' || adjustment.approval_status === 'rejected';
      if (notApproved) {
        effectiveHours = 0;
      } else if (existingSkud) {
        effectiveHours = existingSkud.hours;
      } else {
        const rawSummary = objectAttendanceData.rawFallbackSummaries
          .get(adjustment.employee_id)?.get(adjustment.work_date);
        if (rawSummary) {
          const lunchMinutes = adjSchedule ? getScheduleForDate(adjSchedule, adjDate).lunch_minutes : 0;
          effectiveHours = computeSummaryPaidHours(rawSummary, lunchMinutes);
        } else {
          effectiveHours = null;
        }
      }
    } else if (adjustment.hours_override != null) {
      effectiveHours = adjustment.hours_override;
    } else if (adjustment.status === 'work') {
      // 'work' без явных часов = заявка на выход. Фактическое время берём из СКУД ТОЛЬКО
      // если выход согласован. Не согласовано (pending/rejected) → 0 (заявка влияет на
      // согласование, а не на отображаемое время). Согласовано/auto/legacy(null) → часы по СКУД.
      const notApproved = adjustment.approval_status === 'pending' || adjustment.approval_status === 'rejected';
      if (notApproved) {
        effectiveHours = 0;
      } else if (existingSkud) {
        effectiveHours = existingSkud.hours;
      } else {
        // skud_daily_summary часто НЕ содержит выходных/праздничных дат (или ещё не пересчитан
        // для сегодняшних live-событий) — берём часы напрямую из raw-событий СКУД, иначе
        // согласованный выход в выходной показывал бы 0 при фактическом присутствии (#6).
        const rawSummary = objectAttendanceData.rawFallbackSummaries
          .get(adjustment.employee_id)?.get(adjustment.work_date);
        if (rawSummary) {
          const lunchMinutes = adjSchedule ? getScheduleForDate(adjSchedule, adjDate).lunch_minutes : 0;
          effectiveHours = computeSummaryPaidHours(rawSummary, lunchMinutes);
        } else {
          effectiveHours = null;
        }
      }
    } else if (ABSENCE_STATUSES_AS_WORKED.has(adjustment.status) && adjSchedule) {
      effectiveHours = isAdjWorkingDay ? getScheduleForDate(adjSchedule, adjDate).work_hours : 0;
    } else {
      effectiveHours = null;
    }

    // Companion: если ведущая запись — НЕ сама заявка work, а за день есть согласованный
    // выход (leave_request/work) — прицепляем его как «спутник» для отображения одобрения.
    const workReq = workRequestByKey.get(key);
    const companionWorkRequest = workReq && Number(workReq.id) !== Number(adjustment.id)
      ? {
          id: Number(workReq.id),
          approval_status: workReq.approval_status ?? null,
          approved_at: workReq.approved_at ?? null,
          approved_by_name: workReq.approved_by ? (userNames.get(workReq.approved_by) || null) : null,
          reason: workReq.reason ?? null,
        }
      : null;

    pushEntry({
      id: adjustment.id,
      employee_id: adjustment.employee_id,
      work_date: adjustment.work_date,
      status: adjustment.status,
      source_type: adjustment.source_type,
      companion_work_request: companionWorkRequest,
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
      // Явная правка часов (положительный override) — авторитетна для 1С (не режется под норму).
      hours_overridden: adjustment.hours_override != null && adjustment.hours_override > 0,
      reason: adjustment.reason,
      notes: adjustment.reason,
      approval_status: adjustment.approval_status,
      corrected_at: adjustment.updated_at ?? adjustment.created_at,
      corrected_by_name: correctedByName,
      corrected_by: legacyCorrectedBy,
      approved_at: adjustment.approved_at,
      approved_by_name: approvedByName,
      created_at: adjustment.created_at,
      updated_at: adjustment.updated_at,
    });
  }

  for (const summary of summaries) {
    if (byEmployeeDate.get(summary.employee_id)?.has(summary.date)) continue;

    const key = `${summary.employee_id}_${summary.date}`;
    const travelSummary = travelSummaries.get(key);
    const schedule = dailySchedulesMap.get(summary.employee_id)?.get(summary.date);
    const [yearPart, monthPart, dayPart] = summary.date.split('-').map(Number);
    const dateObject = new Date(yearPart, monthPart - 1, dayPart);
    const effectiveLunchMinutes = schedule ? getScheduleForDate(schedule, dateObject).lunch_minutes : 0;
    const baseHours = computeSummaryPaidHours(summary, effectiveLunchMinutes);
    lunchCutByKey.set(key, roundHours(Math.max(0, effectiveLunchMinutes - getSummaryBreakMinutes(summary)) / 60));
    const travelCreditedMinutes = travelSummary?.creditedMinutes || 0;
    const travelCreditedHours = roundHours(travelCreditedMinutes / 60);
    const hoursWorked = roundHours(baseHours + travelCreditedHours);
    const isPresent = baseHours > 0 || summary.first_entry !== null;
    // Пустой summary (без часов и без first_entry) на не-рабочий день — это заглушка
    // от batch_recalculate_skud_daily_summary, а не реальная неявка. Симметрично
    // ветке adjustments (NON_WORK_ADJUSTMENT_STATUSES + !isAdjWorkingDay), без entry
    // фронт покажет «—», как у остальных сотрудников с тем же графиком.
    if (!isPresent && schedule && !isWorkingDay(schedule, dateObject, calendarMonth)) {
      continue;
    }
    let presenceCoversShift: boolean | undefined;
    if (!isPresent) {
      presenceCoversShift = false;
    } else if (schedule) {
      if (!isWorkingDay(schedule, dateObject, calendarMonth)) {
        // Выходной/праздник: смены нет, любое присутствие по определению покрывает «нулевую» смену.
        // Иначе для выхода в выходной span<work_start..work_end даст false и день покрасится underwork.
        presenceCoversShift = true;
      } else {
        // Предпраздничный день — смена сокращена на 1ч, span должен сравниваться с укороченной длительностью.
        const baseShiftHours = getShiftDurationHours(getScheduleForDate(schedule, dateObject));
        const shiftDurationHours = Math.max(0, baseShiftHours - (isPreHoliday(dateObject, schedule, calendarMonth) ? 1 : 0));
        presenceCoversShift = computePresenceCoversShift({
          firstEntry: summary.first_entry,
          lastExit: summary.last_exit,
          totalMinutes: getSummaryMinutes(summary),
          shiftDurationHours,
          lunchMinutes: effectiveLunchMinutes,
          workDate: summary.date,
          todayStr,
          nowHMS,
        });
      }
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
      break_minutes: getSummaryBreakMinutes(summary),
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
          const dayParams = getScheduleForDate(schedule, dateObject);
          const plannedHours = dayParams.work_hours;
          const effectiveLunchMinutes = dayParams.lunch_minutes;
          const baseHours = computeSummaryPaidHours(rawSummary, effectiveLunchMinutes);
          lunchCutByKey.set(key, roundHours(Math.max(0, effectiveLunchMinutes - getSummaryBreakMinutes(rawSummary)) / 60));
          const hoursWorked = roundHours(Math.min(baseHours + travelCreditedHours, plannedHours));
          const isPresent = baseHours > 0 || rawSummary.first_entry !== null;

          if (!skudMap.has(employee.id)) {
            skudMap.set(employee.id, new Map());
          }
          skudMap.get(employee.id)!.set(workDate, { hours: hoursWorked, corrected: false });

          const baseShiftHours = getShiftDurationHours(dayParams);
          const shiftDurationHours = Math.max(0, baseShiftHours - (isPreHoliday(dateObject, schedule, calendarMonth) ? 1 : 0));
          const presenceCoversShift = isPresent
            ? computePresenceCoversShift({
              firstEntry: rawSummary.first_entry,
              lastExit: rawSummary.last_exit,
              totalMinutes: getSummaryMinutes(rawSummary),
              shiftDurationHours,
              lunchMinutes: effectiveLunchMinutes,
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
            break_minutes: getSummaryBreakMinutes(rawSummary),
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

    const hasObjectCorrection = dayObjectEntries.some(item => item.is_correction);
    if (hasObjectCorrection) {
      // Объектная правка авторитетна (явные часы) — обед НЕ применяется поверх ручной
      // корректировки (зеркало исключений every(is_correction) ниже). Берём сырую сумму.
      const totalHours = roundHours(dayObjectEntries.reduce((sum, item) => sum + item.hours_worked, 0));
      const totalBaseHours = roundHours(dayObjectEntries.reduce((sum, item) => sum + item.base_hours_worked, 0));
      entry.status = totalHours > 0 || entry.first_entry ? 'work' : entry.status;
      entry.hours_worked = totalHours;
      entry.display_hours_worked = totalHours;
      entry.base_hours_worked = totalBaseHours;
    } else {
      // Чистые СКУД-объекты: объектная сумма — сырое присутствие БЕЗ обеда. Раньше дневной
      // итог перезаписывался ею и обед терялся. Теперь вычитаем дневную обеденную квоту
      // (max(0, lunch − outside), та же, что в summary-итоге) из сырой объектной суммы и
      // распределяем нетто по объектам пропорц. сырым минутам. Объекты остаются авторитетны
      // для брутто-присутствия; travel прибавляем к дневному итогу как в summary-ветке.
      const objectGross = roundHours(dayObjectEntries.reduce((sum, item) => sum + item.hours_worked, 0));
      const lunchCut = lunchCutByKey.get(`${entry.employee_id}_${entry.work_date}`) ?? 0;
      const objectNet = roundHours(Math.max(0, objectGross - lunchCut));
      const totalWithTravel = roundHours(objectNet + (entry.travel_hours_credited || 0));
      distributeNetHoursAcrossObjects(dayObjectEntries, objectNet);
      entry.status = totalWithTravel > 0 || entry.first_entry ? 'work' : entry.status;
      entry.hours_worked = totalWithTravel;
      entry.display_hours_worked = totalWithTravel;
      entry.base_hours_worked = objectNet;
    }
    entry.is_correction = entry.is_correction || dayObjectEntries.some(item => item.is_correction);
    // Объектная правка = явная корректировка часов → для 1С не режем под норму.
    entry.hours_overridden = entry.hours_overridden || dayObjectEntries.some(item => item.is_correction);
    // Синхронизируем approval_status из последней объектной корректировки в дневную запись.
    // Без этого "по сотрудникам" всегда показывает оранжевый флажок вместо синего/зелёного,
    // т.к. дневная запись остаётся от СКУД-данных (нет approval_status).
    // Применяем только к СКУД-записям (entry.id == null) — у них нет собственного approval_status.
    if (entry.id == null && entry.is_correction) {
      const latestCorrObj = dayObjectEntries
        .filter(item => item.is_correction && !item.from_day_level)
        .reduce<IAttendanceObjectEntry | null>((latest, item) => {
          if (!latest) return item;
          const latestTime = new Date(latest.corrected_at ?? '').getTime();
          const itemTime = new Date(item.corrected_at ?? '').getTime();
          return itemTime > latestTime ? item : latest;
        }, null);
      if (latestCorrObj?.approval_status) {
        entry.approval_status = latestCorrObj.approval_status;
      }
    }
    entry.object_detail_mode = employeesWithMultiObjects.has(entry.employee_id) ? 'available' : 'none';
    entry.object_detail_message = null;
    entry.object_detail_count = employeesWithMultiObjects.has(entry.employee_id) ? dayObjectEntries.length : 0;
  }

  if (objectAdjustmentTotals.size > 0) {
    for (const [key, total] of objectAdjustmentTotals) {
      const separatorIndex = key.indexOf('_');
      const employeeId = Number(key.slice(0, separatorIndex));
      const workDate = key.slice(separatorIndex + 1);
      const existing = byEmployeeDate.get(employeeId)?.get(workDate);

      // С деталями объектов существующая дневная запись уже агрегирует объектные
      // корректировки в цикле выше — повторно не патчим. Синтезируем только дни
      // БЕЗ дневной записи (объектная корректировка без СКУД/day-level), #3.
      if (existing && includeObjectDetails) {
        continue;
      }
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
        // Синтезированный день из объектной корректировки — явная правка часов.
        hours_overridden: hours > 0,
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

      // Дня нет в byEmployeeDate (объектная корректировка без СКУД/day-level). Синтезируем:
      //  • !includeObjectDetails — как и раньше (свод для экспортных/расчётных потребителей);
      //  • includeObjectDetails  — ТОЛЬКО для интерактивного табеля (synthesizeObjectOnlyDays),
      //    иначе расчёт зарплаты/Excel-экспорт начали бы считать такой день отработанным (#3).
      if (includeObjectDetails && !synthesizeObjectOnlyDays) {
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

  // Безусловно заполняем display_hours_worked = clamp(факт, длина смены) для всех entries
  // (и для объектных item) — независимо от displayMode. Это даёт фронту оба значения
  // (entry.hours_worked = факт, entry.display_hours_worked = урезанное под график) и
  // позволяет per-role show_actual_hours переключать показ в обе стороны:
  // selectVisibleHours(entry, true) → hours_worked, (entry, false) → display_hours_worked.
  // ВАЖНО: здесь, в отличие от блока capped_to_schedule ниже, мы НЕ трогаем hours_worked,
  // base_hours_worked, first_entry, last_exit (у entry и item) — факт и времена входа/выхода
  // сохранены (нужны для опозданий и дневной модалки). Раньше блок не резал под смену, и
  // «урезано»-роль в интерактивном табеле видела факт.
  for (const entry of entries) {
    if (entry.is_correction && entry.id != null) continue;

    const dayObjectEntries = objectAttendanceData.objectEntriesByEmployeeDate
      .get(entry.employee_id)
      ?.get(entry.work_date) || [];

    // Явная объектная правка (manual_object с hours_override) авторитетна, как day-level:
    // НЕ режем под смену. Начальник участка («урезано»-роль) видит скорректированную
    // переработку (напр. 13ч), но обычные СКУД-часы сверх графика остаются урезанными
    // (ветка ниже). day-level правки уже освобождены через entry.id != null на входе цикла,
    // но СКУД-день с объектной правкой имеет entry.id == null (см. сборку выше, ~стр. 882),
    // поэтому здесь нужен отдельный признак — все объектные записи дня is_correction.
    if (dayObjectEntries.length > 0 && dayObjectEntries.every(item => item.is_correction)) {
      let total = 0;
      for (const item of dayObjectEntries) {
        item.display_hours_worked = item.hours_worked;
        total = roundHours(total + item.hours_worked);
      }
      entry.display_hours_worked = total;
      continue;
    }

    const employeeSchedule = dailySchedulesMap.get(entry.employee_id)?.get(entry.work_date);
    const shiftLengthHours = getShiftLengthHoursForScheduleOnDate(employeeSchedule, entry.work_date);

    if (dayObjectEntries.length > 0) {
      const totalActualHours = roundHours(
        dayObjectEntries.reduce((sum, item) => sum + item.hours_worked, 0),
      );
      if (shiftLengthHours != null && totalActualHours > shiftLengthHours) {
        // Распределяем урезанную сумму по объектам пропорционально факту (только display).
        const scale = shiftLengthHours / totalActualHours;
        let allocated = 0;
        dayObjectEntries.forEach((item, idx) => {
          const isLast = idx === dayObjectEntries.length - 1;
          const share = isLast
            ? roundHours(shiftLengthHours - allocated)
            : roundHours(item.hours_worked * scale);
          item.display_hours_worked = share;
          allocated = roundHours(allocated + share);
        });
        entry.display_hours_worked = shiftLengthHours;
      } else {
        for (const item of dayObjectEntries) {
          item.display_hours_worked = item.hours_worked;
        }
        entry.display_hours_worked = totalActualHours;
      }
    } else {
      entry.display_hours_worked = entry.hours_worked == null || shiftLengthHours == null
        ? entry.hours_worked
        : clampToScheduleHours(entry.hours_worked, shiftLengthHours);
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

      // Явная объектная правка авторитетна и в расчёте зарплаты/экспорта: оставляем факт
      // (напр. 13ч), не режем под смену — зеркало освобождения day-level правок (entry.id != null)
      // и блока 'actual' выше. entry.hours_worked/base_hours_worked уже равны сумме факта.
      if (dayObjectEntries.length > 0 && dayObjectEntries.every(item => item.is_correction)) {
        let total = 0;
        for (const item of dayObjectEntries) {
          item.display_hours_worked = item.hours_worked;
          item.base_hours_worked = item.hours_worked;
          total = roundHours(total + item.hours_worked);
        }
        entry.display_hours_worked = total;
        continue;
      }

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

  // Пометим дни, для которых в БД есть object-adjustments (source_type='manual_object').
  // Используется фронтом, чтобы скрывать кнопку «Снять корректировку» в day-modal
  // режима «По сотрудникам» — generic DELETE /api/timesheet/:id для таких записей вернёт 409.
  const objectAdjustedDayKeys = new Set<string>();
  for (const adjustment of adjustments) {
    if (adjustment.source_type === OBJECT_ADJUSTMENT_SOURCE_TYPE) {
      objectAdjustedDayKeys.add(`${adjustment.employee_id}_${adjustment.work_date}`);
    }
  }
  if (objectAdjustedDayKeys.size > 0) {
    for (const entry of entries) {
      if (objectAdjustedDayKeys.has(`${entry.employee_id}_${entry.work_date}`)) {
        entry.has_object_adjustments = true;
      }
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

// Должны совпадать с correction-attachments.service (CORRECTION_ATTACHMENT_ENTITY_TYPE/PURPOSE).
const CORRECTION_ATTACHMENT_ENTITY_LITERAL = 'attendance_adjustment';
const CORRECTION_ATTACHMENT_PURPOSE_LITERAL = 'timesheet_correction';

/**
 * «Работа в выходной» (leave_request/work — факт согласованного выхода) и «Удалёнка»
 * (manual/remote — источник зачтённых часов) сосуществуют на одном дне НАМЕРЕННО:
 * заявка остаётся сигналом одобрения для проверок/служебок, а часы берёт remote.
 * Поэтому supersede НЕ должен вытеснять эту конкретную пару. Все прочие кросс-
 * источниковые пары по-прежнему взаимоисключающие.
 */
export function isWorkRemoteApprovalPair(
  survivorType: string, survivorStatus: string,
  conflictType: string, conflictStatus: string,
): boolean {
  const isManualRemote = (t: string, s: string) => t === 'manual' && s === 'remote';
  const isLeaveWork = (t: string, s: string) => t === 'leave_request' && s === 'work';
  return (
    (isManualRemote(survivorType, survivorStatus) && isLeaveWork(conflictType, conflictStatus))
    || (isLeaveWork(survivorType, survivorStatus) && isManualRemote(conflictType, conflictStatus))
  );
}

/**
 * Day-level корректировки разных источников (manual ↔ leave_request) на один
 * (employee_id, work_date) взаимоисключающие. После записи одной снимаем конфликтующие
 * day-level записи ДРУГОГО источника, перенося их вложения на выжившую (чтобы файл из
 * заявки не пропал). manual_object (по-объектные) и записи того же источника не трогаем (#5/#8).
 * Исключение: пара leave_request/work ↔ manual/remote — оставляем обе (см. выше).
 */
async function supersedeConflictingDayLevelAdjustments(survivor: {
  id: number;
  employee_id: number;
  work_date: string;
  source_type: string;
  status: string;
}, exec?: DbExecutor): Promise<void> {
  const conflicts = await sqlRows<{ id: number | string; source_type: string; source_id: string | null; status: string }>(
    exec,
    `SELECT id, source_type, source_id, status
       FROM attendance_adjustments
      WHERE employee_id = $1 AND work_date = $2
        AND id <> $3
        AND source_type <> $4
        AND source_type <> $5`,
    [survivor.employee_id, survivor.work_date, survivor.id, survivor.source_type, OBJECT_ADJUSTMENT_SOURCE_TYPE],
  );
  for (const conflict of conflicts) {
    // Пару «согласованный выход + удалёнка» не разводим — обе строки нужны.
    if (isWorkRemoteApprovalPair(survivor.source_type, survivor.status, conflict.source_type, conflict.status)) {
      continue;
    }
    const removedId = Number(conflict.id);
    // Собственные вложения удаляемой строки → копируем на выжившую (без дублей).
    await sqlRows(exec,
      `INSERT INTO document_links (document_id, entity_type, entity_id, purpose)
         SELECT document_id, $1, $2, $3 FROM document_links
          WHERE entity_type = $1 AND entity_id = $4 AND purpose = $3
       ON CONFLICT (document_id, entity_type, entity_id, purpose) DO NOTHING`,
      [CORRECTION_ATTACHMENT_ENTITY_LITERAL, String(survivor.id), CORRECTION_ATTACHMENT_PURPOSE_LITERAL, String(removedId)],
    );
    // Файлы связанной заявки (leave_request) — копируем как собственные ссылки выжившей,
    // чтобы они остались видимы после удаления leave_request-строки.
    if (conflict.source_type === 'leave_request' && conflict.source_id) {
      const lrId = conflict.source_id.split(':')[0];
      if (/^\d+$/.test(lrId)) {
        await sqlRows(exec,
          `INSERT INTO document_links (document_id, entity_type, entity_id, purpose)
             SELECT document_id, $1, $2, $3 FROM document_links
              WHERE entity_type = 'leave_request' AND entity_id = $4
           ON CONFLICT (document_id, entity_type, entity_id, purpose) DO NOTHING`,
          [CORRECTION_ATTACHMENT_ENTITY_LITERAL, String(survivor.id), CORRECTION_ATTACHMENT_PURPOSE_LITERAL, lrId],
        );
      }
    }
    // Осиротевшие ссылки удаляемой строки и сама строка.
    await sqlRows(exec,
      `DELETE FROM document_links WHERE entity_type = $1 AND entity_id = $2`,
      [CORRECTION_ATTACHMENT_ENTITY_LITERAL, String(removedId)],
    );
    await sqlRows(exec, `DELETE FROM attendance_adjustments WHERE id = $1`, [removedId]);
  }
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
  updated_by?: string | null;
  metadata?: Record<string, unknown>;
  approval_status?: AdjustmentApprovalStatus;
  approved_by?: string | null;
  approved_at?: string | null;
}, exec?: DbExecutor): Promise<Record<string, unknown>> {
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
    } else if (input.approved_by != null) {
      // Статус approved/rejected проставлен сразу при создании (схлопывание
      // этапов): фиксируем согласующего, чтобы он был виден в истории.
      payload.approved_by = input.approved_by;
      payload.approved_at = input.approved_at ?? new Date().toISOString();
    }
  }

  // Динамический UPSERT: ON CONFLICT (employee_id, work_date, source_type, source_id) DO UPDATE.
  const keys = Object.keys(payload);
  const values = keys.map((k) => payload[k]);
  const cols = keys.map((k) => `"${k}"`).join(', ');
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
  const updateClauses = keys
    .filter((k) => !['employee_id', 'work_date', 'source_type', 'source_id'].includes(k))
    .map((k) => `"${k}" = EXCLUDED."${k}"`)
    .join(', ');

  const sql = updateClauses.length > 0
    ? `INSERT INTO attendance_adjustments (${cols}) VALUES (${placeholders})
         ON CONFLICT (employee_id, work_date, source_type, source_id)
         DO UPDATE SET ${updateClauses}
         RETURNING *`
    : `INSERT INTO attendance_adjustments (${cols}) VALUES (${placeholders})
         ON CONFLICT (employee_id, work_date, source_type, source_id) DO NOTHING
         RETURNING *`;

  const data = await sqlOne<Record<string, unknown>>(exec, sql, values);
  const survivor = data ?? await sqlOne<Record<string, unknown>>(
    exec,
    // ON CONFLICT DO NOTHING — вернём существующую строку.
    `SELECT * FROM attendance_adjustments
       WHERE employee_id = $1 AND work_date = $2 AND source_type = $3 AND source_id = $4
       LIMIT 1`,
    [input.employee_id, input.work_date, input.source_type, input.source_id ?? input.source_type],
  );
  if (!survivor) throw new Error('Failed to upsert attendance adjustment');

  // Дедуп day-level дублей другого источника (#5/#8): manual_object не трогаем.
  if (input.source_type !== OBJECT_ADJUSTMENT_SOURCE_TYPE) {
    try {
      await supersedeConflictingDayLevelAdjustments({
        id: Number(survivor.id),
        employee_id: input.employee_id,
        work_date: input.work_date,
        source_type: input.source_type,
        status: String(survivor.status ?? input.status),
      }, exec);
    } catch (error) {
      console.error('[attendance] supersedeConflictingDayLevelAdjustments error:', error);
    }
  }
  return survivor;
}

export async function deleteAttendanceAdjustmentBySource(input: {
  employee_id: number;
  work_date: string;
  source_type: string;
  source_id: string;
}): Promise<number[]> {
  const rows = await query<{ id: number | string }>(
    `DELETE FROM attendance_adjustments
       WHERE employee_id = $1
         AND work_date = $2
         AND source_type = $3
         AND source_id = $4
     RETURNING id`,
    [input.employee_id, input.work_date, input.source_type, input.source_id],
  );
  return rows.map(row => Number(row.id));
}

export async function getAttendanceAdjustmentById(id: number): Promise<Record<string, unknown> | null> {
  return queryOne<Record<string, unknown>>(
    `SELECT * FROM attendance_adjustments WHERE id = $1 LIMIT 1`,
    [id],
  );
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

  const keys = Object.keys(updates);
  if (keys.length === 0) {
    return queryOne<Record<string, unknown>>(
      `SELECT * FROM attendance_adjustments WHERE id = $1 LIMIT 1`,
      [id],
    );
  }
  const setClauses = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
  const values = keys.map((k) => updates[k]);
  values.push(id);

  return queryOne<Record<string, unknown>>(
    `UPDATE attendance_adjustments
       SET ${setClauses}
       WHERE id = $${values.length}
       RETURNING *`,
    values,
  );
}

export async function deleteAttendanceAdjustmentById(id: number): Promise<boolean> {
  const deleted = await queryOne<{ id: number }>(
    `DELETE FROM attendance_adjustments WHERE id = $1 RETURNING id`,
    [id],
  );
  return Boolean(deleted);
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
      .flatMap((item) => [item.updated_by, item.created_by, item.approved_by])
      .filter((id): id is string => Boolean(id)),
  )];

  const employeeIdsPresent = [...new Set(manualAdjustments.map((item) => item.employee_id))];

  const [authorRows, employeeRows] = await Promise.all([
    authorIds.length > 0
      ? query<{ id: string; full_name: string | null }>(
        `SELECT id, full_name FROM user_profiles WHERE id = ANY($1::uuid[])`,
        [authorIds],
      )
      : Promise.resolve([] as Array<{ id: string; full_name: string | null }>),
    employeeIdsPresent.length > 0
      ? query<{ id: number; full_name: string | null }>(
        `SELECT id, full_name FROM employees WHERE id = ANY($1::int[])`,
        [employeeIdsPresent],
      )
      : Promise.resolve([] as Array<{ id: number; full_name: string | null }>),
  ]);

  const authorNames = new Map(authorRows.map((row) => [String(row.id), String(row.full_name || '')]));
  const employeeNames = new Map(employeeRows.map((row) => [Number(row.id), String(row.full_name || '')]));

  return manualAdjustments.map((item) => {
    const latestAuthorId = item.updated_by ?? item.created_by;
    return {
      ...item,
      employee_full_name: employeeNames.get(item.employee_id) ?? null,
      author_name: latestAuthorId ? authorNames.get(latestAuthorId) ?? null : null,
      approver_name: item.approved_by ? authorNames.get(item.approved_by) ?? null : null,
    };
  });
}
