import { query, withTransaction } from '../config/postgres.js';
import type { TimesheetApproval } from '../types/index.js';
import {
  enumerateDatesInclusive,
  ownershipKey,
  ownsDay,
  resolveDayOwnership,
} from './timesheet-day-ownership.service.js';
import {
  buildMembershipWindowMap,
  isWithinMembershipWindow,
  listEmployeeMembershipsForDepartmentPeriod,
  resolveTimesheetPeriodRange,
} from './timesheet-department-assignments.service.js';
import { listLockingApprovalsForEmployeeDates, lockKey } from './timesheet-lock.service.js';
import type { IStaffWeekendBranch, IStaffWeekendGridRow } from './staff-weekends.service.js';

/**
 * «Выходные»: кнопки «Открыть табель» и «Закрыть табель» у отдела на половину месяца.
 *
 * Открывать надо все подачи, которые держат дни из списка этого отдела и половины: табель отдела и личные табели
 * руководителей, иначе день останется закрытым. Открытие — одной транзакцией, повтор с тем же operation_id безопасен.
 * Закрывается только открытое этой кнопкой: запись действует, пока unlocked_at совпадает с подачей (миграция 350).
 */

export type WeekendHalf = 1 | 2;

export interface IWeekendPeriod {
  half: WeekendHalf;
  start_date: string;
  end_date: string;
  can_open: boolean;
  can_close: boolean;
}

export interface IWeekendPeriodApproval {
  id: number;
  label: string;
  status: string;
  start_date: string;
  end_date: string;
  people_count: number;
}

export interface IWeekendPeriodOthers {
  department: string;
  count: number;
  /** Не больше OTHERS_NAMES_LIMIT, остальные — только в count. */
  names: string[];
}

export interface IWeekendPeriodPreview {
  half: WeekendHalf;
  start_date: string;
  end_date: string;
  expected_approval_ids: number[];
  approvals: IWeekendPeriodApproval[];
  others: IWeekendPeriodOthers[];
}

export type IWeekendPeriodApprovalRow = TimesheetApproval & {
  department_name: string | null;
  manager_name: string | null;
};

const OTHERS_NAMES_LIMIT = 10;

/** Штатный отказ операции: состав изменился или operation_id занят другой половиной. */
export class WeekendPeriodConflictError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'WeekendPeriodConflictError';
    this.code = code;
  }
}

const dayHalf = (date: string): WeekendHalf => (Number(date.slice(8, 10)) <= 15 ? 1 : 2);

/** Половина месяца YYYY-MM. Неверный месяц — null. */
export const weekendHalfRange = (month: string, half: WeekendHalf): { startDate: string; endDate: string } | null => {
  const range = resolveTimesheetPeriodRange(month);
  if (!range) return null;
  return half === 1
    ? { startDate: `${month}-01`, endDate: `${month}-15` }
    : { startDate: `${month}-16`, endDate: range.endDate };
};

export const approvalLabel = (row: Pick<IWeekendPeriodApprovalRow, 'department_name' | 'manager_name'>): string => (
  row.manager_name ? `Личный табель: ${row.manager_name}` : `Табель отдела: ${row.department_name ?? 'без названия'}`
);

const rowsOfHalf = (rows: ReadonlyArray<IStaffWeekendGridRow>, half: WeekendHalf) => rows.flatMap(row => row.days
  .filter(day => dayHalf(day) === half)
  .map(workDate => ({ employeeId: row.employee_id, workDate })));

/** Подачи, которые держат дни из списка этого отдела за половину. */
export const listLockingApprovalIds = async (
  rows: ReadonlyArray<IStaffWeekendGridRow>,
  half: WeekendHalf,
): Promise<number[]> => {
  const pairs = rowsOfHalf(rows, half);
  if (pairs.length === 0) return [];
  const locks = await listLockingApprovalsForEmployeeDates(pairs);
  const ids = new Set<number>();
  for (const pair of pairs) {
    for (const lock of locks.get(lockKey(pair.employeeId, pair.workDate)) ?? []) ids.add(Number(lock.id));
  }
  return [...ids].sort((a, b) => a - b);
};

