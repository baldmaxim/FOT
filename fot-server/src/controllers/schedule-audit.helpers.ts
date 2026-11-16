/**
 * След смены графика сотрудника: кто, когда, было → стало.
 *
 * Снимок назначений берётся до и после операции в той же транзакции, запись
 * аудита пишется тем же клиентом: не записался след — откатывается и смена.
 */
import type { PoolClient } from 'pg';
import { AUDIT_ACTIONS, auditService } from '../services/audit.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

export type ScheduleAuditOperation =
  | 'assign'
  | 'fix'
  | 'delete'
  | 'remove'
  | 'brigade_assign'
  | 'brigade_reset'
  | 'brigade_shift_start';

export interface IScheduleAuditRow {
  id: string;
  schedule_id: string;
  schedule_name: string | null;
  effective_from: string;
  effective_to: string | null;
  anchor_date: string | null;
}

export interface IScheduleAuditInput {
  employeeId: number;
  operation: ScheduleAuditOperation;
  /** Дата, на которую показываем «было → стало»; функция — если она известна только из снимка «до». */
  date: string | null | ((before: IScheduleAuditRow[]) => string | null);
  assignmentId?: string;
  brigadeNames?: string[];
}

export const loadScheduleAuditSnapshot = async (
  client: PoolClient,
  employeeId: number,
): Promise<IScheduleAuditRow[]> => {
  const { rows } = await client.query<IScheduleAuditRow>(
    `SELECT a.id, a.schedule_id, ws.name AS schedule_name,
            a.effective_from, a.effective_to, a.anchor_date
       FROM employee_schedule_assignments a
       LEFT JOIN work_schedules ws ON ws.id = a.schedule_id
      WHERE a.employee_id = $1
      ORDER BY a.effective_from ASC, a.id ASC`,
    [employeeId],
  );
  return rows;
};

/** Запись, действующая на дату (как resolveSchedule: самая поздняя по началу). */
const rowAt = (rows: IScheduleAuditRow[], date: string | null): IScheduleAuditRow | null => {
  if (!date) return null;
  return [...rows].reverse().find(row =>
    row.effective_from <= date && (row.effective_to === null || row.effective_to >= date)) ?? null;
};

const sameRows = (a: IScheduleAuditRow[], b: IScheduleAuditRow[]): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

export const logEmployeeScheduleChange = async (
  client: PoolClient,
  req: AuthenticatedRequest,
  input: Omit<IScheduleAuditInput, 'date'> & {
    date: string | null;
    before: IScheduleAuditRow[];
    after: IScheduleAuditRow[];
  },
): Promise<boolean> => {
  if (sameRows(input.before, input.after)) return false;

  const { rows } = await client.query<{ full_name: string | null; default_name: string | null }>(
    `SELECT (SELECT full_name FROM employees WHERE id = $1) AS full_name,
            (SELECT name FROM work_schedules WHERE is_default = true LIMIT 1) AS default_name`,
    [input.employeeId],
  );
  const meta = rows[0] ?? null;
  const defaultName = meta?.default_name ?? null;
  const from = rowAt(input.before, input.date);
  const to = rowAt(input.after, input.date);

  await auditService.logFromRequestWithClient(client, req, req.user.id, AUDIT_ACTIONS.EMPLOYEE_SCHEDULE_CHANGED, {
    entityType: 'employee',
    entityId: String(input.employeeId),
    details: {
      employee_id: input.employeeId,
      employee_full_name: meta?.full_name ?? null,
      operation: input.operation,
      date: input.date,
      from_schedule_name: from ? from.schedule_name : defaultName,
      from_is_default: !from,
      to_schedule_name: to ? to.schedule_name : defaultName,
      to_is_default: !to,
      ...(input.assignmentId ? { assignment_id: input.assignmentId } : {}),
      ...(input.brigadeNames && input.brigadeNames.length > 0 ? { brigade_names: input.brigadeNames } : {}),
      before: input.before,
      after: input.after,
    },
  });
  return true;
};

/** Снимок до → операция → снимок после → след (если назначения изменились). */
export const runWithScheduleAudit = async <T>(
  client: PoolClient,
  req: AuthenticatedRequest,
  input: IScheduleAuditInput,
  run: () => Promise<T>,
): Promise<T> => {
  const before = await loadScheduleAuditSnapshot(client, input.employeeId);
  const result = await run();
  const after = await loadScheduleAuditSnapshot(client, input.employeeId);
  const date = typeof input.date === 'function' ? input.date(before) : input.date;
  await logEmployeeScheduleChange(client, req, { ...input, date, before, after });
  return result;
};
