/**
 * Разовая чистка утверждённых персональных подач, где строка самого руководителя
 * дублирует его строку в утверждённой подаче своего отдела.
 *
 * До 5f6f1c33 подача чужого отдела забирала строку руководителя в его авто-персональную
 * подачу, а следом её же брала подача его отдела — обе утверждены, и 1С получила бы часы
 * руководителя дважды (сентябрь: Душанова, Карасени, Орешкин). 5f6f1c33 перестал так
 * собирать состав, но утверждённые подачи не трогает. Здесь такая персональная подача
 * уводится в пустой черновик — ровно то состояние, которое 5f6f1c33 даёт неутверждённой:
 * API 1С отдаёт только утверждённые подачи, строка остаётся в подаче отдела, редакции
 * персональной остаются историей.
 *
 * Автоматически — только однозначный случай: в составе один руководитель, все его дни
 * есть в утверждённых подачах отделов, 1С ни одну редакцию не подтвердила. Остальное —
 * в отчёт «вручную». Каждая подача — своя транзакция под теми же локами (сотрудник,
 * месяц) и FOR UPDATE, что утверждение; условия проверяются ещё раз внутри неё.
 * Повтор — no-op.
 */
import { query, type DbExecutor } from '../config/postgres.js';
import { AUDIT_ACTIONS, auditService } from './audit.service.js';
import { monthEnd } from './employee-timesheet-object.service.js';
import { snapshotApprovalEmployees } from './timesheet-approval-employees-snapshot.service.js';
import { findApprovedDayConflicts } from './timesheet-approved-day-conflicts.service.js';
import { withTimesheetSnapshotTransaction } from './timesheet-snapshot-tx.js';
import { monthAnchorsInRange } from './timesheet-version.service.js';

/**
 * Поля возврата подачи в черновик. unlocked_* обнуляем здесь же: открытие не должно
 * пережить возврат в draft (иначе CHECK timesheet_approvals_unlock_status_check отбил
 * бы UPDATE). $1 — время изменения.
 */
export const RECALL_TO_DRAFT_SET_SQL = `status = 'draft',
             submitted_by = NULL,
             submitted_at = NULL,
             reviewed_by = NULL,
             reviewed_at = NULL,
             review_comment = NULL,
             unlocked_at = NULL,
             unlocked_by = NULL,
             unlock_reason = NULL,
             updated_at = $1`;

export interface ISelfPersonalDuplicate {
  approvalId: number;
  managerEmployeeId: number;
  fullName: string | null;
  startDate: string;
  endDate: string;
  /** Дни и часы строки руководителя в персональной подаче. */
  days: number;
  hours: number;
  /** Утверждённые подачи отделов, где эти дни уже есть. */
  keptInApprovalIds: number[];
  /** null — снимается автоматически, иначе почему только вручную. */
  manualReason: string | null;
}

interface IPersonalRow {
  id: number | string;
  manager_employee_id: number | string;
  full_name: string | null;
  start_date: string;
  end_date: string;
  roster_ids: Array<number | string> | null;
  self_days: number | string | null;
  self_hours: number | string | null;
  acked: boolean;
}

/**
 * Утверждённые и не открытые персональные подачи со строкой самого руководителя в
 * последней редакции. $1 — список подач или NULL, $2/$3 — границы месяца.
 */
const PERSONAL_WITH_SELF_ROW_SQL = `
  SELECT a.id,
         a.manager_employee_id,
         e.full_name,
         a.start_date::text AS start_date,
         a.end_date::text AS end_date,
         (SELECT array_agg(ae.employee_id ORDER BY ae.employee_id)
            FROM timesheet_approval_employees ae
           WHERE ae.approval_id = a.id) AS roster_ids,
         (SELECT COUNT(*) FROM jsonb_object_keys(COALESCE(s.selfrow->'days', '{}'::jsonb))) AS self_days,
         COALESCE((s.selfrow->>'total_hours')::numeric, 0) AS self_hours,
         EXISTS (
           SELECT 1 FROM timesheet_versions v
             JOIN timesheet_1c_exports x ON x.version_id = v.id
            WHERE v.approval_id = a.id
         ) AS acked
    FROM timesheet_approvals a
    JOIN employees e ON e.id = a.manager_employee_id
    JOIN LATERAL (
      SELECT v.payload FROM timesheet_versions v
       WHERE v.approval_id = a.id
       ORDER BY v.revision DESC
       LIMIT 1
    ) latest ON true
    JOIN LATERAL (
      SELECT emp AS selfrow
        FROM jsonb_array_elements(latest.payload->'employees') emp
       WHERE (emp->'identity'->>'employee_id')::bigint = a.manager_employee_id
       LIMIT 1
    ) s ON true
   WHERE a.status = 'approved'
     AND a.department_id IS NULL
     AND a.manager_employee_id IS NOT NULL
     AND a.unlocked_at IS NULL
     AND ($1::bigint[] IS NULL OR a.id = ANY($1::bigint[]))
     AND a.start_date >= $2::date
     AND a.end_date <= $3::date
   ORDER BY a.id`;

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** null — у подачи нет дубля строки руководителя с подачей отдела. */
async function evaluatePersonal(
  exec: DbExecutor | undefined,
  row: IPersonalRow,
): Promise<ISelfPersonalDuplicate | null> {
  const approvalId = Number(row.id);
  const managerEmployeeId = Number(row.manager_employee_id);
  const conflicts = await findApprovedDayConflicts(exec, approvalId);
  const selfInDepartments = conflicts.filter(
    conflict => conflict.employeeId === managerEmployeeId && conflict.departmentId !== null,
  );
  if (selfInDepartments.length === 0) return null;

  const days = Number(row.self_days ?? 0);
  const hours = round2(Number(row.self_hours ?? 0));
  const coveredDays = selfInDepartments.reduce((sum, conflict) => sum + conflict.days, 0);
  // Часы по дням с обеих сторон: total_hours строки округлён отдельно и для сверки не годится.
  const selfDayHours = round2(selfInDepartments.reduce((sum, conflict) => sum + conflict.hours, 0));
  const keptHours = round2(selfInDepartments.reduce((sum, conflict) => sum + conflict.otherHours, 0));
  const rosterIds = (row.roster_ids ?? []).map(Number);

  let manualReason: string | null = null;
  if (row.acked) {
    manualReason = '1С уже подтвердила редакцию — снимать только вместе с 1С';
  } else if (rosterIds.some(id => id !== managerEmployeeId)) {
    manualReason = 'в составе есть подчинённые';
  } else if (conflicts.length !== selfInDepartments.length) {
    manualReason = 'есть другие пересечения, кроме строки руководителя';
  } else if (coveredDays !== days) {
    manualReason = `в подачах отделов ${coveredDays} из ${days} дней`;
  } else if (keptHours !== selfDayHours) {
    // Часы руководителя не должны потеряться: снимаем, только если в подачах отделов
    // по тем же дням ровно те же часы, что в личной.
    manualReason = `часы расходятся: в личной ${selfDayHours} ч, в подачах отделов ${keptHours} ч`;
  }

  return {
    approvalId,
    managerEmployeeId,
    fullName: row.full_name,
    startDate: row.start_date,
    endDate: row.end_date,
    days,
    hours,
    keptInApprovalIds: [...new Set(selfInDepartments.map(conflict => conflict.approvalId))].sort((a, b) => a - b),
    manualReason,
  };
}

