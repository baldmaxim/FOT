/**
 * Закрытие табелей отдела за месяц кадровой службой (кнопка «Единый файл для 1С» → «Да»).
 *
 * «Закрыт» = подача в статусе approved с замком (unlocked_at IS NULL). Месяц разбирается
 * двумя полупериодами — подачи почти всегда полумесячные; строка «весь месяц» покрывает
 * оба и обрабатывается один раз. По каждому полупериоду:
 *  - утверждена и закрыта → ничего не делаем;
 *  - утверждена, но открыта → возвращаем замок, как штатное «Закрыть табель» (с нерешёнными
 *    выходными — пропускаем, как и неутверждённую);
 *  - подана → утверждаем со своим составом и штатными проверками;
 *  - не подана / черновик / отклонена / возвращена → утверждаем от имени кадров.
 *
 * Утверждение от имени кадров — только для отдела без подотделов: состав подачи отдела
 * раскрывает поддерево (listEmployeeIdsAssignedToDepartmentPeriod), и подача на узле-группе
 * забрала бы людей всех дочерних отделов, которые закрываются своими подачами.
 *
 * Сотрудник, чьи дни в этой подаче уже целиком лежат в других утверждённых подачах (личная
 * подача руководителя «по людям»), в состав не идёт — иначе 1С получила бы его часы дважды.
 * Покрыта только часть его дней — закрывать нельзя: исключение потеряло бы остальные дни.
 *
 * Ядро без req/res: аудит, realtime и сброс кэшей делает контроллер по списку changes —
 * транзакция материализации может перезапуститься, и побочные эффекты разошлись бы дважды.
 */
import type { PoolClient } from 'pg';
import { query } from '../config/postgres.js';
import type { TimesheetApproval, TimesheetApprovalStatus } from '../types/index.js';
import { collectDeptIds, getAllDepartmentsTree, getAncestorDeptIds } from './skud-shared.service.js';
import { relinkApprovalAttachments } from './timesheet-approval-attachments.service.js';
import { snapshotApprovalEmployees } from './timesheet-approval-employees-snapshot.service.js';
import { timesheetApprovalHistoryService } from './timesheet-approval-history.service.js';
import { resolveOverlapSubmission } from './timesheet-approval-overlap.service.js';
import {
  assertNoApprovedDayConflicts,
  findApprovedDayConflicts,
  findApprovedDayCoverage,
  formatApprovedDayConflicts,
  TimesheetApprovedDayConflictError,
} from './timesheet-approved-day-conflicts.service.js';
import {
  listEmployeeIdsAssignedToDepartmentPeriod,
  listScopedMembersByDepartment,
} from './timesheet-department-assignments.service.js';
import {
  countPendingDecisionDays,
  countPendingDecisionsForApproval,
  listPendingDecisionFacts,
} from './timesheet-pending-decisions.service.js';
import { getLastDayOfMonth } from './timesheet-period.service.js';
import { formatTimesheetRangeLabel, type ITimesheetDateRange } from './timesheet-range.service.js';
import { withTimesheetSnapshotTransaction } from './timesheet-snapshot-tx.js';
import {
  clearVersionDirty,
  materializeVersion,
  monthAnchorsInRange,
  TimesheetVersionCrossMonthError,
  TimesheetVersionEmptyRosterError,
  TimesheetVersionIncompleteError,
  type IVersionApproval,
} from './timesheet-version.service.js';

export const MONTH_CLOSE_COMMENT = 'Закрыт кадровой службой при выгрузке в 1С';

export type TMonthCloseStatus =
  | 'closed'
  | 'already_closed'
  | 'no_employees'
  | 'covered_elsewhere'
  | 'skipped';

/** Реально изменённая подача: по ней вызывающий пишет аудит и шлёт realtime. */
export interface IMonthCloseChange {
  approvalId: number;
  /** approved — подача стала утверждённой; closed — была утверждена и открыта, замок возвращён. */
  kind: 'approved' | 'closed';
  fromStatus: TimesheetApprovalStatus | null;
  startDate: string;
  endDate: string;
  submittedBy: string | null;
}

export interface IMonthCloseHalfResult {
  start_date: string;
  end_date: string;
  status: TMonthCloseStatus;
  reason?: string;
  /** Сколько сотрудников не вошло в подачу: их дни уже утверждены в других табелях. */
  excluded_count?: number;
}