/** Подачи, открытые кнопкой этого отдела и ещё открытые. Открытые вручную сюда не попадают. */
export const listActiveUnlocks = async (
  branchIds: readonly string[],
  periodStarts: readonly string[],
): Promise<IWeekendPeriodApprovalRow[]> => query<IWeekendPeriodApprovalRow & { branch_id: string; period_start: string }>(
  `SELECT DISTINCT ON (a.id, u.branch_id) a.*, d.name AS department_name, m.full_name AS manager_name,
          u.branch_id, u.period_start::text AS period_start
     FROM staff_weekend_unlocks u
     JOIN timesheet_approvals a ON a.id = u.approval_id AND a.unlocked_at = u.unlocked_at
     LEFT JOIN org_departments d ON d.id = a.department_id
     LEFT JOIN employees m ON m.id = a.manager_employee_id
    WHERE u.branch_id = ANY($1::uuid[])
      AND u.period_start = ANY($2::date[])
    ORDER BY a.id, u.branch_id`,
  [[...branchIds], [...periodStarts]],
);

/** Кнопки отделов: половина есть, если её можно открыть или закрыть. */
export const attachWeekendPeriods = async <Branch extends IStaffWeekendBranch>(
  month: string,
  branches: readonly Branch[],
): Promise<Array<Branch & { periods: IWeekendPeriod[] }>> => {
  const ranges = { 1: weekendHalfRange(month, 1), 2: weekendHalfRange(month, 2) } as const;
  if (!ranges[1] || !ranges[2]) return branches.map(branch => ({ ...branch, periods: [] }));

  const active = await listActiveUnlocks(
    branches.map(branch => branch.id),
    [ranges[1].startDate, ranges[2].startDate],
  ) as Array<IWeekendPeriodApprovalRow & { branch_id: string; period_start: string }>;

  return Promise.all(branches.map(async (branch) => {
    const periods: IWeekendPeriod[] = [];
    for (const half of [1, 2] as const) {
      const range = ranges[half]!;
      const canOpen = (await listLockingApprovalIds(branch.rows, half)).length > 0;
      const canClose = active.some(row => row.branch_id === branch.id && row.period_start === range.startDate);
      if (canOpen || canClose) {
        periods.push({ half, start_date: range.startDate, end_date: range.endDate, can_open: canOpen, can_close: canClose });
      }
    }
    return { ...branch, periods };
  }));
};

/** Кто ещё затронут: люди подач, чьи дни подача держит, а в этот день они не в этом отделе. */
const loadOthers = async (
  month: string,
  branchId: string,
  approvals: ReadonlyArray<IWeekendPeriodApprovalRow>,
  range: { startDate: string; endDate: string },
): Promise<IWeekendPeriodOthers[]> => {
  const monthRange = resolveTimesheetPeriodRange(month);
  if (!monthRange || approvals.length === 0) return [];

  const snapshot = await query<{ approval_id: number; employee_id: number }>(
    'SELECT approval_id, employee_id FROM timesheet_approval_employees WHERE approval_id = ANY($1::bigint[])',
    [approvals.map(approval => approval.id)],
  );
  const requests = approvals.map((approval) => {
    const from = String(approval.start_date) > range.startDate ? String(approval.start_date) : range.startDate;
    const to = String(approval.end_date) < range.endDate ? String(approval.end_date) : range.endDate;
    return {
      approvalId: Number(approval.id),
      departmentId: approval.department_id ?? null,
      managerEmployeeId: approval.manager_employee_id == null ? null : Number(approval.manager_employee_id),
      employeeIds: snapshot.filter(row => Number(row.approval_id) === Number(approval.id)).map(row => Number(row.employee_id)),
      dates: enumerateDatesInclusive(from, to),
    };
  });
  const ownership = await resolveDayOwnership(requests, undefined);
  const windows = buildMembershipWindowMap(await listEmployeeMembershipsForDepartmentPeriod(
    branchId, monthRange.startDate, monthRange.endDate, undefined, { firedInDismissalMonth: true },
  ));

  const foreign = new Set<number>();
  for (const request of requests) {
    for (const employeeId of request.employeeIds) {
      const window = windows.get(employeeId);
      const touched = request.dates.some(date => (
        ownsDay(ownership.get(ownershipKey(request.approvalId, employeeId, date)))
        && !(window !== undefined && isWithinMembershipWindow(window, date, 'viaTransferOnly'))
      ));
      if (touched) foreign.add(employeeId);
    }
  }
  if (foreign.size === 0) return [];

  const people = await query<{ full_name: string | null; department: string | null }>(
    `SELECT e.full_name, d.name AS department
       FROM employees e
       LEFT JOIN org_departments d ON d.id = e.org_department_id
      WHERE e.id = ANY($1::int[])`,
    [[...foreign]],
  );
  const byDepartment = new Map<string, string[]>();
  for (const person of people) {
    const department = person.department ?? 'Без отдела';
    byDepartment.set(department, [...(byDepartment.get(department) ?? []), person.full_name ?? '']);
  }
  return [...byDepartment.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'ru'))
    .map(([department, names]) => ({
      department,
      count: names.length,
      names: [...names].sort((a, b) => a.localeCompare(b, 'ru')).slice(0, OTHERS_NAMES_LIMIT),
    }));
};

