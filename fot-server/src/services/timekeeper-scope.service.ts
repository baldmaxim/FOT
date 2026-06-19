import type { AuthenticatedRequest } from '../types/index.js';
import { query } from '../config/postgres.js';

/**
 * Скоуп роли «Табельщица» (timekeeper).
 *
 * Табельщице назначаются «объекты входа» (timekeeper_object_access) и «папки»
 * оргструктуры (timekeeper_folder_access). Её «явные отделы» (seeds скоупа) =
 * ПЕРЕСЕЧЕНИЕ: бригады, где есть работники с её объектов (employee_skud_object_access),
 * И входящие в поддерево выбранных папок. Эти бригады питают resolveAccessibleDepartmentIds,
 * managed_department_ids и «назначенный режим» (collectAssignedEmployees → начальники участка).
 * См. listTimekeeperDepartmentSeeds. Папки не выбраны → seeds пусто (строго).
 */

export const TIMEKEEPER_ROLE_CODE = 'timekeeper';

/**
 * Окно (в днях) для ветки «присутствие по фактическим проходам СКУД».
 * Бригада/сотрудник считаются присутствующими на объекте табельщицы, если за
 * последние N дней были проходы через проходные этого объекта. Согласовано с
 * прецедентом listSelectableObjectsForEmployee (employee-skud-object-access.service.ts).
 */
export const TIMEKEEPER_PRESENCE_WINDOW_DAYS = 90;

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
 * Видимые табельщице бригады = ПЕРЕСЕЧЕНИЕ:
 *   - «присутствуют на её объектах» (две ветки, объединяются UNION):
 *       (B) ручная привязка «место работы» — employee_skud_object_access;
 *       (A) фактические проходы СКУД за последние TIMEKEEPER_PRESENCE_WINDOW_DAYS дней —
 *           skud_events → skud_object_access_points (как в табеле «По объектам»).
 *     В обеих ветках бригада берётся из employee_department_access (kind='brigade');
 *   - «входят в выбранные папки»: поддерево timekeeper_folder_access (get_descendant_department_ids).
 * Папки не выбраны → пусто (строго): табельщица не видит никого.
 *
 * Эти бригады — seeds скоупа: их получают resolveAccessibleDepartmentIds (доступ грида),
 * managed_department_ids профиля и collectAssignedEmployees (managedIds → начальники участка).
 * Бригады-листья, поэтому subtree-расширение их не размножает.
 */
export async function listTimekeeperDepartmentSeeds(timekeeperUserId: string): Promise<string[]> {
  const folders = await query<{ department_id: string }>(
    `SELECT department_id FROM timekeeper_folder_access
      WHERE timekeeper_user_id = $1::uuid AND is_active = true`,
    [timekeeperUserId],
  );
  if (folders.length === 0) return [];
  const folderIds = [...new Set(folders.map(r => r.department_id))];

  const rows = await query<{ id: string }>(
    `WITH folder_desc AS (
       SELECT id FROM public.get_descendant_department_ids($2::uuid[])
     ),
     present AS (
       -- (B) ручная привязка «место работы»
       SELECT DISTINCT eda.department_id AS id
         FROM timekeeper_object_access toa
         JOIN employee_skud_object_access esoa
           ON esoa.skud_object_id = toa.skud_object_id AND esoa.is_active = true
         JOIN employee_department_access eda
           ON eda.employee_id = esoa.employee_id AND eda.is_active = true
         JOIN org_departments d ON d.id = eda.department_id AND d.kind = 'brigade'
        WHERE toa.timekeeper_user_id = $1::uuid AND toa.is_active = true
       UNION
       -- (A) фактические проходы СКУД на объекты табельщицы за окно
       SELECT DISTINCT eda.department_id AS id
         FROM timekeeper_object_access toa
         JOIN skud_object_access_points sap ON sap.object_id = toa.skud_object_id
         JOIN skud_events se
           ON BTRIM(se.access_point) = BTRIM(sap.access_point_name)
          AND se.event_date >= (CURRENT_DATE - INTERVAL '${TIMEKEEPER_PRESENCE_WINDOW_DAYS} days')
         JOIN employee_department_access eda
           ON eda.employee_id = se.employee_id AND eda.is_active = true
         JOIN org_departments d ON d.id = eda.department_id AND d.kind = 'brigade'
        WHERE toa.timekeeper_user_id = $1::uuid AND toa.is_active = true
     )
     SELECT p.id FROM present p WHERE p.id IN (SELECT id FROM folder_desc)`,
    [timekeeperUserId, folderIds],
  );
  return [...new Set(rows.map(r => r.id))];
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
 * Сотрудники объектов табельщицы из трёх источников:
 *   - назначенные ЯВНО (employee_object_assignment);
 *   - место работы СКУД (employee_skud_object_access);
 *   - фактические проходы СКУД за последние TIMEKEEPER_PRESENCE_WINDOW_DAYS дней
 *     (skud_events → skud_object_access_points).
 * По user_id, без req-кэша — для использования вне запроса (buildProfileResponse).
 */
export async function listTimekeeperDirectEmployeeIds(timekeeperUserId: string): Promise<number[]> {
  const rows = await query<{ employee_id: number | string }>(
    `SELECT DISTINCT u.employee_id FROM (
       SELECT eoa.employee_id
         FROM timekeeper_object_access toa
         JOIN employee_object_assignment eoa
           ON eoa.skud_object_id = toa.skud_object_id AND eoa.is_active = true
        WHERE toa.timekeeper_user_id = $1::uuid AND toa.is_active = true
       UNION
       SELECT esoa.employee_id
         FROM timekeeper_object_access toa
         JOIN employee_skud_object_access esoa
           ON esoa.skud_object_id = toa.skud_object_id AND esoa.is_active = true
        WHERE toa.timekeeper_user_id = $1::uuid AND toa.is_active = true
       UNION
       SELECT se.employee_id
         FROM timekeeper_object_access toa
         JOIN skud_object_access_points sap ON sap.object_id = toa.skud_object_id
         JOIN skud_events se
           ON BTRIM(se.access_point) = BTRIM(sap.access_point_name)
          AND se.event_date >= (CURRENT_DATE - INTERVAL '${TIMEKEEPER_PRESENCE_WINDOW_DAYS} days')
        WHERE toa.timekeeper_user_id = $1::uuid AND toa.is_active = true
     ) u`,
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
