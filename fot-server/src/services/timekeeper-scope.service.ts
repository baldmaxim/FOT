import type { AuthenticatedRequest } from '../types/index.js';
import { query } from '../config/postgres.js';

/**
 * Скоуп роли «Табельщица» (timekeeper).
 *
 * Табельщице назначаются «объекты входа» (skud_objects) через timekeeper_object_access.
 * Её зона доступа складывается из двух источников, которые ложатся на существующие
 * примитивы скоупа (см. data-scope.service.ts):
 *   - department_object_assignment: отделы/бригады, назначенные её объектам →
 *     «явные отделы» (далее subtree-расширение в resolveAccessibleDepartmentIds);
 *   - employee_object_assignment: сотрудники, назначенные её объектам явно (мультиобъектные)
 *     → множество «прямых» сотрудников (путь listDirectSubordinates).
 *
 * Таблицы развязаны с 1С-выгрузкой и employee_skud_object_access — читаются только здесь.
 */

export const TIMEKEEPER_ROLE_CODE = 'timekeeper';

export function isTimekeeper(req: AuthenticatedRequest): boolean {
  return req.user.role_code === TIMEKEEPER_ROLE_CODE;
}

/** Объекты, назначенные табельщице. */
export async function resolveTimekeeperObjectIds(timekeeperUserId: string): Promise<string[]> {
  const rows = await query<{ skud_object_id: string }>(
    `SELECT skud_object_id
       FROM timekeeper_object_access
      WHERE timekeeper_user_id = $1::uuid AND is_active = true`,
    [timekeeperUserId],
  );
  return [...new Set(rows.map(r => r.skud_object_id))];
}

/**
 * «Явные отделы» табельщицы = отделы/бригады, назначенные её объектам
 * (department_object_assignment ∩ её объекты). По user_id, без req-кэша —
 * для использования вне запроса (buildProfileResponse).
 */
export async function listTimekeeperDepartmentSeeds(timekeeperUserId: string): Promise<string[]> {
  const rows = await query<{ org_department_id: string }>(
    `SELECT DISTINCT doa.org_department_id
       FROM timekeeper_object_access toa
       JOIN department_object_assignment doa
         ON doa.skud_object_id = toa.skud_object_id AND doa.is_active = true
      WHERE toa.timekeeper_user_id = $1::uuid AND toa.is_active = true`,
    [timekeeperUserId],
  );
  return [...new Set(rows.map(r => r.org_department_id))];
}

/**
 * Как listTimekeeperDepartmentSeeds, но кэширует результат на req.
 * Subtree-расширение делает resolveAccessibleDepartmentIds.
 */
export async function resolveTimekeeperDepartmentSeeds(req: AuthenticatedRequest): Promise<string[]> {
  if (req.user.__timekeeper_dept_seeds) return req.user.__timekeeper_dept_seeds;
  const seeds = await listTimekeeperDepartmentSeeds(req.user.id);
  req.user.__timekeeper_dept_seeds = seeds;
  return seeds;
}

/**
 * Полное поддерево доступных отделов табельщицы (семена + все потомки).
 * Для buildProfileResponse → managed_department_ids: фронт показывает в селекторе
 * все дочерние бригады, даже если объект назначен на родительский отдел.
 */
export async function listTimekeeperAccessibleDepartmentIds(timekeeperUserId: string): Promise<string[]> {
  const seeds = await listTimekeeperDepartmentSeeds(timekeeperUserId);
  if (seeds.length === 0) return [];
  const rows = await query<{ id: string }>(
    'SELECT id FROM public.get_descendant_department_ids($1::uuid[])',
    [seeds],
  );
  const subtree = rows.map(r => r.id);
  return subtree.length > 0 ? [...new Set([...seeds, ...subtree])] : seeds;
}

/**
 * Сотрудники, назначенные объектам табельщицы ЯВНО (employee_object_assignment).
 * По user_id, без req-кэша — для использования вне запроса (buildProfileResponse).
 */
export async function listTimekeeperDirectEmployeeIds(timekeeperUserId: string): Promise<number[]> {
  const rows = await query<{ employee_id: number | string }>(
    `SELECT DISTINCT eoa.employee_id
       FROM timekeeper_object_access toa
       JOIN employee_object_assignment eoa
         ON eoa.skud_object_id = toa.skud_object_id AND eoa.is_active = true
      WHERE toa.timekeeper_user_id = $1::uuid AND toa.is_active = true`,
    [timekeeperUserId],
  );
  return [...new Set(
    rows.map(r => Number(r.employee_id)).filter((id): id is number => Number.isInteger(id)),
  )];
}

/**
 * Как listTimekeeperDirectEmployeeIds, но Set + кэш на req.
 * Эквивалент «прямых подчинённых» для скоупа табельщицы.
 */
export async function resolveTimekeeperDirectEmployeeIds(req: AuthenticatedRequest): Promise<Set<number>> {
  if (req.user.__timekeeper_direct_employees) return req.user.__timekeeper_direct_employees;
  const ids = new Set(await listTimekeeperDirectEmployeeIds(req.user.id));
  req.user.__timekeeper_direct_employees = ids;
  return ids;
}
