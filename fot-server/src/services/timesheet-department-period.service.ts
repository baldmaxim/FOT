import { query } from '../config/postgres.js';
import type { TimesheetApproval } from '../types/index.js';
import {
  buildMembershipWindowMap,
  isWithinMembershipWindow,
  listEmployeeMembershipsForDepartmentPeriod,
} from './timesheet-department-assignments.service.js';
import { loadOwnedApprovalDaysForEmployeesInPeriod } from './timesheet-lock.service.js';
import {
  approvalLabel,
  loadApprovals,
  openApprovalsWithRecords,
  weekendHalfRange,
  WeekendPeriodConflictError,
  type IWeekendPeriodApprovalRow,
  type WeekendHalf,
} from './staff-weekends-periods.service.js';

/**
 * «Табель» → режим «По отделу»: кнопки «Открыть табель» и «Закрыть табель» за 1–15, 16–31 или весь месяц.
 *
 * Открывается всё, что держит дни людей отдела: табель отдела по половинам и личные табели руководителей (иначе
 * их строки в сетке остаются закрытыми). Набор — тот же, что сетка показывает замком
 * (loadOwnedApprovalDaysForEmployeesInPeriod), с окном членства в отделе. Открытие — одной транзакцией, повтор с
 * тем же operation_id безопасен; учёт — общий с «Выходными» (staff_weekend_unlocks, branch_id = отдел).
 *
 * Закрываются подачи самого отдела, открытые любым способом, и подачи, открытые кнопкой этого отдела. Личный
 * табель, открытый вручную, не трогается.
 */

export interface IDepartmentPeriodHalf {
  half: WeekendHalf;
  startDate: string;
  endDate: string;
}

export interface IDepartmentPeriodRange {
  month: string;
  startDate: string;
  endDate: string;
  halves: IDepartmentPeriodHalf[];
}

export interface IDepartmentPeriodApprovalInfo {
  id: number;
  label: string;
  status: string;
  start_date: string;
  end_date: string;
  unlocked: boolean;
}

export interface IDepartmentPeriodHalfState {
  half: WeekendHalf;
  start_date: string;
  end_date: string;
  /** Закрытые подачи, которые держат дни людей отдела в этой половине. */
  open_ids: number[];
  /** Открытые подачи, которые закроет «Закрыть табель» этой половины. */
  close_ids: number[];
}

export interface IDepartmentPeriodState {
  start_date: string;
  end_date: string;
  halves: IDepartmentPeriodHalfState[];
  approvals: IDepartmentPeriodApprovalInfo[];
}

export interface IDepartmentPeriodPreview extends IDepartmentPeriodState {
  expected_approval_ids: number[];
}

/** Доступ пользователя к подаче (ensureApprovalAccess контроллера). Недоступные не открываются и не закрываются. */
export type TApprovalAccessCheck = (approval: IWeekendPeriodApprovalRow) => Promise<boolean>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const sortedUnique = (ids: Iterable<number>): number[] => [...new Set([...ids].map(Number))].sort((a, b) => a - b);

/** Диапазон табеля → половины месяца: 1–15, 16–последний или весь месяц. Другие диапазоны — null. */
export const resolveDepartmentPeriodRange = (startDate: string, endDate: string): IDepartmentPeriodRange | null => {
  if (!ISO_DATE.test(startDate) || !ISO_DATE.test(endDate)) return null;
  const month = startDate.slice(0, 7);
  if (endDate.slice(0, 7) !== month) return null;
  const first = weekendHalfRange(month, 1);
  const second = weekendHalfRange(month, 2);
  if (!first || !second) return null;
  const halves: IDepartmentPeriodHalf[] = [];
  if (startDate === first.startDate && endDate === first.endDate) {
    halves.push({ half: 1, ...first });
  } else if (startDate === second.startDate && endDate === second.endDate) {
    halves.push({ half: 2, ...second });
  } else if (startDate === first.startDate && endDate === second.endDate) {
    halves.push({ half: 1, ...first }, { half: 2, ...second });
  } else {
    return null;
  }
  return { month, startDate, endDate, halves };
};

/** Закрытые подачи, которые держат дни людей отдела в половине (в пределах их окна членства). */
const listOpenableIds = async (departmentId: string, half: IDepartmentPeriodHalf): Promise<number[]> => {
  const memberships = await listEmployeeMembershipsForDepartmentPeriod(
    departmentId, half.startDate, half.endDate, undefined, { firedInDismissalMonth: true },
  );
  if (memberships.length === 0) return [];
  const windows = buildMembershipWindowMap(memberships);
  const owned = await loadOwnedApprovalDaysForEmployeesInPeriod(
    memberships.map(m => m.employee_id), half.startDate, half.endDate,
  );
  const ids = new Set<number>();
  for (const row of owned) {
    const window = windows.get(row.employee_id);
    if (row.dates.some(date => isWithinMembershipWindow(window, date, 'viaTransferOnly'))) ids.add(row.approval_id);
  }
  return sortedUnique(ids);
};

/**
 * Открытые подачи, держащие половину: свои подачи отдела (кем бы ни открыты) и открытые кнопкой этого отдела
 * («Табель» или «Выходные»). Запись кнопки действует, пока unlocked_at совпадает с подачей; половина записи не
 * важна — личный табель на весь месяц, открытый из «1–15», закрывается и из «16–31».
 */
