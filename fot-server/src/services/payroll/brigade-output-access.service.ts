/**
 * Право на выработку бригад (миграция 342): список payroll_section_access ИЛИ галочка «Выработка» в назначениях.
 *
 * Открывает только «Табель → Бригады» с вводом и «Зарплату по объектам» на просмотр. Раздел «Зарплата» галочка не
 * открывает: page-ключи /salary/* решает только список (payroll-access.service). Отдельный гард, а не ключ страницы:
 * resolveEffectivePageAccess пропускает is_admin, и новый ключ открыл бы вкладки всем админам.
 */
import type { PoolClient } from 'pg';

import { query, queryOne } from '../../config/postgres.js';
import type { AuthenticatedRequest } from '../../types/index.js';
import { getRequestPayrollSectionAccess } from './payroll-access.service.js';

/**
 * Есть ли у сотрудника галочка. Предикат зовут гард и /auth/me, поэтому недоступная база (в том числе таблица до
 * миграции 342) означает «нет доступа» — fail-closed, а не 500.
 */
export async function hasBrigadeOutputGrant(employeeId: number | null | undefined): Promise<boolean> {
  if (!employeeId) return false;
  try {
    const rows = await query<{ employee_id: number | string }>(
      'SELECT employee_id FROM employee_brigade_output_access WHERE employee_id = $1',
      [employeeId],
    );
    return rows.length > 0;
  } catch (err) {
    console.warn('[brigade-output-access] grant check failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

/** Право текущего пользователя с кэшем на время HTTP-запроса: его читают гард и функции охвата. */
export async function getRequestBrigadeOutputAccess(req: AuthenticatedRequest): Promise<boolean> {
  if (req.user.__brigade_output_access !== undefined) return req.user.__brigade_output_access;
  const allowed = await getRequestPayrollSectionAccess(req) || await hasBrigadeOutputGrant(req.user.employee_id);
  req.user.__brigade_output_access = allowed;
  return allowed;
}

/** Галочка для панели назначений: ошибка базы пробрасывается, а не подменяется «нет». */
export async function loadBrigadeOutputGrant(employeeId: number): Promise<boolean> {
  const row = await queryOne<{ employee_id: number | string }>(
    'SELECT employee_id FROM employee_brigade_output_access WHERE employee_id = $1',
    [employeeId],
  );
  return row !== null;
}

/** Поставить или снять галочку в транзакции вызывающего; true — что-то изменилось. */
export async function setBrigadeOutputGrant(
  client: PoolClient,
  employeeId: number,
  granted: boolean,
  createdBy: string | null,
): Promise<boolean> {
  const result = granted
    ? await client.query(
      `INSERT INTO employee_brigade_output_access (employee_id, created_by)
       VALUES ($1, $2)
       ON CONFLICT (employee_id) DO NOTHING
       RETURNING employee_id`,
      [employeeId, createdBy],
    )
    : await client.query(
      'DELETE FROM employee_brigade_output_access WHERE employee_id = $1 RETURNING employee_id',
      [employeeId],
    );
  return result.rows.length > 0;
}