export interface IMonthCloseDepartmentResult {
  halves: IMonthCloseHalfResult[];
  changes: IMonthCloseChange[];
  /** Непредвиденные ошибки полупериодов (в halves они уже «пропущен») — вызывающему для Sentry. */
  errors: unknown[];
}

interface IHalfOutcome {
  result: IMonthCloseHalfResult;
  change?: IMonthCloseChange;
}

const CHANGED_REASON = 'Подача изменилась во время закрытия — повторите';
export const UNEXPECTED_REASON = 'Ошибка закрытия табеля — обратитесь к администратору';

/** Откат транзакции с готовым исходом полупериода (не ошибка — штатный отказ закрывать). */
class MonthCloseAbort extends Error {
  readonly status: Exclude<TMonthCloseStatus, 'closed'>;
  readonly reason?: string;

  constructor(status: Exclude<TMonthCloseStatus, 'closed'>, reason?: string) {
    super(reason ?? status);
    this.name = 'MonthCloseAbort';
    this.status = status;
    this.reason = reason;
  }
}

const pendingReason = (count: number): string =>
  `Ждёт согласования выходных (дней: ${count})`;

/** Полупериоды месяца 'YYYY-MM': 1–15 и 16–последний день. */
export function monthHalfRanges(month: string): ITimesheetDateRange[] {
  const [year, monthNumber] = month.split('-').map(Number);
  const lastDay = String(getLastDayOfMonth(year, monthNumber)).padStart(2, '0');
  return [
    { startDate: `${month}-01`, endDate: `${month}-15` },
    { startDate: `${month}-16`, endDate: `${month}-${lastDay}` },
  ];
}

const covers = (row: Pick<TimesheetApproval, 'start_date' | 'end_date'>, range: ITimesheetDateRange): boolean =>
  row.start_date <= range.startDate && row.end_date >= range.endDate;

const toVersionApproval = (row: TimesheetApproval): IVersionApproval => ({
  id: Number(row.id),
  department_id: row.department_id ?? null,
  manager_employee_id: row.manager_employee_id != null ? Number(row.manager_employee_id) : null,
  start_date: row.start_date,
  end_date: row.end_date,
  status: row.status,
});

const outcome = (
  range: ITimesheetDateRange,
  status: TMonthCloseStatus,
  extra: Pick<IMonthCloseHalfResult, 'reason' | 'excluded_count'> = {},
  change?: IMonthCloseChange,
): IHalfOutcome => ({
  result: { start_date: range.startDate, end_date: range.endDate, status, ...extra },
  change,
});

const lockPairsFor = (employeeIds: readonly number[], range: ITimesheetDateRange) => {
  const anchors = monthAnchorsInRange(range.startDate, range.endDate);
  return employeeIds.flatMap(employeeId => anchors.map(workDate => ({ employeeId, workDate })));
};

/** Локи существующей подачи — по её сохранённому составу, как у штатных approve/close. */
async function lockPairsFromSnapshot(approval: TimesheetApproval) {
  const rows = await query<{ employee_id: number | string }>(
    'SELECT employee_id FROM timesheet_approval_employees WHERE approval_id = $1',
    [approval.id],
  );
  return lockPairsFor(
    rows.map(row => Number(row.employee_id)),
    { startDate: approval.start_date, endDate: approval.end_date },
  );
}

/** Штатные отказы материализации и БД → исход «пропущен» с понятной причиной. */
async function guarded(range: ITimesheetDateRange, fn: () => Promise<IHalfOutcome>): Promise<IHalfOutcome> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MonthCloseAbort) return outcome(range, err.status, { reason: err.reason });
    if (err instanceof TimesheetApprovedDayConflictError) {
      return outcome(range, 'skipped', {
        reason: `Сотрудники уже утверждены в другом табеле за эти дни: ${formatApprovedDayConflicts(err.conflicts)}`,
      });
    }
    if (err instanceof TimesheetVersionIncompleteError) {
      return outcome(range, 'skipped', {
        reason: 'Не удалось сформировать выгрузку табеля: часть состава не попала в расчёт',
      });
    }
    if (err instanceof TimesheetVersionEmptyRosterError) {
      return outcome(range, 'skipped', { reason: 'У табеля нет сохранённого состава сотрудников' });
    }
    if (err instanceof TimesheetVersionCrossMonthError) {
      return outcome(range, 'skipped', { reason: 'Период табеля пересекает границу месяца' });
    }
    const code = (err as { code?: unknown } | null)?.code;
    if (code === '23P01') {
      return outcome(range, 'skipped', { reason: 'Период пересекается с другой подачей этого отдела' });
    }
    if (code === '57014') {
      return outcome(range, 'skipped', { reason: 'Расчёт занял слишком много времени — повторите закрытие' });
    }
    throw err;
  }
}

