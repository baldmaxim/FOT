/**
 * Снимок дня ФОТ для выравнивания табеля по 1С (ЗУП): что ФОТ сейчас отдаёт в 1С и в зарплату по дню сотрудника.
 *
 * Один код и для файла правок (план), и для скрипта перед записью: отпечаток дня в плане сравнивается с отпечатком
 * под advisory-локами — изменился хоть один день → откат всего прогона.
 *
 * Источник — тот же, что у официальной редакции и предварительного расчёта: живой табель
 * (`fetchTimesheetDataForEmployees`, actual, snapshot roster) → основа (`buildBasisDraftsForDays`). Плюс строки
 * `attendance_adjustments` дня, объектные записи дня без «эха» дневной правки и закрытые подачи, покрывающие день.
 */
import crypto from 'node:crypto';
import type { DbExecutor } from '../config/postgres.js';
import { canonicalJson } from '../utils/canonical-json.js';
import { buildBasisDraftsForDays, type IBasisDayValue, type IPayrollBasisDraft } from './payroll/payroll-basis.service.js';
import { fetchTimesheetDataForEmployees, type IExportDayValue } from './timesheet-export.service.js';
import type { IAttendanceObjectEntry } from './timesheet-object.service.js';
import { getDayNormHours, isWorkingDay } from './schedule.service.js';

/** Порция сотрудников на один вызов живого табеля; ZUP_SNAPSHOT_CHUNK — меньше для слабого пула (роль только чтения). */
const SNAPSHOT_CHUNK = Number.parseInt(process.env.ZUP_SNAPSHOT_CHUNK ?? '', 10) || 150;

export interface IZupPair {
  employeeId: number;
  /** YYYY-MM-DD. */
  date: string;
}

export interface IZupObjectSnapshot {
  key: string;
  objectId: string | null;
  name: string;
  /** Адрес объекта для 1С: skud_objects.alt_name, иначе name — как в «Едином 1С». */
  address: string | null;
  hours: number;
  baseHours: number;
  isCorrection: boolean;
}

export interface IZupAdjustmentRow {
  id: number;
  source_type: string;
  source_id: string;
  status: string;
  hours_override: number | null;
  reason: string | null;
  approval_status: string | null;
  updated_at: string;
  metadata: Record<string, unknown>;
}

export interface IZupDaySnapshot {
  employeeId: number;
  date: string;
  /** День живого табеля; null — дня в табеле нет. */
  status: string | null;
  hours: number | null;
  corrected: boolean;
  overridden: boolean;
  dropped: boolean;
  /** Как день идёт в основу: рабочий для оклада, выход в выходной, отсутствие или никак. */
  kind: 'workday' | 'dayoff' | 'absence' | null;
  absence: string | null;
  paidMinutes: number | null;
  overtimeMinutes: number | null;
  /** Норма дня по графику (0 — нерабочий) и рабочий ли день по графику и календарю; null — графика нет. */
  normHours: number | null;
  workingDay: boolean | null;
  objects: IZupObjectSnapshot[];
  adjustments: IZupAdjustmentRow[];
  closedApprovalIds: number[];
  fingerprint: string;
}

export const zupPairKey = (employeeId: number, date: string): string => `${employeeId}|${date}`;