const monthBounds = (month: string): [string, string] => [month, monthEnd(month)];

/** Персональные подачи месяца, где строка руководителя дублирует подачу его отдела. */
export async function listSelfPersonalDuplicates(
  month: string,
  onlyApprovalIds: number[] | null = null,
): Promise<ISelfPersonalDuplicate[]> {
  const [from, to] = monthBounds(month);
  const rows = await query<IPersonalRow>(PERSONAL_WITH_SELF_ROW_SQL, [onlyApprovalIds, from, to]);
  const result: ISelfPersonalDuplicate[] = [];
  for (const row of rows) {
    const evaluated = await evaluatePersonal(undefined, row);
    if (evaluated) result.push(evaluated);
  }
  return result;
}

/** Уводит персональную подачу-дубль в пустой черновик. Условия — заново внутри транзакции. */
export async function recallSelfPersonalDuplicate(
  approvalId: number,
): Promise<{ recalled: boolean; duplicate: ISelfPersonalDuplicate | null }> {
  const head = (await query<{ start_date: string; end_date: string }>(
    'SELECT start_date::text AS start_date, end_date::text AS end_date FROM timesheet_approvals WHERE id = $1',
    [approvalId],
  ))[0];
  if (!head) return { recalled: false, duplicate: null };

  // Состав для локов — до транзакции: локи берутся раньше снимка REPEATABLE READ.
  const roster = await query<{ employee_id: number | string }>(
    'SELECT employee_id FROM timesheet_approval_employees WHERE approval_id = $1',
    [approvalId],
  );
  const anchors = monthAnchorsInRange(head.start_date, head.end_date);
  const lockPairs = roster.flatMap(row => anchors.map(workDate => ({ employeeId: Number(row.employee_id), workDate })));
  const [from, to] = monthBounds(`${head.start_date.slice(0, 8)}01`);

  const outcome = await withTimesheetSnapshotTransaction(lockPairs, async client => {
    const locked = await client.query('SELECT id FROM timesheet_approvals WHERE id = $1 FOR UPDATE', [approvalId]);
    if (locked.rows.length === 0) return { recalled: false, duplicate: null };
    const row = (await client.query<IPersonalRow>(PERSONAL_WITH_SELF_ROW_SQL, [[approvalId], from, to])).rows[0];
    const duplicate = row ? await evaluatePersonal(client, row) : null;
    if (!duplicate || duplicate.manualReason) return { recalled: false, duplicate };

    const updated = await client.query(
      `UPDATE timesheet_approvals
          SET ${RECALL_TO_DRAFT_SET_SQL}
        WHERE id = $2 AND status = 'approved' AND unlocked_at IS NULL
        RETURNING id`,
      [new Date().toISOString(), approvalId],
    );
    if (updated.rows.length === 0) return { recalled: false, duplicate };
    await snapshotApprovalEmployees(client, approvalId, []);
    return { recalled: true, duplicate };
  });

  if (outcome.recalled && outcome.duplicate) {
    // Побочные эффекты — после транзакции: повтор снимка не должен их дублировать.
    await auditService.log({
      user_id: null,
      action: AUDIT_ACTIONS.TIMESHEET_APPROVAL_RECALLED,
      entity_type: 'timesheet_approval',
      entity_id: String(approvalId),
      details: {
        department_id: null,
        manager_employee_id: outcome.duplicate.managerEmployeeId,
        start_date: outcome.duplicate.startDate,
        end_date: outcome.duplicate.endDate,
        from_status: 'approved',
        to_status: 'draft',
        reason: 'duplicate_self_row',
        kept_in_approval_ids: outcome.duplicate.keptInApprovalIds,
        days: outcome.duplicate.days,
        hours: outcome.duplicate.hours,
      },
    });
  }
  return outcome;
}