/** Утверждена, но открыта: возвращаем замок и фиксируем редакцию — как «Закрыть табель». */
async function relockApproved(
  actorUserId: string,
  approval: TimesheetApproval,
  range: ITimesheetDateRange,
): Promise<IHalfOutcome> {
  const lockPairs = await lockPairsFromSnapshot(approval);
  const updated = await withTimesheetSnapshotTransaction(lockPairs, async client => {
    const current = (await client.query<TimesheetApproval>(
      'SELECT * FROM timesheet_approvals WHERE id = $1 FOR UPDATE',
      [approval.id],
    )).rows[0];
    if (!current || current.status !== 'approved') throw new MonthCloseAbort('skipped', CHANGED_REASON);
    if (current.unlocked_at == null) return null;

    // Пока табель открыт, в нём могли появиться нерешённые выходные: под замком их уже не
    // согласовать, и часы не попали бы в редакцию для 1С.
    const pending = await countPendingDecisionsForApproval(current, client);
    if (pending > 0) throw new MonthCloseAbort('skipped', pendingReason(pending));

    const row = (await client.query<TimesheetApproval>(
      `UPDATE timesheet_approvals
          SET unlocked_at = NULL,
              unlocked_by = NULL,
              unlock_reason = NULL,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [approval.id],
    )).rows[0];
    if (!row) throw new MonthCloseAbort('skipped', CHANGED_REASON);

    await materializeVersion(client, toVersionApproval(row), 'close', actorUserId);
    await clearVersionDirty(client, Number(row.id));
    return row;
  });

  if (!updated) return outcome(range, 'already_closed');
  return outcome(range, 'closed', {}, {
    approvalId: Number(updated.id),
    kind: 'closed',
    fromStatus: 'approved',
    startDate: updated.start_date,
    endDate: updated.end_date,
    submittedBy: updated.submitted_by,
  });
}

/** Подана руководителем: утверждаем её состав со штатными проверками approve. */
async function approveSubmitted(
  actorUserId: string,
  approval: TimesheetApproval,
  range: ITimesheetDateRange,
): Promise<IHalfOutcome> {
  // Быстрый отказ до взятия локов; авторитетна та же проверка внутри транзакции.
  const pendingBefore = await countPendingDecisionsForApproval(approval);
  if (pendingBefore > 0) return outcome(range, 'skipped', { reason: pendingReason(pendingBefore) });

  const lockPairs = await lockPairsFromSnapshot(approval);
  const updated = await withTimesheetSnapshotTransaction(lockPairs, async client => {
    const current = (await client.query<TimesheetApproval>(
      'SELECT * FROM timesheet_approvals WHERE id = $1 FOR UPDATE',
      [approval.id],
    )).rows[0];
    if (!current || current.status !== 'submitted') throw new MonthCloseAbort('skipped', CHANGED_REASON);

    const pending = await countPendingDecisionsForApproval(current, client);
    if (pending > 0) throw new MonthCloseAbort('skipped', pendingReason(pending));

    const now = new Date().toISOString();
    // Открытая поданная подача: замок возвращаем тем же UPDATE — смена статуса сама
    // unlocked_at не обнуляет, и период остался бы открытым уже утверждённым.
    const row = (await client.query<TimesheetApproval>(
      `UPDATE timesheet_approvals
          SET status = 'approved',
              reviewed_by = $1,
              reviewed_at = $2,
              review_comment = $3,
              unlocked_at = NULL,
              unlocked_by = NULL,
              unlock_reason = NULL,
              updated_at = $2
        WHERE id = $4
        RETURNING *`,
      [actorUserId, now, MONTH_CLOSE_COMMENT, approval.id],
    )).rows[0];
    if (!row) throw new MonthCloseAbort('skipped', CHANGED_REASON);

    await materializeVersion(client, toVersionApproval(row), 'approve', actorUserId);
    await assertNoApprovedDayConflicts(client, Number(row.id));
    await clearVersionDirty(client, Number(row.id));
    await timesheetApprovalHistoryService.appendEvent({
      approvalId: Number(row.id),
      departmentId: row.department_id,
      startDate: row.start_date,
      endDate: row.end_date,
      action: 'approved',
      fromStatus: 'submitted',
      toStatus: 'approved',
      actorUserId,
      comment: MONTH_CLOSE_COMMENT,
      metadata: { source: 'month_close', forced: false },
      createdAt: now,
    }, client);
    return row;
  });

  return outcome(range, 'closed', {}, {
    approvalId: Number(updated.id),
    kind: 'approved',
    fromStatus: 'submitted',
    startDate: updated.start_date,
    endDate: updated.end_date,
    submittedBy: updated.submitted_by,
  });
}

/**
 * Версия подачи без сотрудников, чьи дни уже утверждены в других табелях.
 *
 * Порядок жёсткий: снимок состава правим только ПОСЛЕ отката к savepoint — иначе откат
 * вернул бы и прежний состав. Возвращает число исключённых.
 */
async function materializeWithoutCovered(
  client: PoolClient,
  row: TimesheetApproval,
  rosterIds: readonly number[],
  actorUserId: string,
): Promise<number> {
  const approvalId = Number(row.id);
  await client.query('SAVEPOINT month_close_version');
  await materializeVersion(client, toVersionApproval(row), 'approve', actorUserId);

  const coverage = await findApprovedDayCoverage(client, approvalId);
  if (coverage.length === 0) {
    await client.query('RELEASE SAVEPOINT month_close_version');
    return 0;
  }

  const partialIds = new Set(
    coverage.filter(item => item.coveredDays < item.ownDays).map(item => item.employeeId),
  );
  if (partialIds.size > 0) {
    const conflicts = (await findApprovedDayConflicts(client, approvalId))
      .filter(conflict => partialIds.has(conflict.employeeId));
    throw new MonthCloseAbort(
      'skipped',
      `Часть дней сотрудников уже утверждена в другом табеле: ${formatApprovedDayConflicts(conflicts)}`,
    );
  }

  await client.query('ROLLBACK TO SAVEPOINT month_close_version');
  const coveredIds = new Set(coverage.map(item => item.employeeId));
  const reducedIds = rosterIds.filter(id => !coveredIds.has(id));
  if (reducedIds.length === 0) throw new MonthCloseAbort('covered_elsewhere');

  await snapshotApprovalEmployees(client, approvalId, reducedIds);
  await materializeVersion(client, toVersionApproval(row), 'approve', actorUserId);
  await assertNoApprovedDayConflicts(client, approvalId);
  await client.query('RELEASE SAVEPOINT month_close_version');
  return coveredIds.size;
}

/** Действующая подача вышестоящего отдела на этот период — её замок и состав покрывают отдел. */
async function findAncestorActiveApproval(
  departmentId: string,
  range: ITimesheetDateRange,
): Promise<(TimesheetApproval & { department_name: string | null }) | null> {
  const ancestorIds = getAncestorDeptIds(departmentId, await getAllDepartmentsTree());
  if (ancestorIds.length === 0) return null;
  const rows = await query<TimesheetApproval & { department_name: string | null }>(
    `SELECT a.*, od.name AS department_name
       FROM timesheet_approvals a
       LEFT JOIN org_departments od ON od.id = a.department_id
      WHERE a.department_id = ANY($1::uuid[])
        AND a.manager_employee_id IS NULL
        AND a.status IN ('submitted', 'approved', 'returned')
        AND daterange(a.start_date, a.end_date, '[]') && daterange($2::date, $3::date, '[]')
      ORDER BY a.id`,
    [ancestorIds, range.startDate, range.endDate],
  );
  return rows[0] ?? null;
}

/**
 * Утверждение от имени кадров: подачи нет либо она в черновике / отклонена / возвращена.
 * `range` — полупериод либо собственный диапазон возвращённой подачи (её диапазон не
 * переписываем: у неё уже есть редакции для 1С за этот период).
 */
async function forceApprove(
  actorUserId: string,
  departmentId: string,
  range: ITimesheetDateRange,
): Promise<IHalfOutcome> {
  const isLeaf = (await collectDeptIds(departmentId)).length === 1;
  if (!isLeaf) {
    const ownMembers = await listScopedMembersByDepartment([departmentId], range.startDate, range.endDate);
    if (ownMembers.size === 0) return outcome(range, 'no_employees');
    return outcome(range, 'skipped', {
      reason: 'У отдела есть подотделы и свои сотрудники — его табель подаёт и закрывает руководитель',
    });
  }

  const ancestorApproval = await findAncestorActiveApproval(departmentId, range);
  if (ancestorApproval) {
    if (ancestorApproval.status === 'approved' && ancestorApproval.unlocked_at == null && covers(ancestorApproval, range)) {
      return outcome(range, 'already_closed');
    }
    return outcome(range, 'skipped', {
      reason: `Период подан в составе вышестоящего отдела «${ancestorApproval.department_name ?? ancestorApproval.department_id}»`,
    });
  }

  const rosterIds = [...new Set(
    await listEmployeeIdsAssignedToDepartmentPeriod(departmentId, range.startDate, range.endDate),
  )];
  if (rosterIds.length === 0) return outcome(range, 'no_employees');

  const pendingBefore = countPendingDecisionDays(
    await listPendingDecisionFacts({ kind: 'department', departmentId }, range),
  );
  if (pendingBefore > 0) return outcome(range, 'skipped', { reason: pendingReason(pendingBefore) });

  const done = await withTimesheetSnapshotTransaction(lockPairsFor(rosterIds, range), async client => {
    // Всё, что пересекает диапазон, читаем под FOR UPDATE внутри транзакции: при повторе
    // (40001) решение «переиспользовать / вставить» принимается заново по свежему снимку.
    const overlaps = (await client.query<TimesheetApproval>(
      `SELECT * FROM timesheet_approvals
        WHERE department_id = $1
          AND manager_employee_id IS NULL
          AND daterange(start_date, end_date, '[]') && daterange($2::date, $3::date, '[]')
        ORDER BY id
          FOR UPDATE`,
      [departmentId, range.startDate, range.endDate],
    )).rows;
    if (overlaps.some(row => row.status === 'approved' || row.status === 'submitted')) {
      throw new MonthCloseAbort('skipped', CHANGED_REASON);
    }
    const { reuseRow, toDeleteIds } = resolveOverlapSubmission(overlaps, range);
    const now = new Date().toISOString();

    // submitted_* = NULL: руководитель эту подачу не подавал. Автором подачи кадровика
    // делать нельзя — отзыв такой строки увёл бы в черновик его собственную личную подачу.
    const row = reuseRow
      ? (await client.query<TimesheetApproval>(
        `UPDATE timesheet_approvals
            SET start_date = $1,
                end_date = $2,
                status = 'approved',
                submitted_by = NULL,
                submitted_at = NULL,
                reviewed_by = $3,
                reviewed_at = $4,
                review_comment = $5,
                unlocked_at = NULL,
                unlocked_by = NULL,
                unlock_reason = NULL,
                updated_at = $4
          WHERE id = $6
          RETURNING *`,
        [range.startDate, range.endDate, actorUserId, now, MONTH_CLOSE_COMMENT, reuseRow.id],
      )).rows[0]
      : (await client.query<TimesheetApproval>(
        `INSERT INTO timesheet_approvals
           (department_id, manager_employee_id, start_date, end_date, status,
            submitted_by, submitted_at, reviewed_by, reviewed_at, review_comment, updated_at)
         VALUES ($1, NULL, $2, $3, 'approved', NULL, NULL, $4, $5, $6, $5)
         RETURNING *`,
        [departmentId, range.startDate, range.endDate, actorUserId, now, MONTH_CLOSE_COMMENT],
      )).rows[0];
    if (!row) throw new MonthCloseAbort('skipped', CHANGED_REASON);
    const approvalId = Number(row.id);

    if (toDeleteIds.length > 0) {
      // Служебки с вытесняемых черновиков перевешиваем на выжившую строку — как при подаче.
      await relinkApprovalAttachments(client, toDeleteIds, approvalId);
      await client.query('DELETE FROM timesheet_approvals WHERE id = ANY($1::bigint[])', [toDeleteIds]);
    }
    await snapshotApprovalEmployees(client, approvalId, rosterIds);

    const pending = await countPendingDecisionsForApproval(row, client);
    if (pending > 0) throw new MonthCloseAbort('skipped', pendingReason(pending));

    const excluded = await materializeWithoutCovered(client, row, rosterIds, actorUserId);
    await clearVersionDirty(client, approvalId);
    await timesheetApprovalHistoryService.appendEvent({
      approvalId,
      departmentId,
      startDate: row.start_date,
      endDate: row.end_date,
      action: 'approved',
      fromStatus: reuseRow?.status ?? null,
      toStatus: 'approved',
      actorUserId,
      comment: MONTH_CLOSE_COMMENT,
      metadata: { source: 'month_close', forced: true, excluded_count: excluded },
      createdAt: now,
    }, client);
    return { row, excluded, fromStatus: reuseRow?.status ?? null };
  });

  return outcome(
    range,
    'closed',
    done.excluded > 0 ? { excluded_count: done.excluded } : {},
    {
      approvalId: Number(done.row.id),
      kind: 'approved',
      fromStatus: done.fromStatus,
      startDate: done.row.start_date,
      endDate: done.row.end_date,
      submittedBy: null,
    },
  );
}

async function closeDepartmentHalf(
  actorUserId: string,
  departmentId: string,
  range: ITimesheetDateRange,
  handled: Map<number, IHalfOutcome>,
): Promise<IHalfOutcome> {
  const activeRows = await query<TimesheetApproval>(
    `SELECT * FROM timesheet_approvals
      WHERE department_id = $1
        AND manager_employee_id IS NULL
        AND status IN ('approved', 'submitted', 'returned')
        AND daterange(start_date, end_date, '[]') && daterange($2::date, $3::date, '[]')
      ORDER BY id`,
    [departmentId, range.startDate, range.endDate],
  );
  const own = activeRows.find(row => covers(row, range)) ?? null;

  if (!own && activeRows.length > 0) {
    const other = activeRows[0];
    return outcome(range, 'skipped', {
      reason: `Подача за нестандартный период ${formatTimesheetRangeLabel(other.start_date, other.end_date)} — закройте её вручную`,
    });
  }

  if (own) {
    // Строка «весь месяц» уже разобрана на первом полупериоде — исход тот же, без новых событий.
    const previous = handled.get(Number(own.id));
    if (previous) return outcome(range, previous.result.status, {
      reason: previous.result.reason,
      excluded_count: previous.result.excluded_count,
    });
  }

  const result = await guarded(range, async () => {
    if (!own) return forceApprove(actorUserId, departmentId, range);
    if (own.status === 'approved') {
      return own.unlocked_at == null
        ? outcome(range, 'already_closed')
        : relockApproved(actorUserId, own, range);
    }
    if (own.status === 'submitted') return approveSubmitted(actorUserId, own, range);
    // returned: утверждаем в её собственном диапазоне.
    return forceApprove(actorUserId, departmentId, { startDate: own.start_date, endDate: own.end_date });
  });

  // Исход привязываем к запрошенному полупериоду, а не к диапазону строки.
  const normalized: IHalfOutcome = {
    result: { ...result.result, start_date: range.startDate, end_date: range.endDate },
    change: result.change,
  };
  if (own) handled.set(Number(own.id), normalized);
  return normalized;
}

/** Закрывает оба полупериода месяца 'YYYY-MM' по одному отделу. */
export async function closeDepartmentMonth(
  actorUserId: string,
  departmentId: string,
  month: string,
): Promise<IMonthCloseDepartmentResult> {
  const handled = new Map<number, IHalfOutcome>();
  const halves: IMonthCloseHalfResult[] = [];
  const changes: IMonthCloseChange[] = [];
  const errors: unknown[] = [];
  for (const range of monthHalfRanges(month)) {
    try {
      const half = await closeDepartmentHalf(actorUserId, departmentId, range, handled);
      halves.push(half.result);
      if (half.change) changes.push(half.change);
    } catch (err) {
      // Сбой одного полупериода не должен терять уже закрытый другой: его изменения
      // закоммичены, и вызывающий обязан записать по ним аудит.
      errors.push(err);
      halves.push(outcome(range, 'skipped', { reason: UNEXPECTED_REASON }).result);
    }
  }
  return { halves, changes, errors };
}
