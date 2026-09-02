// Руководители ОТДЕЛА — для публичного метода 1С «кто у сотрудника начальник отдела».
//
// Намеренно отдельно от approval-routing.service.ts: там резолвится «кто согласует»
// (сначала адресно назначенный ответственный из employee_direct_reports, и только потом
// отдел). Для вопроса «кто руководитель отдела» та логика не годится — она подставит
// человеку руководителя из чужого отдела.
//
// Отдельного поля «руководитель отдела» в схеме нет: в org_departments такой колонки не
// существует. Руководителем считается активный РУЧНОЙ full-доступ к отделу. Поэтому
// источник в API называется department_full_access, а не department_head — контракт не
// обещает больше, чем гарантируют данные.

import { query, type DbExecutor } from '../config/postgres.js';

/**
 * Что считается назначением руководителя отдела.
 *
 * source <> 'sigur_sync' критичен: синк СКУД пишет в ту же таблицу обычное членство,
 * и без фильтра начальником своего отдела стал бы каждый рядовой сотрудник.
 *
 * Константа общая с listFullManagersForDepartments (approval-routing) — правило «что
 * такое full-доступ» должно жить в одном месте.
 */
export const DEPARTMENT_MANAGER_CONDITION_SQL =
  "is_active = true AND access_level = 'full' AND source <> 'sigur_sync'";

/** SELECT через клиент транзакции, если он передан, иначе через пул (см. DbExecutor). */
async function runQuery<T extends import('pg').QueryResultRow>(
  exec: DbExecutor | undefined, sql: string, params?: readonly unknown[],
): Promise<T[]> {
  if (exec) return (await exec.query<T>(sql, params as unknown[] | undefined)).rows;
  return query<T>(sql, params);
}

/**
 * departmentId → employee_id руководителей этого отдела.
 *
 * Ключ есть только у отделов, где назначение нашлось: отсутствие ключа = руководителя
 * нет. Наследование от родительских отделов НЕ выполняется намеренно.
 *
 * exec обязателен при материализации версии: снимок читается из того же среза БД,
 * что и часы.
 */
export async function listDepartmentManagers(
  departmentIds: readonly string[],
  exec?: DbExecutor,
): Promise<Map<string, number[]>> {
  const map = new Map<string, number[]>();
  const ids = [...new Set(departmentIds.filter(id => typeof id === 'string' && id.length > 0))];
  if (ids.length === 0) return map;

  const rows = await runQuery<{ employee_id: string | number; department_id: string }>(
    exec,
    `SELECT employee_id, department_id
       FROM employee_department_access
      WHERE department_id = ANY($1::uuid[])
        AND ${DEPARTMENT_MANAGER_CONDITION_SQL}
      ORDER BY employee_id`,
    [ids],
  );

  for (const row of rows) {
    const dept = String(row.department_id);
    const list = map.get(dept) ?? [];
    list.push(Number(row.employee_id));
    map.set(dept, list);
  }
  return map;
}
