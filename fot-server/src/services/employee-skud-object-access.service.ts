/**
 * Приписка сотрудника к объекту строительства (skud_objects).
 *
 * Семантика — атрибут самого сотрудника (его «место работы»),
 * НЕ зависит от того, через какие проходные он реально пробивается.
 *
 * Используется на /skud-presence: для пользователя с записями
 * сетка объектов фильтруется по его employee_id → object_ids.
 * Внутри бакета объекта по-прежнему показывается фактическое
 * присутствие (skud_events за день).
 */
import { execute, query } from '../config/postgres.js';
import type { AuthenticatedRequest } from '../types/index.js';

let missingTableWarned = false;

function isMissingTableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? String((error as { code?: unknown }).code || '') : '';
  return code === '42P01';
}

function warnMissingTable(): void {
  if (missingTableWarned) return;
  missingTableWarned = true;
  console.warn(
    '[employee-skud-object-access] table public.employee_skud_object_access not found; feature disabled.',
  );
}

export async function listObjectIdsForEmployee(employeeId: number): Promise<string[]> {
  if (!Number.isInteger(employeeId) || employeeId <= 0) return [];
  try {
    const rows = await query<{ skud_object_id: string }>(
      `SELECT skud_object_id FROM employee_skud_object_access
       WHERE employee_id = $1 AND is_active = true`,
      [employeeId],
    );
    return [...new Set(rows.map(row => row.skud_object_id).filter(Boolean))];
  } catch (err) {
    if (isMissingTableError(err)) {
      warnMissingTable();
      return [];
    }
    throw err;
  }
}

/**
 * Батч-вариант listObjectIdsForEmployee: одним запросом возвращает приписки
 * для набора сотрудников. Используется в табеле по объектам, чтобы относить
 * часы общей корректировки к «месту работы» сотрудника.
 */
