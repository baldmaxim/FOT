import { query } from '../config/postgres.js';
import { buildAttendanceEntries } from './attendance.service.js';
import { countCorrectionAttachmentsLikeWindow } from './correction-attachments.service.js';
import { SOURCE_REQUEST_JOIN_CONDITION } from './correction-source-request.service.js';
import { getDayNormHours, loadCalendarMonth, resolveSchedulesForPeriod } from './schedule.service.js';
import { describeBranches, loadBranchOwnership } from './staff-branch-ownership.service.js';
import { resolveTimesheetPeriodRange } from './timesheet-department-assignments.service.js';
import { isMigratedDayLevelAdjustment } from './timesheet-object.service.js';

/**
 * «Управление кадрами» → «Корректировки»: правки часов, которые руководители ставят своим людям, — кадрам проверить.
 *
 * Правка — строка attendance_adjustments с часами (manual, manual_object, leave_request). Источник «Заявление» — если
 * правка получена согласованием заявления «Корректировка табеля» (правило окна дня, SOURCE_REQUEST_JOIN_CONDITION);
 * иначе «Табель». Правки проверяющих (админ, кадровый админ, кадры, табельщица) и системные в журнал не идут; у
 * правки из заявления смотрим, кто согласовал.
 *
 * Отдел строки — владелец дня (staff-branch-ownership: самый глубокий отдел, без подрядчиков и «Уволенных»), охват
 * пользователя — после. Часы «по СКУД» (как посчитал бы табель без правки) — отдельно и только для выбранного отдела:
 * расчёт посещаемости тяжёлый.
 */

/** Кто правки проверяет: их правки в журнал не идут. */
export const CORRECTION_CHECKER_ROLES: ReadonlySet<string> = new Set(['admin', 'hr_admin', 'hr', 'timekeeper']);

export type StaffCorrectionSource = 'table' | 'request';
/** Какое окно открывает строка: дня или объекта. */
export type StaffCorrectionWindow = 'day' | 'object';

export interface IStaffCorrectionRow {
  id: number;
  branch_id: string;
  employee_id: number;
  full_name: string;
  /** YYYY-MM-DD */
  work_date: string;
  /** Тип правки: work, manual, remote… — не approval_status. */
  status: string;
  hours: number | null;
  source: StaffCorrectionSource;
  window: StaffCorrectionWindow;
  object_id: string | null;
  object_name: string | null;
  /** «Табель» — кто поставил (последний, кто менял); «Заявление» — кто согласовал. */
  author_name: string | null;
  /** «Заявление» — кто подал. */
  applicant_name: string | null;
  /** updated_at ?? created_at, ISO. */
  changed_at: string;
  reason: string | null;
  attachments_count: number;
}

export interface IStaffCorrectionsList {
  branches: Array<{ id: string; name: string }>;
  rows: IStaffCorrectionRow[];
}

export interface IStaffCorrectionSkud {
  norm_hours: number | null;
  /** Часы по СКУД без правки; у объектной строки — часы на этом объекте. */
  skud_hours: number;
  first_entry: string | null;
  last_exit: string | null;
}

interface IAdjustmentRow {
  id: number | string;
  employee_id: number | string;
  work_date: string;
  status: string;
  hours_override: string | null;
  source_type: string;
  source_id: string | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  changed_at: Date | string;
  author_profile_id: string | null;
  author_name: string | null;
  author_role: string | null;
  employee_name: string | null;
  object_name: string | null;
}

interface ISourceRequestRow {
  adjustment_id: number | string;
  applicant_name: string | null;
  reviewer_profile_id: string | null;
  reviewer_name: string | null;
  reviewer_role: string | null;
}