const listClosableIds = async (departmentId: string, half: IDepartmentPeriodHalf): Promise<number[]> => {
  const rows = await query<{ id: number | string }>(
    `SELECT a.id
       FROM timesheet_approvals a
      WHERE a.unlocked_at IS NOT NULL
        AND a.start_date <= $3::date
        AND a.end_date >= $2::date
        AND (
          (a.department_id = $1::uuid AND a.manager_employee_id IS NULL)
          OR EXISTS (
            SELECT 1 FROM staff_weekend_unlocks u
             WHERE u.approval_id = a.id
               AND u.branch_id = $1::uuid
               AND u.unlocked_at = a.unlocked_at
          )
        )`,
    [departmentId, half.startDate, half.endDate],
  );
  return sortedUnique(rows.map(row => Number(row.id)));
};

/** Оставляет подачи, доступные пользователю; результат проверки — на подачу, а не на половину. */
const filterAccessible = async (
  approvals: readonly IWeekendPeriodApprovalRow[],
  canAccess: TApprovalAccessCheck,
): Promise<Map<number, IWeekendPeriodApprovalRow>> => {
  const accessible = new Map<number, IWeekendPeriodApprovalRow>();
  for (const approval of approvals) {
    if (await canAccess(approval)) accessible.set(Number(approval.id), approval);
  }
  return accessible;
};

const toInfo = (approval: IWeekendPeriodApprovalRow): IDepartmentPeriodApprovalInfo => ({
  id: Number(approval.id),
  label: approvalLabel(approval),
  status: approval.status,
  start_date: String(approval.start_date),
  end_date: String(approval.end_date),
  unlocked: approval.unlocked_at != null,
});

const computeState = async (
  departmentId: string,
  range: IDepartmentPeriodRange,
  canAccess: TApprovalAccessCheck,
): Promise<IDepartmentPeriodState> => {
  const raw = await Promise.all(range.halves.map(async half => ({
    half,
    openIds: await listOpenableIds(departmentId, half),
    closeIds: await listClosableIds(departmentId, half),
  })));
  const allIds = sortedUnique(raw.flatMap(item => [...item.openIds, ...item.closeIds]));
  const approvalsById = allIds.length > 0
    ? await filterAccessible(await loadApprovals(allIds), canAccess)
    : new Map<number, IWeekendPeriodApprovalRow>();
  const keep = (ids: readonly number[]) => ids.filter(id => approvalsById.has(id));

  return {
    start_date: range.startDate,
    end_date: range.endDate,
    halves: raw.map(item => ({
      half: item.half.half,
      start_date: item.half.startDate,
      end_date: item.half.endDate,
      open_ids: keep(item.openIds),
      close_ids: keep(item.closeIds),
    })),
    approvals: [...approvalsById.values()].map(toInfo),
  };
};

const openIdsOf = (state: IDepartmentPeriodState): number[] => sortedUnique(state.halves.flatMap(half => half.open_ids));

/** Кнопки отдела: что можно открыть и закрыть по каждой половине диапазона. */
export const getDepartmentPeriodState = async (
  departmentId: string,
  range: IDepartmentPeriodRange,
  canAccess: TApprovalAccessCheck,
): Promise<IDepartmentPeriodState> => computeState(departmentId, range, canAccess);

/**
 * Состав на момент окна подтверждения: какие подачи откроются. Открытие сверяет с ним свой расчёт — если состав
 * успел поменяться, не открывается ничего. Списков в окне нет (как у прежнего «Открыть табель»).
 */
export const previewDepartmentPeriod = async (
  departmentId: string,
  range: IDepartmentPeriodRange,
  canAccess: TApprovalAccessCheck,
): Promise<IDepartmentPeriodPreview> => {
  const state = await computeState(departmentId, range, canAccess);
  return { ...state, expected_approval_ids: openIdsOf(state) };
};

/**
 * Открыть всё разом. Состав считается заново и сверяется с тем, что человек подтвердил: разошёлся — 409, ничего не
 * открыто. У каждой половины своя запись об открытии со своим operation_id.
 */
export const openDepartmentPeriod = async (params: {
  departmentId: string;
  range: IDepartmentPeriodRange;
  operationIds: Partial<Record<WeekendHalf, string>>;
  expectedIds: readonly number[];
  userId: string;
  reason: string | null;
  canAccess: TApprovalAccessCheck;
}): Promise<TimesheetApproval[]> => {
  const state = await computeState(params.departmentId, params.range, params.canAccess);
  const ids = openIdsOf(state);
  const expected = sortedUnique(params.expectedIds);
  if (ids.length === 0 || ids.length !== expected.length || ids.some((id, index) => id !== expected[index])) {
    throw new WeekendPeriodConflictError('PERIOD_SET_CHANGED', 'Состав табелей изменился — откройте окно заново');
  }
  const records = state.halves.map((half) => {
    const operationId = params.operationIds[half.half];
    if (!operationId) throw new WeekendPeriodConflictError('OPERATION_ID_MISSING', 'Нет идентификатора операции');
    return { operationId, branchId: params.departmentId, periodStart: half.start_date, approvalIds: half.open_ids };
  });
  return openApprovalsWithRecords({ approvalIds: ids, userId: params.userId, reason: params.reason, records });
};

/** Подачи, которые закроет «Закрыть табель» диапазона, с данными для closeApprovalPeriod. */
export const listDepartmentPeriodCloseTargets = async (
  departmentId: string,
  range: IDepartmentPeriodRange,
  canAccess: TApprovalAccessCheck,
): Promise<IWeekendPeriodApprovalRow[]> => {
  const ids = sortedUnique((await Promise.all(range.halves.map(half => listClosableIds(departmentId, half)))).flat());
  if (ids.length === 0) return [];
  return [...(await filterAccessible(await loadApprovals(ids), canAccess)).values()];
};