const loadApprovals = (ids: readonly number[]): Promise<IWeekendPeriodApprovalRow[]> => query<IWeekendPeriodApprovalRow>(
  `SELECT a.*, a.start_date::text AS start_date, a.end_date::text AS end_date,
          d.name AS department_name, m.full_name AS manager_name
     FROM timesheet_approvals a
     LEFT JOIN org_departments d ON d.id = a.department_id
     LEFT JOIN employees m ON m.id = a.manager_employee_id
    WHERE a.id = ANY($1::bigint[])
    ORDER BY (a.manager_employee_id IS NULL) DESC, m.full_name, a.id`,
  [[...ids]],
);

/** Состав для окна подтверждения. Открытие считает его заново и сверяет с тем, что человек увидел. */
export const previewWeekendPeriod = async (
  month: string,
  half: WeekendHalf,
  branch: IStaffWeekendBranch,
): Promise<IWeekendPeriodPreview | null> => {
  const range = weekendHalfRange(month, half);
  if (!range) return null;

  const ids = await listLockingApprovalIds(branch.rows, half);
  const approvals = ids.length > 0 ? await loadApprovals(ids) : [];
  const counts = ids.length > 0
    ? await query<{ approval_id: number; people: number | string }>(
      `SELECT approval_id, count(*) AS people FROM timesheet_approval_employees
        WHERE approval_id = ANY($1::bigint[]) GROUP BY approval_id`,
      [ids],
    )
    : [];
  const peopleById = new Map(counts.map(row => [Number(row.approval_id), Number(row.people)]));

  return {
    half,
    start_date: range.startDate,
    end_date: range.endDate,
    expected_approval_ids: ids,
    approvals: approvals.map(approval => ({
      id: Number(approval.id),
      label: approvalLabel(approval),
      status: approval.status,
      start_date: String(approval.start_date),
      end_date: String(approval.end_date),
      people_count: peopleById.get(Number(approval.id)) ?? 0,
    })),
    others: await loadOthers(month, branch.id, approvals, range),
  };
};

export const loadApprovalsForAccessCheck = loadApprovals;

/** Подачи операции, если она уже была: повтор запроса возвращает её результат. */
export const findWeekendOperation = async (
  operationId: string,
): Promise<{ branch_id: string; period_start: string; approval_id: number }[]> => query(
  `SELECT branch_id, period_start::text AS period_start, approval_id
     FROM staff_weekend_unlocks
    WHERE operation_id = $1::uuid
    ORDER BY approval_id`,
  [operationId],
);

/**
 * Снять замок со всех подач разом. Не вышло хотя бы с одной (её успели закрыть, вернуть или открыть) —
 * откат, не открыто ничего. Время берётся из самой строки подачи, минуя JS: Date отбросил бы микросекунды,
 * и запись перестала бы совпадать с подачей.
 */
export const openApprovalsTogether = async (params: {
  operationId: string;
  branchId: string;
  periodStart: string;
  approvalIds: readonly number[];
  userId: string;
  reason: string | null;
}): Promise<TimesheetApproval[]> => withTransaction(async (client) => {
  const ids = [...params.approvalIds];
  // Блокировка по порядку id: две одновременные операции не сцепятся.
  await client.query('SELECT id FROM timesheet_approvals WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE', [ids]);

  const updated = await client.query<TimesheetApproval>(
    `UPDATE timesheet_approvals
        SET unlocked_at = NOW(),
            unlocked_by = $2,
            unlock_reason = $3,
            updated_at = NOW()
      WHERE id = ANY($1::bigint[])
        AND status IN ('submitted', 'approved')
        AND unlocked_at IS NULL
      RETURNING *`,
    [ids, params.userId, params.reason],
  );
  if (updated.rows.length !== ids.length) {
    throw new WeekendPeriodConflictError('PERIOD_SET_CHANGED', 'Состав табелей изменился — откройте окно заново');
  }

  await client.query(
    `INSERT INTO staff_weekend_unlocks (operation_id, branch_id, period_start, approval_id, unlocked_at)
     SELECT $1::uuid, $2::uuid, $3::date, a.id, a.unlocked_at
       FROM timesheet_approvals a
      WHERE a.id = ANY($4::bigint[])`,
    [params.operationId, params.branchId, params.periodStart, ids],
  );
  return updated.rows;
});
