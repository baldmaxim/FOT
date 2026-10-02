/**
 * Разовая пересборка утверждённых подач без уволенных в месяце периода (с 01.09.2026,
 * isFiredHiddenForPeriod).
 *
 * Правило «уволенный не виден в месяце увольнения» действует на новые редакции, а уже
 * утверждённые подачи хранят уволенных в последней редакции — 1С получила бы их через API,
 * хотя в табеле и «Едином 1С» их нет. Здесь у таких подач из последней редакции адресно
 * убираются уволенные (removeEmployeesFromVersion): остальные сотрудники, разбивка и
 * руководители — байт в байт, новая revision с source 'rebuild', 1С видит подачу устаревшей.
 *
 * Каждая подача — своя транзакция под теми же локами (сотрудник, месяц) и FOR UPDATE, что
 * утверждение; кого убирать, проверяется ещё раз внутри неё. Повтор — no-op.
 */
import { query } from '../config/postgres.js';
import { AUDIT_ACTIONS, auditService } from './audit.service.js';
import { monthEnd } from './employee-timesheet-object.service.js';
import { FIRED_HIDDEN_FROM_MONTH, firedHiddenSql } from './timesheet-fired-cutoff.service.js';
import { withTimesheetSnapshotTransaction } from './timesheet-snapshot-tx.js';
import { isRebuildableApproval } from './timesheet-version-objects-rebuild.service.js';
import { monthAnchorsInRange, rebuildVersionWithoutEmployees } from './timesheet-version.service.js';

export interface IFiredRebuildCandidate {
  approvalId: number;
  departmentId: string | null;
  managerEmployeeId: number | null;
  startDate: string;
  endDate: string;
  /** Уволенные в месяце периода в последней редакции подачи. */
  fired: Array<{ employeeId: number; fullName: string | null; hours: number }>;
}

interface IApprovalRow {
  id: number | string;
  department_id: string | null;
  manager_employee_id: number | string | null;
  start_date: string;
  end_date: string;
  status: string;
  unlocked_at: string | null;
  version_dirty_at: string | null;
}

/**
 * Уволенные в месяце периода из последней редакции подачи. $1 — подачи, alias a —
 * timesheet_approvals (его start_date — начало периода).
 */
const LATEST_HIDDEN_FIRED_SQL = `
  SELECT a.id AS approval_id,
         (emp->'identity'->>'employee_id')::int AS employee_id,
         e.full_name,
         COALESCE((emp->>'total_hours')::numeric, 0) AS hours
    FROM timesheet_approvals a
    JOIN LATERAL (
      SELECT v.payload FROM timesheet_versions v
       WHERE v.approval_id = a.id
       ORDER BY v.revision DESC
       LIMIT 1
    ) latest ON true
   CROSS JOIN LATERAL jsonb_array_elements(latest.payload->'employees') emp
    JOIN employees e ON e.id = (emp->'identity'->>'employee_id')::int
   WHERE a.id = ANY($1::bigint[])
     AND ${firedHiddenSql('e', 'a.start_date')}
   ORDER BY a.id, employee_id`;