const monthBounds = (month: string): { start: string; end: string } => {
  const [year, mon] = month.split('-').map(Number);
  const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}` };
};

/** День живого табеля → день основы, как в редакции (то же, что toBasisDays предварительного расчёта). */
const toBasisDays = (dayMap: ReadonlyMap<string, IExportDayValue> | undefined): Record<string, IBasisDayValue> => {
  const days: Record<string, IBasisDayValue> = {};
  for (const [date, value] of dayMap ?? []) {
    days[date] = {
      status: value.status,
      hours: typeof value.hours === 'number' ? value.hours : 0,
      hours_overridden: Boolean(value.hoursOverridden),
    };
  }
  return days;
};

const classify = (
  draft: IPayrollBasisDraft | undefined,
  date: string,
): Pick<IZupDaySnapshot, 'kind' | 'absence' | 'paidMinutes' | 'overtimeMinutes'> => {
  if (!draft) return { kind: null, absence: null, paidMinutes: null, overtimeMinutes: null };
  const paid = draft.paidMinutes?.[date];
  const overtime = draft.overtimeMinutes?.[date];
  const minutes = {
    paidMinutes: typeof paid === 'number' ? paid : null,
    overtimeMinutes: typeof overtime === 'number' ? overtime : null,
  };
  if (draft.workdayDates.includes(date)) return { kind: 'workday', absence: null, ...minutes };
  if (draft.dayoffDates.includes(date)) return { kind: 'dayoff', absence: null, ...minutes };
  for (const [status, dates] of Object.entries(draft.absenceDates)) {
    if ((dates as string[]).includes(date)) return { kind: 'absence', absence: status, ...minutes };
  }
  return { kind: null, absence: null, ...minutes };
};

/** Отпечаток дня: всё, от чего зависит, что ФОТ отдаёт по дню и какие строки дня есть. */
export const zupDayFingerprint = (snapshot: Omit<IZupDaySnapshot, 'fingerprint'>): string => crypto
  .createHash('sha256')
  .update(canonicalJson({
    status: snapshot.status,
    hours: snapshot.hours,
    corrected: snapshot.corrected,
    overridden: snapshot.overridden,
    dropped: snapshot.dropped,
    kind: snapshot.kind,
    absence: snapshot.absence,
    paidMinutes: snapshot.paidMinutes,
    overtimeMinutes: snapshot.overtimeMinutes,
    normHours: snapshot.normHours,
    workingDay: snapshot.workingDay,
    objects: snapshot.objects.map(object => ({
      key: object.key, hours: object.hours, baseHours: object.baseHours, isCorrection: object.isCorrection,
    })),
    adjustments: snapshot.adjustments.map(row => ({
      id: row.id,
      source_type: row.source_type,
      source_id: row.source_id,
      status: row.status,
      hours_override: row.hours_override,
      approval_status: row.approval_status,
      updated_at: row.updated_at,
    })),
    closedApprovalIds: snapshot.closedApprovalIds,
  }))
  .digest('hex');

const loadAdjustments = async (
  exec: DbExecutor,
  pairs: readonly IZupPair[],
): Promise<Map<string, IZupAdjustmentRow[]>> => {
  const result = await exec.query<{
    id: number | string; employee_id: number; work_date: string; source_type: string; source_id: string;
    status: string; hours_override: string | null; reason: string | null; approval_status: string | null;
    updated_at: string; metadata: Record<string, unknown> | null;
  }>(
    `SELECT a.id, a.employee_id, a.work_date::text AS work_date, a.source_type, a.source_id, a.status,
            a.hours_override::text AS hours_override, a.reason, a.approval_status,
            to_char(a.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at, a.metadata
       FROM unnest($1::int[], $2::date[]) AS p(employee_id, work_date)
       JOIN attendance_adjustments a ON a.employee_id = p.employee_id AND a.work_date = p.work_date
      ORDER BY a.employee_id, a.work_date, a.id`,
    [pairs.map(pair => pair.employeeId), pairs.map(pair => pair.date)],
  );
  const map = new Map<string, IZupAdjustmentRow[]>();
  for (const row of result.rows) {
    const key = zupPairKey(row.employee_id, row.work_date);
    const list = map.get(key) ?? [];
    list.push({
      id: Number(row.id),
      source_type: row.source_type,
      source_id: row.source_id,
      status: row.status,
      hours_override: row.hours_override == null ? null : Number(row.hours_override),
      reason: row.reason,
      approval_status: row.approval_status,
      updated_at: row.updated_at,
      metadata: row.metadata ?? {},
    });
    map.set(key, list);
  }
  return map;
};

/** Закрытые (approved, под замком) подачи, в составе которых сотрудник и которые покрывают день. */
const loadClosedApprovals = async (
  exec: DbExecutor,
  pairs: readonly IZupPair[],
): Promise<Map<string, number[]>> => {
  const result = await exec.query<{ employee_id: number; work_date: string; id: number | string }>(
    `SELECT DISTINCT p.employee_id, p.work_date::text AS work_date, a.id
       FROM unnest($1::int[], $2::date[]) AS p(employee_id, work_date)
       JOIN timesheet_approval_employees s ON s.employee_id = p.employee_id
       JOIN timesheet_approvals a
         ON a.id = s.approval_id
        AND a.status = 'approved'
        AND a.unlocked_at IS NULL
        AND a.start_date <= p.work_date
        AND a.end_date   >= p.work_date
      ORDER BY 1, 2, 3`,
    [pairs.map(pair => pair.employeeId), pairs.map(pair => pair.date)],
  );
  const map = new Map<string, number[]>();
  for (const row of result.rows) {
    const key = zupPairKey(row.employee_id, row.work_date);
    map.set(key, [...(map.get(key) ?? []), Number(row.id)]);
  }
  return map;
};

const loadObjectAddresses = async (exec: DbExecutor, objectIds: string[]): Promise<Map<string, string>> => {
  const map = new Map<string, string>();
  if (objectIds.length === 0) return map;
  const result = await exec.query<{ id: string; alt_name: string | null; name: string }>(
    'SELECT id, alt_name, name FROM skud_objects WHERE id = ANY($1::uuid[])',
    [objectIds],
  );
  for (const row of result.rows) {
    const alt = row.alt_name?.trim();
    map.set(row.id, alt && alt.length > 0 ? alt : row.name);
  }
  return map;
};

/**
 * Снимки дней (сотрудник, дата) одного месяца. exec — клиент транзакции скрипта (основа, строки, подачи читаются
 * им); живой табель читается через пул — fetchTimesheetDataForEmployees клиента не принимает, параллельные правки
 * дней при этом держат advisory-локи скрипта.
 */
export const loadZupDaySnapshots = async (
  exec: DbExecutor,
  month: string,
  pairs: readonly IZupPair[],
): Promise<Map<string, IZupDaySnapshot>> => {
  const result = new Map<string, IZupDaySnapshot>();
  if (pairs.length === 0) return result;
  const { start, end } = monthBounds(month);
  if (pairs.some(pair => pair.date < start || pair.date > end)) throw new Error(`Дата вне месяца ${month}`);
  const employeeIds = [...new Set(pairs.map(pair => pair.employeeId))].sort((a, b) => a - b);

  // Порциями: живой табель тысячи людей одним вызовом держит все соединения пула дольше его таймаута подключения.
  const dayMaps = new Map<number, ReadonlyMap<string, IExportDayValue>>();
  const draftById = new Map<number, IPayrollBasisDraft>();
  const wanted = new Set(pairs.map(pair => zupPairKey(pair.employeeId, pair.date)));
  const objectsByPair = new Map<string, IAttendanceObjectEntry[]>();
  const normByPair = new Map<string, { normHours: number | null; workingDay: boolean | null }>();
  for (let index = 0; index < employeeIds.length; index += SNAPSHOT_CHUNK) {
    const chunk = employeeIds.slice(index, index + SNAPSHOT_CHUNK);
    const data = await fetchTimesheetDataForEmployees(
      month, chunk, 'ЗУП: сверка', { startDate: start, endDate: end }, 'actual', true, { rosterMode: 'snapshot' },
    );
    for (const employeeId of chunk) {
      const dayMap = data.dataMap.get(employeeId);
      if (dayMap) dayMaps.set(employeeId, dayMap);
    }
    for (const pair of pairs) {
      if (!chunk.includes(pair.employeeId)) continue;
      const schedule = data.dailySchedulesMap.get(pair.employeeId)?.get(pair.date) ?? data.schedulesMap.get(pair.employeeId);
      const [year, mon, dom] = pair.date.split('-').map(Number);
      const dateObj = new Date(year, mon - 1, dom);
      normByPair.set(zupPairKey(pair.employeeId, pair.date), schedule
        ? { normHours: getDayNormHours(schedule, dateObj, data.calendarMonth), workingDay: isWorkingDay(schedule, dateObj, data.calendarMonth) }
        : { normHours: null, workingDay: null });
    }
    const drafts = await buildBasisDraftsForDays(exec, {
      start_date: start,
      end_date: end,
      employees: chunk.map(employeeId => ({ employee_id: employeeId, days: toBasisDays(data.dataMap.get(employeeId)) })),
    });
    for (const draft of drafts) draftById.set(draft.employeeId, draft);
    for (const entry of data.objectEntries) {
      if (entry.from_day_level) continue;
      const key = zupPairKey(entry.employee_id, entry.work_date);
      if (!wanted.has(key)) continue;
      objectsByPair.set(key, [...(objectsByPair.get(key) ?? []), entry]);
    }
  }
  const objectIds = [...new Set([...objectsByPair.values()].flat().map(entry => entry.object_id).filter((id): id is string => !!id))];
  const [adjustments, approvals, addresses] = await Promise.all([
    loadAdjustments(exec, pairs),
    loadClosedApprovals(exec, pairs),
    loadObjectAddresses(exec, objectIds),
  ]);

  for (const pair of pairs) {
    const key = zupPairKey(pair.employeeId, pair.date);
    if (result.has(key)) continue;
    const day = dayMaps.get(pair.employeeId)?.get(pair.date);
    const objects = (objectsByPair.get(key) ?? [])
      .map(entry => ({
        key: entry.object_key,
        objectId: entry.object_id,
        name: entry.object_name,
        address: entry.object_id ? addresses.get(entry.object_id) ?? null : null,
        hours: Number(entry.hours_worked ?? 0),
        baseHours: Number(entry.base_hours_worked ?? 0),
        isCorrection: Boolean(entry.is_correction),
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
    const base: Omit<IZupDaySnapshot, 'fingerprint'> = {
      employeeId: pair.employeeId,
      date: pair.date,
      status: day?.status ?? null,
      hours: day == null ? null : (typeof day.hours === 'number' ? day.hours : 0),
      corrected: Boolean(day?.corrected),
      overridden: Boolean(day?.hoursOverridden),
      dropped: Boolean(day?.hoursDropped),
      ...classify(draftById.get(pair.employeeId), pair.date),
      ...(normByPair.get(key) ?? { normHours: null, workingDay: null }),
      objects,
      adjustments: adjustments.get(key) ?? [],
      closedApprovalIds: approvals.get(key) ?? [],
    };
    result.set(key, { ...base, fingerprint: zupDayFingerprint(base) });
  }
  return result;
};