export async function listObjectIdsForEmployees(
  employeeIds: number[],
): Promise<Map<number, string[]>> {
  const result = new Map<number, string[]>();
  const ids = [...new Set(employeeIds.filter(id => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return result;
  try {
    const rows = await query<{ employee_id: number | string; skud_object_id: string }>(
      `SELECT employee_id, skud_object_id FROM employee_skud_object_access
       WHERE employee_id = ANY($1::bigint[]) AND is_active = true`,
      [ids],
    );
    for (const row of rows) {
      const employeeId = Number(row.employee_id);
      if (!Number.isFinite(employeeId) || !row.skud_object_id) continue;
      const bucket = result.get(employeeId) || [];
      if (!bucket.includes(row.skud_object_id)) bucket.push(row.skud_object_id);
      result.set(employeeId, bucket);
    }
    return result;
  } catch (err) {
    if (isMissingTableError(err)) {
      warnMissingTable();
      return result;
    }
    throw err;
  }
}

export interface ISelectableObject {
  object_id: string;
  object_name: string;
}

/**
 * Имена объектов, где у сотрудников были СКУД-проходы за последние 14
 * календарных дат (включая сегодня; будущие ошибочные события отсекаются).
 * Для показа берётся короткое name («ЖК Alia»), при пустом — alt_name
 * (alt_name — полный адрес объекта, для UI слишком длинный). Только
 * активные объекты. Read-only обогащение очереди согласования выходных.
 */
export async function listRecentSkudObjectNamesByEmployee(
  employeeIds: number[],
): Promise<Map<number, string[]>> {
  const result = new Map<number, string[]>();
  const ids = [...new Set(employeeIds.filter(id => Number.isSafeInteger(id) && id > 0))];
  if (ids.length === 0) return result;
  try {
    const rows = await query<{ employee_id: number | string; object_name: string | null }>(
      `SELECT DISTINCT se.employee_id,
              COALESCE(NULLIF(BTRIM(so.name), ''), so.alt_name) AS object_name
         FROM skud_events se
         JOIN skud_object_access_points sap
           ON BTRIM(sap.access_point_name) = BTRIM(se.access_point)
         JOIN skud_objects so ON so.id = sap.object_id
        WHERE se.employee_id = ANY($1::bigint[])
          AND se.event_date BETWEEN CURRENT_DATE - 13 AND CURRENT_DATE
          AND se.access_point IS NOT NULL
          AND so.is_active = true
        ORDER BY 1, 2`,
      [ids],
    );
    for (const row of rows) {
      const employeeId = Number(row.employee_id);
      if (!Number.isSafeInteger(employeeId) || employeeId <= 0 || !row.object_name) continue;
      const names = result.get(employeeId) ?? [];
      if (!names.includes(row.object_name)) names.push(row.object_name);
      result.set(employeeId, names);
    }
    return result;
  } catch (err) {
    if (isMissingTableError(err)) {
      warnMissingTable();
      return result;
    }
    throw err;
  }
}

/**
 * Объекты, доступные сотруднику для привязки корректировки табеля:
 *   1) приписка employee_skud_object_access (его «место работы»);
 *   2) фактические объекты по СКУД-проходам за последние 90 дней;
 *   3) (удалёнка) датированная привязка employee_object_attribution.
 * Только активные skud_objects, отсортировано по имени. Каждый источник
 * отказоустойчив к отсутствию таблицы (42P01) — фича остаётся рабочей частично.
 */
export async function listSelectableObjectsForEmployee(
  employeeId: number,
): Promise<ISelectableObject[]> {
  if (!Number.isInteger(employeeId) || employeeId <= 0) return [];
  const ids = new Set<string>();

  for (const id of await listObjectIdsForEmployee(employeeId)) ids.add(id);

  try {
    const rows = await query<{ object_id: string }>(
      `SELECT DISTINCT sap.object_id::text AS object_id
         FROM skud_events se
         JOIN skud_object_access_points sap
           ON BTRIM(sap.access_point_name) = BTRIM(se.access_point)
        WHERE se.employee_id = $1
          AND se.event_date >= (CURRENT_DATE - INTERVAL '90 days')
          AND se.access_point IS NOT NULL`,
      [employeeId],
    );
    for (const row of rows) if (row.object_id) ids.add(row.object_id);
  } catch (err) {
    if (!isMissingTableError(err)) throw err;
  }

  try {
    const rows = await query<{ object_id: string }>(
      `SELECT DISTINCT skud_object_id::text AS object_id
         FROM employee_object_attribution WHERE employee_id = $1`,
      [employeeId],
    );
    for (const row of rows) if (row.object_id) ids.add(row.object_id);
  } catch (err) {
    if (!isMissingTableError(err)) throw err;
  }

  if (ids.size === 0) return [];

  try {
    return await query<ISelectableObject>(
      `SELECT id::text AS object_id, name AS object_name
         FROM skud_objects
        WHERE id = ANY($1::uuid[]) AND is_active = true
        ORDER BY name ASC`,
      [[...ids]],
    );
  } catch (err) {
    if (isMissingTableError(err)) {
      warnMissingTable();
      return [];
    }
    throw err;
  }
}

export async function listEmployeesForObject(objectId: string): Promise<number[]> {
  if (!objectId) return [];
  try {
    const rows = await query<{ employee_id: number | string }>(
      `SELECT employee_id FROM employee_skud_object_access
       WHERE skud_object_id = $1::uuid AND is_active = true`,
      [objectId],
    );
    return [...new Set(
      rows
        .map(row => (row.employee_id == null ? NaN : Number(row.employee_id)))
        .filter((id): id is number => Number.isFinite(id)),
    )];
  } catch (err) {
    if (isMissingTableError(err)) {
      warnMissingTable();
      return [];
    }
    throw err;
  }
}

export async function replaceEmployeeObjectAccess(params: {
  employeeId: number;
  objectIds: string[];
  actorUserId: string;
}): Promise<string[]> {
  const nextObjectIds = [...new Set(
    params.objectIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0),
  )];

  const existingRows = await query<{ skud_object_id: string; is_active: boolean }>(
    'SELECT skud_object_id, is_active FROM employee_skud_object_access WHERE employee_id = $1',
    [params.employeeId],
  );

  const nextSet = new Set(nextObjectIds);
  const activeIds = existingRows
    .filter(row => row.is_active)
    .map(row => row.skud_object_id);
  const idsToDeactivate = activeIds.filter(id => !nextSet.has(id));

  const now = new Date().toISOString();

  if (nextObjectIds.length > 0) {
    await execute(
      `INSERT INTO employee_skud_object_access
         (employee_id, skud_object_id, is_active, created_by, updated_at)
       SELECT $1::bigint, obj_id, true, $2::uuid, $3::timestamptz
         FROM unnest($4::uuid[]) AS obj_id
       ON CONFLICT (employee_id, skud_object_id)
       DO UPDATE SET
         is_active = true,
         created_by = COALESCE(employee_skud_object_access.created_by, EXCLUDED.created_by),
         updated_at = EXCLUDED.updated_at`,
      [params.employeeId, params.actorUserId, now, nextObjectIds],
    );
  }

  if (idsToDeactivate.length > 0) {
    await execute(
      `UPDATE employee_skud_object_access
          SET is_active = false, updated_at = $1::timestamptz
        WHERE employee_id = $2::bigint
          AND skud_object_id = ANY($3::uuid[])`,
      [now, params.employeeId, idsToDeactivate],
    );
  }

  return nextObjectIds;
}

/**
 * Резолв scoped-доступа к объектам для текущего запроса.
 *
 * Логика:
 * - employee_id отсутствует            → is_unrestricted=true  (тех-юзер / system-аккаунт)
 * - is_admin=true                      → is_unrestricted=true  (админу приписки опциональны)
 * - employee_id + 0 активных записей   → is_unrestricted=false, object_ids=[]  (видит пусто)
 * - employee_id + есть активные записи → is_unrestricted=false, object_ids=[...]
 *
 * Кешируется в req.user.__skud_object_scope на время одного запроса.
 */
export async function resolveAccessibleObjectIdsForRequest(
  req: AuthenticatedRequest,
): Promise<{ is_unrestricted: boolean; object_ids: string[] }> {
  if (req.user.__skud_object_scope) return req.user.__skud_object_scope;

  const employeeId = req.user.employee_id;
  if (employeeId == null || req.user.is_admin === true) {
    const scope = { is_unrestricted: true, object_ids: [] as string[] };
    req.user.__skud_object_scope = scope;
    return scope;
  }

  const objectIds = await listObjectIdsForEmployee(employeeId);
  const scope = { is_unrestricted: false, object_ids: objectIds };

  req.user.__skud_object_scope = scope;
  return scope;
}
