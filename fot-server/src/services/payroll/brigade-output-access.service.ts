/**
 * Право на выработку бригад (миграция 342): список payroll_section_access ИЛИ галочка «Выработка» в назначениях.
 * Галочка начальника участка (миграция 370) — уже: «Зарплата по объектам» своих бригад и только КТУ 0,8–1,6.
 *
 * Открывает только «Табель → Бригады» с вводом и «Зарплату по объектам» на просмотр. Раздел «Зарплата» галочка не
 * открывает: page-ключи /salary/* решает только список (payroll-access.service). Отдельный гард, а не ключ страницы:
 * resolveEffectivePageAccess пропускает is_admin, и новый ключ открыл бы вкладки всем админам.
 */
import type { PoolClient } from 'pg';

import { query, queryOne } from '../../config/postgres.js';
import type { AuthenticatedRequest } from '../../types/index.js';
import { listSupervisedBrigadeIds } from '../brigade-supervisors.service.js';
import {
  KTU_MAX_TENTHS,
  KTU_MIN_TENTHS,
  SUPERVISOR_KTU_MAX_TENTHS,
  SUPERVISOR_KTU_MIN_TENTHS,
} from './brigade-salary.calc.js';
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

/**
 * Галочка «Ставить КТУ своим бригадам» (370) ∧ бригады, где сотрудник сейчас начальник участка. Авторизация: ошибка
 * базы (в том числе таблица до 370) — [] (fail-closed), кэш на время HTTP-запроса.
 */
export async function getRequestSupervisorKtuBrigadeIds(req: AuthenticatedRequest): Promise<string[]> {
  if (req.user.__supervisor_ktu_brigade_ids !== undefined) return req.user.__supervisor_ktu_brigade_ids;
  const ids = await resolveSupervisorKtuBrigadeIds(req.user.employee_id);
  req.user.__supervisor_ktu_brigade_ids = ids;
  return ids;
}

/** То же без запроса — для /auth/me: галочка ∧ текущие бригады начальника; ошибка базы — []. */
export async function resolveSupervisorKtuBrigadeIds(employeeId: number | null | undefined): Promise<string[]> {
  if (!employeeId) return [];
  try {
    return (await loadSupervisorKtuGrant(employeeId)) ? await listSupervisedBrigadeIds(employeeId) : [];
  } catch (err) {
    console.warn('[brigade-output-access] supervisor grant check failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Уровень доступа к расчёту бригад — один на запрос, старшинство: список «Зарплаты» → галочка «Выработка» →
 * галочка начальника (при своих бригадах) → нет. Обе галочки — «Выработка». Отсюда гард, охват бригады, пределы КТУ,
 * access ответа и can_edit строк.
 */
export type BrigadeSalaryLevel =
  | { kind: 'payroll' }
  | { kind: 'output' }
  | { kind: 'supervisor'; brigadeIds: ReadonlySet<string> }
  | { kind: 'none' };

export async function getRequestBrigadeSalaryLevel(req: AuthenticatedRequest): Promise<BrigadeSalaryLevel> {
  if (await getRequestPayrollSectionAccess(req)) return { kind: 'payroll' };
  if (await getRequestBrigadeOutputAccess(req)) return { kind: 'output' };
  const brigadeIds = await getRequestSupervisorKtuBrigadeIds(req);
  return brigadeIds.length > 0 ? { kind: 'supervisor', brigadeIds: new Set(brigadeIds) } : { kind: 'none' };
}

/** Пределы КТУ уровня в десятых: начальник участка — 0,8…1,6, остальные с правом — 0,0…2,2. */
export const ktuRangeOf = (level: BrigadeSalaryLevel): { min: number; max: number } => (
  level.kind === 'supervisor'
    ? { min: SUPERVISOR_KTU_MIN_TENTHS, max: SUPERVISOR_KTU_MAX_TENTHS }
    : { min: KTU_MIN_TENTHS, max: KTU_MAX_TENTHS }
);

/** Галочка начальника для панели и авторизации: ошибка базы пробрасывается (панель — 500). */
export async function loadSupervisorKtuGrant(employeeId: number): Promise<boolean> {
  const row = await queryOne<{ employee_id: number | string }>(
    'SELECT employee_id FROM employee_supervisor_ktu_access WHERE employee_id = $1',
    [employeeId],
  );
  return row !== null;
}

/** Поставить или снять галочку начальника в транзакции вызывающего; true — что-то изменилось. */
export async function setSupervisorKtuGrant(
  client: PoolClient,
  employeeId: number,
  granted: boolean,
  createdBy: string | null,
): Promise<boolean> {
  const result = granted
    ? await client.query(
      `INSERT INTO employee_supervisor_ktu_access (employee_id, created_by)
       VALUES ($1, $2)
       ON CONFLICT (employee_id) DO NOTHING
       RETURNING employee_id`,
      [employeeId, createdBy],
    )
    : await client.query(
      'DELETE FROM employee_supervisor_ktu_access WHERE employee_id = $1 RETURNING employee_id',
      [employeeId],
    );
  return result.rows.length > 0;
}
