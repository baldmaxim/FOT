import { query, type DbExecutor } from '../config/postgres.js';
import type { TimesheetApproval } from '../types/index.js';
import {
  resolveLeaveApproverEmployeeIdsByEmployee,
  resolveResponsibleEmployeeIdsForRows,
} from './approval-routing.service.js';
import { listVisibleApprovalEmployees } from './timesheet-approval-employees-snapshot.service.js';
import {
  buildMembershipWindowMap,
  isWithinMembershipWindow,
  listEmployeeMembershipsForDepartmentPeriod,
  type IMembershipWindow,
} from './timesheet-department-assignments.service.js';
import type { ITimesheetDateRange } from './timesheet-range.service.js';

/**
 * Нерешённые выходные в периоде табеля — один источник для HR-гейта утверждения,
 * статуса «Ждёт согласования выходных» и уведомления «готов к утверждению».
 *
 * Два вида ожидания:
 *  - день у согласующего (2-й этап): attendance_adjustments.approval_status = 'pending';
 *  - заявление «Работа в выходной» на 1-м этапе: leave_requests work/pending, дни которого
 *    ещё не материализованы (материализованные уже учтены первым видом).
 *
 * Отдел — по окну членства 'viaTransferOnly' (как основной грид): чужой выход после
 * перевода не считается, «грязный» effective_from без перевода — считается.
 * «По людям» — без окна.
 */

export type IPendingScope =
  | { kind: 'department'; departmentId: string }
  | { kind: 'personal'; employeeIds: number[] };

export interface IPendingDecisionDay {
  adjustment_id: number;
  employee_id: number;
  work_date: string;
}

export interface IPendingRequestDay {
  request_id: number;
  employee_id: number;
  work_date: string;
}

export interface IPendingDecisionFacts {
  days: IPendingDecisionDay[];
  requests: IPendingRequestDay[];
}

export type IPendingApprovalRef = Pick<
  TimesheetApproval,
  'id' | 'department_id' | 'manager_employee_id' | 'start_date' | 'end_date'
>;

export type PendingDecisionStage = 'request' | 'day';

export interface IPendingDecisionGroup {
  stage: PendingDecisionStage;
  responsible_employee_ids: number[];
  responsible_names: string[];
  days: string[];
}

async function rowsWith<T extends import('pg').QueryResultRow>(
  exec: DbExecutor | undefined,
  sql: string,
  params: readonly unknown[],
): Promise<T[]> {
  if (exec) return (await exec.query<T>(sql, params as unknown[])).rows;
  return query<T>(sql, params);
}

const normalizeIds = (ids: readonly number[]): number[] =>
  [...new Set(ids.map(Number))].filter((id): id is number => Number.isInteger(id) && id > 0);

/**
 * Дни заявлений «Работа в выходной», ждущих 1-го этапа. Даты — selected_dates или
 * start..end, обрезанные периодом (generate_series не разворачивает битые легаси-диапазоны).
 */
export async function listPendingWorkRequestDays(
  employeeIds: readonly number[],
  range: ITimesheetDateRange,
  exec?: DbExecutor,
): Promise<IPendingRequestDay[]> {
  const ids = normalizeIds(employeeIds);
  if (ids.length === 0) return [];
  const rows = await rowsWith<{ request_id: number | string; employee_id: number | string; work_date: string }>(
    exec,
    `SELECT lr.id AS request_id, lr.employee_id, d.work_date::text AS work_date
       FROM leave_requests lr
       CROSS JOIN LATERAL (
         SELECT x::date AS work_date
           FROM unnest(lr.selected_dates) AS x
          WHERE cardinality(lr.selected_dates) > 0
         UNION
         SELECT g::date
           FROM generate_series(
                  GREATEST(lr.start_date, $2::date)::timestamp,
                  LEAST(lr.end_date, $3::date)::timestamp,
                  interval '1 day'
                ) AS g
          WHERE COALESCE(cardinality(lr.selected_dates), 0) = 0
       ) d
      WHERE lr.request_type = 'work'
        AND lr.status = 'pending'
        AND lr.employee_id = ANY($1::int[])
        AND lr.start_date <= $3::date
        AND lr.end_date >= $2::date
        AND d.work_date >= $2::date
        AND d.work_date <= $3::date
        AND NOT EXISTS (
              SELECT 1 FROM attendance_adjustments aa
               WHERE aa.source_type = 'leave_request'
                 AND aa.source_id = lr.id::text
            )`,
    [ids, range.startDate, range.endDate],
  );
  return rows.map(row => ({
    request_id: Number(row.request_id),
    employee_id: Number(row.employee_id),
    work_date: String(row.work_date).slice(0, 10),
  }));
}