const loadAdjustments = (employeeIds: readonly number[], startDate: string, endDate: string): Promise<IAdjustmentRow[]> => (
  query<IAdjustmentRow>(
    `SELECT a.id, a.employee_id, a.work_date::text AS work_date, a.status, a.hours_override::text AS hours_override,
            a.source_type, a.source_id, a.reason, a.metadata,
            COALESCE(a.updated_at, a.created_at) AS changed_at,
            up.id AS author_profile_id, up.full_name AS author_name, r.code AS author_role,
            e.full_name AS employee_name,
            so.name AS object_name
       FROM attendance_adjustments a
       JOIN employees e ON e.id = a.employee_id
       LEFT JOIN user_profiles up ON up.id = COALESCE(a.updated_by, a.created_by)
       LEFT JOIN system_roles r ON r.id = up.system_role_id
       -- Сравнение текстом: приведение source_id к uuid упало бы на дневных правках ('manual').
       LEFT JOIN skud_objects so
         ON a.source_type = 'manual_object'
        AND so.id::text = a.source_id
      WHERE a.employee_id = ANY($1::int[])
        AND a.work_date BETWEEN $2::date AND $3::date
        AND a.hours_override IS NOT NULL
        AND a.source_type IN ('manual', 'manual_object', 'leave_request')
      ORDER BY a.work_date, a.id`,
    [[...employeeIds], startDate, endDate],
  )
);

/** Пакетный вариант окна дня: правка → согласованное заявление, из которого она получена. */
const loadSourceRequests = async (adjustmentIds: readonly number[]): Promise<Map<number, ISourceRequestRow>> => {
  if (adjustmentIds.length === 0) return new Map();
  const rows = await query<ISourceRequestRow>(
    `SELECT DISTINCT ON (a.id) a.id AS adjustment_id,
            e.full_name AS applicant_name,
            up.id AS reviewer_profile_id, up.full_name AS reviewer_name, r.code AS reviewer_role
       FROM attendance_adjustments a
       JOIN leave_requests lr
         ON ${SOURCE_REQUEST_JOIN_CONDITION}
       LEFT JOIN employees e ON e.id = lr.employee_id
       LEFT JOIN user_profiles up ON up.id = lr.reviewer_id
       LEFT JOIN system_roles r ON r.id = up.system_role_id
      WHERE a.id = ANY($1::bigint[])
      ORDER BY a.id, lr.reviewed_at DESC`,
    [[...adjustmentIds]],
  );
  return new Map(rows.map(row => [Number(row.adjustment_id), row]));
};

/** Правка руководителя: автор (у заявления — согласовавший) с профилем и не из проверяющих. */
const isManagerCorrection = (profileId: string | null, roleCode: string | null): boolean => (
  Boolean(profileId) && !CORRECTION_CHECKER_ROLES.has(roleCode ?? '')
);

const windowOf = (row: IAdjustmentRow): StaffCorrectionWindow => (
  row.source_type === 'manual_object' && !isMigratedDayLevelAdjustment({ source_type: row.source_type, metadata: row.metadata })
    ? 'object'
    : 'day'
);

/**
 * Правки руководителей за месяц YYYY-MM в видимых отделах. Владелец дня — по всем кандидатам, охват — после:
 * правка в бригаде не переезжает в доступный отдел-родитель.
 */
export const listStaffCorrections = async (
  month: string,
  { ownershipBranchIds, visibleBranchIds }: { ownershipBranchIds: readonly string[]; visibleBranchIds: readonly string[] },
): Promise<IStaffCorrectionsList> => {
  const range = resolveTimesheetPeriodRange(month);
  if (!range || visibleBranchIds.length === 0) return { branches: [], rows: [] };

  const visible = new Set(visibleBranchIds);
  const ownership = await loadBranchOwnership(month, ownershipBranchIds);
  if (ownership.employeeIds.length === 0) return { branches: [], rows: [] };

  const adjustments = (await loadAdjustments(ownership.employeeIds, range.startDate, range.endDate))
    .map(row => ({ row, branchId: ownership.ownerOf(Number(row.employee_id), row.work_date) }))
    .filter((item): item is { row: IAdjustmentRow; branchId: string } => item.branchId !== null && visible.has(item.branchId));
  if (adjustments.length === 0) return { branches: [], rows: [] };

  const sourceRequests = await loadSourceRequests(adjustments.map(({ row }) => Number(row.id)));
  const picked = adjustments.filter(({ row }) => {
    const request = sourceRequests.get(Number(row.id));
    return request
      ? isManagerCorrection(request.reviewer_profile_id, request.reviewer_role)
      : isManagerCorrection(row.author_profile_id, row.author_role);
  });
  if (picked.length === 0) return { branches: [], rows: [] };

  const attachments = await countCorrectionAttachmentsLikeWindow(picked.map(({ row }) => ({
    id: Number(row.id),
    employee_id: Number(row.employee_id),
    work_date: row.work_date,
    source_type: row.source_type,
    source_id: row.source_id,
  })));

  const rows = picked.map(({ row, branchId }): IStaffCorrectionRow => {
    const request = sourceRequests.get(Number(row.id));
    const window = windowOf(row);
    return {
      id: Number(row.id),
      branch_id: branchId,
      employee_id: Number(row.employee_id),
      full_name: row.employee_name ?? '',
      work_date: row.work_date,
      status: row.status,
      hours: row.hours_override === null ? null : Number(row.hours_override),
      source: request ? 'request' : 'table',
      window,
      object_id: window === 'object' ? row.source_id : null,
      object_name: window === 'object' ? (row.object_name ?? null) : null,
      author_name: request ? request.reviewer_name : row.author_name,
      applicant_name: request ? request.applicant_name : null,
      changed_at: new Date(row.changed_at).toISOString(),
      reason: row.reason,
      attachments_count: attachments.get(Number(row.id)) ?? 0,
    };
  });

  return {
    branches: await describeBranches([...new Set(rows.map(row => row.branch_id))]),
    rows,
  };
};

