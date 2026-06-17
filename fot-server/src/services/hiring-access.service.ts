import { query } from '../config/postgres.js';

/**
 * Права доступа модуля «Заявки для HR» (подбор персонала).
 *
 * Руководитель отдела кадров определяется по ДОЛЖНОСТИ (positions.name),
 * по паттерну mol_persons (lower(name) ~ regex), а не ручной выдачей доступа.
 * Рекрутеры — члены пула hiring_recruiters. Ответственные за заявку —
 * строки hiring_request_assignees. Авто-доступ к вкладке получают рекрутеры,
 * руководитель отдела кадров и любой активный ответственный.
 */

// Должность руководителя отдела кадров. Регэксп (lower), устойчивый к написанию.
// TODO: вынести в системные настройки (override) при необходимости.
export const HR_HEAD_POSITION_REGEX = 'руководител.*управлени.*персонал';

export async function isHiringManagerByEmployee(employeeId: number | null | undefined): Promise<boolean> {
  if (!employeeId) return false;
  const rows = await query<{ ok: boolean }>(
    `SELECT TRUE AS ok
       FROM employees e
       JOIN positions p ON p.id = e.position_id
      WHERE e.id = $1 AND lower(p.name) ~ $2
      LIMIT 1`,
    [employeeId, HR_HEAD_POSITION_REGEX],
  );
  return rows.length > 0;
}

export async function isRecruiter(employeeId: number | null | undefined): Promise<boolean> {
  if (!employeeId) return false;
  const rows = await query<{ ok: boolean }>(
    `SELECT TRUE AS ok FROM hiring_recruiters
      WHERE employee_id = $1 AND is_active = TRUE LIMIT 1`,
    [employeeId],
  );
  return rows.length > 0;
}

export async function hasActiveHiringAssignment(employeeId: number | null | undefined): Promise<boolean> {
  if (!employeeId) return false;
  const rows = await query<{ ok: boolean }>(
    `SELECT TRUE AS ok FROM hiring_request_assignees
      WHERE employee_id = $1 AND is_active = TRUE LIMIT 1`,
    [employeeId],
  );
  return rows.length > 0;
}

export async function getActiveAssigneeEmployeeIds(requestId: number): Promise<number[]> {
  const rows = await query<{ employee_id: number }>(
    `SELECT employee_id FROM hiring_request_assignees
      WHERE request_id = $1 AND is_active = TRUE`,
    [requestId],
  );
  return rows.map(r => Number(r.employee_id));
}

/**
 * Доступ к ВКЛАДКЕ «Заявки для HR» (view) сверх роли: рекрутер пула,
 * руководитель отдела кадров (по должности) или любой активный ответственный.
 * Важно: рекрутер, удалённый из пула, но остающийся ответственным, доступ сохраняет.
 */
export async function hasHiringAutoAccess(
  employeeId: number | null | undefined,
  isAdmin: boolean,
): Promise<boolean> {
  if (isAdmin) return true;
  if (!employeeId) return false;
  const [recruiter, manager, assignment] = await Promise.all([
    isRecruiter(employeeId),
    isHiringManagerByEmployee(employeeId),
    hasActiveHiringAssignment(employeeId),
  ]);
  return recruiter || manager || assignment;
}