/**
 * Факты ожидания за период — только SQL через exec, без маршрутизации: вызывается и
 * внутри транзакций (HR-гейт, трекинг перехода «готов к утверждению»).
 */
export async function listPendingDecisionFacts(
  scope: IPendingScope,
  range: ITimesheetDateRange,
  exec?: DbExecutor,
): Promise<IPendingDecisionFacts> {
  let employeeIds: number[];
  let window: Map<number, IMembershipWindow> | null = null;
  if (scope.kind === 'department') {
    const memberships = await listEmployeeMembershipsForDepartmentPeriod(
      scope.departmentId, range.startDate, range.endDate, exec,
    );
    employeeIds = memberships.map(m => m.employee_id);
    window = buildMembershipWindowMap(memberships);
  } else {
    employeeIds = normalizeIds(scope.employeeIds);
  }
  if (employeeIds.length === 0) return { days: [], requests: [] };

  const inScope = (employeeId: number, workDate: string): boolean =>
    window == null || isWithinMembershipWindow(window.get(employeeId), workDate, 'viaTransferOnly');

  const dayRows = await rowsWith<{ id: number | string; employee_id: number | string; work_date: string }>(
    exec,
    `SELECT id, employee_id, work_date::text AS work_date
       FROM attendance_adjustments
      WHERE approval_status = 'pending'
        AND employee_id = ANY($1::int[])
        AND work_date >= $2
        AND work_date <= $3`,
    [employeeIds, range.startDate, range.endDate],
  );
  const days = dayRows
    .map(row => ({
      adjustment_id: Number(row.id),
      employee_id: Number(row.employee_id),
      work_date: String(row.work_date).slice(0, 10),
    }))
    .filter(day => inScope(day.employee_id, day.work_date));

  const requests = (await listPendingWorkRequestDays(employeeIds, range, exec))
    .filter(day => inScope(day.employee_id, day.work_date));

  return { days, requests };
}

/** Число (сотрудник, день) в ожидании: несколько строк одного дня — один день. */
export function countPendingDecisionDays(facts: IPendingDecisionFacts): number {
  const keys = new Set<string>();
  for (const day of facts.days) keys.add(`${day.employee_id}|${day.work_date}`);
  for (const day of facts.requests) keys.add(`${day.employee_id}|${day.work_date}`);
  return keys.size;
}

/**
 * Скоуп подачи. Персональная — видимый снимок (уволенных в месяце периода в составе уже
 * нет, с 01.09.2026 — их выходные не мешают). null — подача без состава.
 */
export async function resolveApprovalPendingScope(
  approval: IPendingApprovalRef,
  exec?: DbExecutor,
): Promise<IPendingScope | null> {
  if (approval.manager_employee_id != null) {
    const snapshot = await listVisibleApprovalEmployees(approval, exec);
    return { kind: 'personal', employeeIds: snapshot.map(row => Number(row.employee_id)) };
  }
  if (approval.department_id) return { kind: 'department', departmentId: approval.department_id };
  return null;
}

