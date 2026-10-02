/**
 * Один сотрудник-день — не более чем в одной утверждённой подаче.
 *
 * API 1С отдаёт последнюю редакцию каждой утверждённой подачи, и 1С складывает их как
 * есть: если один и тот же день сотрудника лежит в двух утверждённых подачах, его часы
 * попадают в 1С дважды. Так руководитель оказывался и в своей персональной подаче, и в
 * подаче своего отдела (Карасени, Душанова, Орешкин), подчинённый — в подаче отдела и в
 * персональной подаче руководителя, переведённый — в двух бригадах за день перевода.
 * Законных пересечений нет: перевод внутри периода режется окнами членства по дням.
 *
 * Проверка сравнивает последнюю редакцию подачи с последними редакциями остальных
 * утверждённых подач по парам «сотрудник + день». Строки с zero_activity не считаются —
 * 1С их не переносит.
 */
import { query, type DbExecutor } from '../config/postgres.js';
import { formatNameWithInitials } from '../utils/fio.utils.js';
import { formatTimesheetRangeLabel } from './timesheet-range.service.js';

export interface IApprovedDayConflict {
  employeeId: number;
  fullName: string | null;
  /** Другая утверждённая подача, где уже есть эти дни. */
  approvalId: number;
  /** Отдел другой подачи; null — персональная подача. */
  departmentId: string | null;
  departmentName: string | null;
  /** ФИО руководителя персональной подачи (у подачи отдела — null). */
  managerFullName: string | null;
  firstDay: string;
  lastDay: string;
  days: number;
  /** Часы этих дней в проверяемой подаче и в другой — по ним видно, не теряется ли что-то. */
  hours: number;
  otherHours: number;
}

export class TimesheetApprovedDayConflictError extends Error {
  readonly code = 'TIMESHEET_DAYS_ALREADY_APPROVED';
  readonly conflicts: IApprovedDayConflict[];

  constructor(approvalId: number, conflicts: IApprovedDayConflict[]) {
    super(`Подача ${approvalId}: дни сотрудников уже утверждены в другой подаче — ${conflicts.length}`);
    this.name = 'TimesheetApprovedDayConflictError';
    this.conflicts = conflicts;
  }
}

/**
 * Пары «сотрудник + день» последней редакции подачи $1, которые уже есть в последней
 * редакции другой утверждённой подачи с пересекающимся периодом.
 */
const APPROVED_DAY_CONFLICTS_SQL = `
  WITH self AS (
    SELECT id, start_date, end_date FROM timesheet_approvals WHERE id = $1
  ),
  mine AS (
    SELECT (emp->'identity'->>'employee_id')::int AS employee_id,
           d.day,
           COALESCE((emp->'days'->d.day->>'hours')::numeric, 0) AS hours
      FROM self
      JOIN LATERAL (
        SELECT v.payload FROM timesheet_versions v
         WHERE v.approval_id = self.id
         ORDER BY v.revision DESC
         LIMIT 1
      ) latest ON true
     CROSS JOIN LATERAL jsonb_array_elements(latest.payload->'employees') emp
     CROSS JOIN LATERAL jsonb_object_keys(COALESCE(emp->'days', '{}'::jsonb)) AS d(day)
     WHERE COALESCE((emp->>'zero_activity')::boolean, false) = false
  )
  SELECT a.id AS approval_id,
         a.department_id::text AS department_id,
         m.employee_id,
         e.full_name,
         od.name AS department_name,
         mgr.full_name AS manager_full_name,
         MIN(m.day) AS first_day,
         MAX(m.day) AS last_day,
         COUNT(*)::int AS days,
         SUM(m.hours) AS hours,
         SUM(COALESCE((oemp->'days'->m.day->>'hours')::numeric, 0)) AS other_hours
    FROM self
    JOIN timesheet_approvals a
      ON a.status = 'approved'
     AND a.id <> self.id
     AND a.start_date <= self.end_date
     AND a.end_date >= self.start_date
    JOIN LATERAL (
      SELECT v.payload FROM timesheet_versions v
       WHERE v.approval_id = a.id
       ORDER BY v.revision DESC
       LIMIT 1
    ) other ON true
   CROSS JOIN LATERAL jsonb_array_elements(other.payload->'employees') oemp
    JOIN mine m
      ON m.employee_id = (oemp->'identity'->>'employee_id')::int
     AND jsonb_exists(COALESCE(oemp->'days', '{}'::jsonb), m.day)
    LEFT JOIN employees e ON e.id = m.employee_id
    LEFT JOIN org_departments od ON od.id = a.department_id
    LEFT JOIN employees mgr ON mgr.id = a.manager_employee_id
   WHERE COALESCE((oemp->>'zero_activity')::boolean, false) = false
   GROUP BY a.id, a.department_id, m.employee_id, e.full_name, od.name, mgr.full_name
   ORDER BY e.full_name, m.employee_id, a.id`;

interface IConflictRow {
  approval_id: number | string;
  department_id: string | null;
  employee_id: number | string;
  full_name: string | null;
  department_name: string | null;
  manager_full_name: string | null;
  first_day: string;
  last_day: string;
  days: number | string;
  hours: number | string | null;
  other_hours: number | string | null;
}

/** exec — клиент транзакции; undefined — через пул. */
export async function findApprovedDayConflicts(
  exec: DbExecutor | undefined,
  approvalId: number,
): Promise<IApprovedDayConflict[]> {
  const rows = exec
    ? (await exec.query<IConflictRow>(APPROVED_DAY_CONFLICTS_SQL, [approvalId])).rows
    : await query<IConflictRow>(APPROVED_DAY_CONFLICTS_SQL, [approvalId]);
  return rows.map(row => ({
    employeeId: Number(row.employee_id),
    fullName: row.full_name,
    approvalId: Number(row.approval_id),
    departmentId: row.department_id,
    departmentName: row.department_name,
    managerFullName: row.manager_full_name,
    firstDay: row.first_day,
    lastDay: row.last_day,
    days: Number(row.days),
    hours: Math.round(Number(row.hours ?? 0) * 100) / 100,
    otherHours: Math.round(Number(row.other_hours ?? 0) * 100) / 100,
  }));
}

/**
 * Вызывать в транзакции утверждения после материализации версии: ошибка откатывает и
 * версию, и смену статуса.
 */
export async function assertNoApprovedDayConflicts(exec: DbExecutor, approvalId: number): Promise<void> {
  const conflicts = await findApprovedDayConflicts(exec, approvalId);
  if (conflicts.length > 0) throw new TimesheetApprovedDayConflictError(approvalId, conflicts);
}

const conflictScopeLabel = (conflict: IApprovedDayConflict): string => {
  if (conflict.departmentName) return `«${conflict.departmentName}»`;
  if (conflict.managerFullName) return `личный табель ${formatNameWithInitials(conflict.managerFullName)}`;
  return `табель №${conflict.approvalId}`;
};

/** «Душанова Е. А. — «Секретариат», 1–15 сен 2026» через «; ». */
export function formatApprovedDayConflicts(conflicts: readonly IApprovedDayConflict[]): string {
  return conflicts
    .map(conflict => {
      const name = conflict.fullName ? formatNameWithInitials(conflict.fullName) : `сотрудник ${conflict.employeeId}`;
      return `${name} — ${conflictScopeLabel(conflict)}, ${formatTimesheetRangeLabel(conflict.firstDay, conflict.lastDay)}`;
    })
    .join('; ');
}