/**
 * Часы «по СКУД» для правок отдела: день как без правки (расчёт табеля с ignoreAdjustments, без записи «Дороги»),
 * у настоящей объектной правки — часы на её объекте; проходов на объекте нет — 0 и пустой вход–выход (вход–выход дня
 * в поля объекта не подставляем). showActualHours — как в сетке роли: факт или урезанное под график.
 */
export const computeStaffCorrectionSkud = async (
  month: string,
  rows: ReadonlyArray<Pick<IStaffCorrectionRow, 'id' | 'employee_id' | 'work_date' | 'window' | 'object_id'>>,
  showActualHours: boolean,
): Promise<Record<number, IStaffCorrectionSkud>> => {
  const range = resolveTimesheetPeriodRange(month);
  if (!range || rows.length === 0) return {};

  const employeeIds = [...new Set(rows.map(row => row.employee_id))];
  const [schedules, calendar] = await Promise.all([
    resolveSchedulesForPeriod(employeeIds.map(id => ({ id })), range.startDate, range.endDate),
    loadCalendarMonth(range.year, range.month),
  ]);
  const { entries, objectEntries } = await buildAttendanceEntries({
    employees: employeeIds.map(id => ({ id, full_name: null })),
    startDate: range.startDate,
    endDate: range.endDate,
    dailySchedulesMap: schedules,
    calendarMonth: calendar,
    displayMode: 'actual',
    includeObjectDetails: true,
    persistTravelSegments: false,
    ignoreAdjustments: true,
  });
  const entryByKey = new Map(entries.map(entry => [`${entry.employee_id}|${entry.work_date}`, entry]));
  const objectHoursByKey = new Map<string, number>();
  for (const entry of objectEntries) {
    if (!entry.object_id) continue;
    const key = `${entry.employee_id}|${entry.work_date}|${entry.object_id}`;
    const hours = showActualHours ? entry.hours_worked : entry.display_hours_worked;
    objectHoursByKey.set(key, (objectHoursByKey.get(key) ?? 0) + (Number(hours) || 0));
  }

  const result: Record<number, IStaffCorrectionSkud> = {};
  for (const row of rows) {
    const schedule = schedules.get(row.employee_id)?.get(row.work_date);
    const normHours = schedule
      ? getDayNormHours(schedule, new Date(`${row.work_date}T00:00:00`), calendar)
      : null;
    if (row.window === 'object') {
      const hours = objectHoursByKey.get(`${row.employee_id}|${row.work_date}|${row.object_id ?? ''}`) ?? 0;
      result[row.id] = { norm_hours: normHours, skud_hours: Math.round(hours * 100) / 100, first_entry: null, last_exit: null };
      continue;
    }
    const entry = entryByKey.get(`${row.employee_id}|${row.work_date}`);
    const hours = entry ? (showActualHours ? entry.hours_worked : entry.display_hours_worked) : 0;
    result[row.id] = {
      norm_hours: normHours,
      skud_hours: Math.round((Number(hours) || 0) * 100) / 100,
      first_entry: entry?.first_entry ?? null,
      last_exit: entry?.last_exit ?? null,
    };
  }
  return result;
};