export async function loadPendingDecisionFactsForApproval(
  approval: IPendingApprovalRef,
  exec?: DbExecutor,
): Promise<IPendingDecisionFacts> {
  const scope = await resolveApprovalPendingScope(approval, exec);
  if (!scope) return { days: [], requests: [] };
  return listPendingDecisionFacts(scope, { startDate: approval.start_date, endDate: approval.end_date }, exec);
}

/** HR-гейт утверждения: что не решено, то не утверждается. */
export async function countPendingDecisionsForApproval(
  approval: IPendingApprovalRef,
  exec?: DbExecutor,
): Promise<number> {
  return countPendingDecisionDays(await loadPendingDecisionFactsForApproval(approval, exec));
}

/**
 * Кто должен решить — вне транзакции (маршрутизация читает справочники пулом).
 * 2-й этап — тот же маршрут, что очередь «Согласований»; 1-й — те, кто вправе решить
 * заявление (ответственный по маршруту и заместители отдела). Группа — по набору
 * согласующих (id отсортированы), пустой набор = ответственный не назначен.
 */
export async function describePendingDecisions(
  facts: IPendingDecisionFacts,
): Promise<IPendingDecisionGroup[]> {
  if (facts.days.length === 0 && facts.requests.length === 0) return [];

  const employeeIds = normalizeIds([
    ...facts.days.map(day => day.employee_id),
    ...facts.requests.map(day => day.employee_id),
  ]);
  const deptRows = await query<{ id: number | string; org_department_id: string | null }>(
    'SELECT id, org_department_id FROM employees WHERE id = ANY($1::int[])',
    [employeeIds],
  );
  const deptByEmployee = new Map(deptRows.map(row => [Number(row.id), row.org_department_id ?? null]));

  const routedDays = facts.days.length > 0
    ? await resolveResponsibleEmployeeIdsForRows(facts.days.map(day => ({
      id: day.adjustment_id,
      employee_id: day.employee_id,
      work_date: day.work_date,
      org_department_id: deptByEmployee.get(day.employee_id) ?? null,
    })))
    : new Map<number, number[]>();
  const requestEmployees = normalizeIds(facts.requests.map(day => day.employee_id));
  const requestApprovers = requestEmployees.length > 0
    ? await resolveLeaveApproverEmployeeIdsByEmployee(requestEmployees.map(employeeId => ({
      employee_id: employeeId,
      org_department_id: deptByEmployee.get(employeeId) ?? null,
    })))
    : new Map<number, number[]>();

  const groups = new Map<string, { stage: PendingDecisionStage; ids: number[]; days: Set<string> }>();
  const addToGroup = (stage: PendingDecisionStage, responsible: readonly number[], workDate: string): void => {
    const ids = normalizeIds(responsible).sort((a, b) => a - b);
    const key = `${stage}|${ids.join(',')}`;
    const group = groups.get(key) ?? { stage, ids, days: new Set<string>() };
    group.days.add(workDate);
    groups.set(key, group);
  };
  for (const day of facts.days) addToGroup('day', routedDays.get(day.adjustment_id) ?? [], day.work_date);
  for (const day of facts.requests) addToGroup('request', requestApprovers.get(day.employee_id) ?? [], day.work_date);

  const responsibleIds = normalizeIds([...groups.values()].flatMap(group => group.ids));
  const nameRows = responsibleIds.length > 0
    ? await query<{ id: number | string; full_name: string | null }>(
      'SELECT id, full_name FROM employees WHERE id = ANY($1::int[])',
      [responsibleIds],
    )
    : [];
  const nameById = new Map(nameRows.map(row => [Number(row.id), row.full_name ?? '']));

  return [...groups.values()]
    .map(group => ({
      stage: group.stage,
      responsible_employee_ids: group.ids,
      responsible_names: group.ids.map(id => nameById.get(id) || `#${id}`),
      days: [...group.days].sort(),
    }))
    .sort((a, b) => (a.stage === b.stage ? 0 : a.stage === 'day' ? -1 : 1)
      || (a.days[0] ?? '').localeCompare(b.days[0] ?? ''));
}
