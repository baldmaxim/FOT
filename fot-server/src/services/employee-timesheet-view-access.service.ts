/**
 * «Просмотр табеля» (миграция 309, вкладка в «Система → Назначения сотрудников»): кому
 * чей табель доступен ТОЛЬКО на просмотр.
 *
 * Это не прямые подчинённые (employee_direct_reports, вкладка «Человек»): связь не даёт
 * ни подачи, ни согласований, ни правки, у сотрудника может быть сколько угодно
 * смотрящих. Читают её только read-ветки табеля (грид «Мои сотрудники», окно дня,
 * поиск «По сотруднику») и просмотр событий СКУД из окна дня. Подачи, согласования,
 * маршрутизация и выгрузки её не знают — так и должно остаться.
 */
import type { PoolClient } from 'pg';

import { query } from '../config/postgres.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { isTimekeeper } from './timekeeper-scope.service.js';

let missingTableWarned = false;

const isMissingTableError = (err: unknown): boolean => (
  !!err && typeof err === 'object' && (err as { code?: unknown }).code === '42P01'
);

const warnMissingTable = (): void => {
  if (missingTableWarned) return;
  missingTableWarned = true;
  console.warn('[timesheet-view-access] table public.employee_timesheet_view_access not found; feature disabled.');
};

export interface ITimesheetViewAssignment {
  employee_id: number;
  full_name: string;
  employment_status: string | null;
}

/** Кого смотрит сотрудник — для панели назначений (включая уволенных: их можно снять). */
export async function listTimesheetViewAssignments(viewerEmployeeId: number): Promise<ITimesheetViewAssignment[]> {
  const rows = await query<{ employee_id: number | string; full_name: string | null; employment_status: string | null }>(
    `SELECT a.employee_id, e.full_name, e.employment_status
       FROM employee_timesheet_view_access a
       JOIN employees e ON e.id = a.employee_id
      WHERE a.viewer_employee_id = $1
      ORDER BY e.full_name`,
    [viewerEmployeeId],
  );
  return rows.map(row => ({
    employee_id: Number(row.employee_id),
    full_name: String(row.full_name || ''),
    employment_status: row.employment_status ?? null,
  }));
}

/** id сотрудников, чей табель смотрит viewer. Без таблицы (до миграции 309) — пусто. */
export async function listTimesheetViewEmployeeIds(viewerEmployeeId: number): Promise<number[]> {
  if (!Number.isInteger(viewerEmployeeId) || viewerEmployeeId <= 0) return [];
  try {
    const rows = await query<{ employee_id: number | string }>(
      'SELECT employee_id FROM employee_timesheet_view_access WHERE viewer_employee_id = $1',
      [viewerEmployeeId],
    );
    return rows
      .map(row => Number(row.employee_id))
      .filter(id => Number.isInteger(id) && id > 0 && id !== viewerEmployeeId);
  } catch (err) {
    if (isMissingTableError(err)) {
      warnMissingTable();
      return [];
    }
    throw err;
  }
}

/**
 * Список просмотра текущего пользователя с кэшем на время HTTP-запроса. Табельщице —
 * пусто: её скоуп бригадный, отдельного грида «Мои сотрудники» у неё нет (как и прямых
 * подчинённых в resolveEffectiveDirectSubordinates).
 */
export async function resolveTimesheetViewOnlyEmployeeIds(req: AuthenticatedRequest): Promise<Set<number>> {
  if (req.user.__timesheet_view_only_ids) return req.user.__timesheet_view_only_ids;
  const ids = (req.user.employee_id == null || isTimekeeper(req))
    ? new Set<number>()
    : new Set(await listTimesheetViewEmployeeIds(req.user.employee_id));
  req.user.__timesheet_view_only_ids = ids;
  return ids;
}

/**
 * Полная замена списка viewer → ids. Строка смотрящего в employees блокируется FOR UPDATE:
 * два параллельных сохранения панели выполняются по очереди, и в базе остаётся список
 * последнего, а не объединение двух. Возвращает фактически добавленных и снятых.
 */
export async function replaceTimesheetViewEmployees(
  client: PoolClient,
  viewerEmployeeId: number,
  employeeIds: number[],
  createdBy: string | null,
): Promise<{ added: number[]; removed: number[] }> {
  const ids = [...new Set(employeeIds)].filter(id => id !== viewerEmployeeId);
  await client.query('SELECT 1 FROM employees WHERE id = $1 FOR UPDATE', [viewerEmployeeId]);
  const removed = await client.query<{ employee_id: number | string }>(
    `DELETE FROM employee_timesheet_view_access
      WHERE viewer_employee_id = $1 AND employee_id <> ALL($2::bigint[])
      RETURNING employee_id`,
    [viewerEmployeeId, ids],
  );
  const added = ids.length > 0
    ? await client.query<{ employee_id: number | string }>(
      `INSERT INTO employee_timesheet_view_access (viewer_employee_id, employee_id, created_by)
       SELECT $1, unnest($2::bigint[]), $3
       ON CONFLICT (viewer_employee_id, employee_id) DO NOTHING
       RETURNING employee_id`,
      [viewerEmployeeId, ids, createdBy],
    )
    : { rows: [] as Array<{ employee_id: number | string }> };
  const toSorted = (rows: Array<{ employee_id: number | string }>): number[] => (
    rows.map(row => Number(row.employee_id)).sort((a, b) => a - b)
  );
  return { added: toSorted(added.rows), removed: toSorted(removed.rows) };
}