/** Утверждённые, не открытые и не помеченные подачи месяца, где в последней редакции есть уволенные. */
export async function listFiredRebuildCandidates(month: string): Promise<IFiredRebuildCandidate[]> {
  if (month < FIRED_HIDDEN_FROM_MONTH) return [];
  const approvals = await query<IApprovalRow>(
    `SELECT id, department_id::text AS department_id, manager_employee_id,
            start_date::text AS start_date, end_date::text AS end_date, status,
            unlocked_at::text AS unlocked_at, version_dirty_at::text AS version_dirty_at
       FROM timesheet_approvals
      WHERE status = 'approved'
        AND start_date >= $1::date
        AND end_date <= $2::date
        AND unlocked_at IS NULL
        AND version_dirty_at IS NULL
      ORDER BY id`,
    [month, monthEnd(month)],
  );
  if (approvals.length === 0) return [];
  const fired = await query<{ approval_id: number | string; employee_id: number; full_name: string | null; hours: string | number }>(
    LATEST_HIDDEN_FIRED_SQL,
    [approvals.map(row => Number(row.id))],
  );
  const firedByApproval = new Map<number, IFiredRebuildCandidate['fired']>();
  for (const row of fired) {
    const list = firedByApproval.get(Number(row.approval_id)) ?? [];
    list.push({ employeeId: Number(row.employee_id), fullName: row.full_name, hours: Number(row.hours) });
    firedByApproval.set(Number(row.approval_id), list);
  }
  return approvals
    .filter(row => firedByApproval.has(Number(row.id)))
    .map(row => ({
      approvalId: Number(row.id),
      departmentId: row.department_id,
      managerEmployeeId: row.manager_employee_id != null ? Number(row.manager_employee_id) : null,
      startDate: row.start_date,
      endDate: row.end_date,
      fired: firedByApproval.get(Number(row.id)) ?? [],
    }));
}

/** Пересборка одной подачи без уволенных в месяце периода. */
export async function rebuildApprovalWithoutFired(
  approvalId: number,
): Promise<{ created: boolean; revision: number | null; removedIds: number[] }> {
  const approval = (await query<IApprovalRow>(
    `SELECT id, department_id::text AS department_id, manager_employee_id,
            start_date::text AS start_date, end_date::text AS end_date, status,
            unlocked_at::text AS unlocked_at, version_dirty_at::text AS version_dirty_at
       FROM timesheet_approvals WHERE id = $1`,
    [approvalId],
  ))[0];
  if (!approval || !isRebuildableApproval(approval)) return { created: false, revision: null, removedIds: [] };

  // Состав для локов — до транзакции: локи берутся раньше снимка REPEATABLE READ.
  const roster = await query<{ employee_id: number | string }>(
    'SELECT employee_id FROM timesheet_approval_employees WHERE approval_id = $1',
    [approvalId],
  );
  const anchors = monthAnchorsInRange(approval.start_date, approval.end_date);
  const lockPairs = roster.flatMap(row => anchors.map(workDate => ({ employeeId: Number(row.employee_id), workDate })));

  const result = await withTimesheetSnapshotTransaction(lockPairs, async client => {
    const locked = (await client.query<IApprovalRow>(
      `SELECT id, department_id::text AS department_id, manager_employee_id,
              start_date::text AS start_date, end_date::text AS end_date, status,
              unlocked_at::text AS unlocked_at, version_dirty_at::text AS version_dirty_at
         FROM timesheet_approvals WHERE id = $1 FOR UPDATE`,
      [approvalId],
    )).rows[0];
    if (!locked || !isRebuildableApproval(locked)) return { created: false, revision: null, removedIds: [] as number[] };
    const hidden = (await client.query<{ employee_id: number }>(LATEST_HIDDEN_FIRED_SQL, [[approvalId]])).rows;
    if (hidden.length === 0) return { created: false, revision: null, removedIds: [] as number[] };
    return rebuildVersionWithoutEmployees(client, {
      id: Number(locked.id),
      department_id: locked.department_id,
      manager_employee_id: locked.manager_employee_id != null ? Number(locked.manager_employee_id) : null,
      start_date: locked.start_date,
      end_date: locked.end_date,
      status: locked.status,
    }, new Set(hidden.map(row => Number(row.employee_id))));
  });

  if (result.created) {
    // Побочные эффекты — после транзакции: повтор снимка не должен их дублировать.
    await auditService.log({
      user_id: null,
      action: AUDIT_ACTIONS.TIMESHEET_VERSION_FIRED_REMOVED,
      entity_type: 'timesheet_approval',
      entity_id: String(approvalId),
      details: { revision: result.revision, removed_employees: result.removedIds },
    });
  }
  return result;
}
