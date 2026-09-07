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
import { hasPageEdit } from './access-control.service.js';

/** Страница, право edit на которой обязательно для подачи табеля (см. requirePageAccess). */
const TIMESHEET_PAGE_KEY = '/timesheet';

/**
 * Что считается назначением руководителя отдела.
 *
 * source <> 'sigur_sync' критичен: синк СКУД пишет в ту же таблицу обычное членство,
 * и без фильтра начальником своего отдела стал бы каждый рядовой сотрудник.
 *
 * Константа общая с listFullManagersForDepartments (approval-routing) — правило «что
 * такое full-доступ» должно жить в одном месте. Вариант с алиасом нужен там, где к
 * employee_department_access подмешиваются JOIN'ы с собственным is_active
 * (system_roles), и неквалифицированное условие стало бы неоднозначным.
 */
export const departmentManagerConditionSql = (alias = ''): string => {
  const prefix = alias ? `${alias}.` : '';
  return `${prefix}is_active = true AND ${prefix}access_level = 'full' AND ${prefix}source <> 'sigur_sync'`;
};

export const DEPARTMENT_MANAGER_CONDITION_SQL = departmentManagerConditionSql();

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

/**
 * Руководители отдела, которые ФАКТИЧЕСКИ могут подать табель.
 *
 * listDepartmentManagers отвечает на вопрос «кто числится руководителем» и годится
 * для справочного API. Для приоритета «отдел вперёд личного руководителя» этого мало:
 * если у назначенного руководителя нет учётной записи или его роль не имеет can_edit
 * на /timesheet, сотрудник выпал бы из персональной подачи и не попал бы ни в какую
 * другую — появилась бы сирота. В проде такие владельцы full-доступа есть.
 *
 * Право на страницу проверяется через hasPageEdit (кэш ролей), а не JOIN'ом по
 * role_page_access: правило доступа к страницам должно жить в одном месте.
 */
export async function listEffectiveDepartmentManagers(
  departmentIds: readonly string[],
  exec?: DbExecutor,
): Promise<Map<string, number[]>> {
  const map = new Map<string, number[]>();
  const ids = [...new Set(departmentIds.filter(id => typeof id === 'string' && id.length > 0))];
  if (ids.length === 0) return map;

  const rows = await runQuery<{
    employee_id: string | number;
    department_id: string;
    role_code: string | null;
    is_admin: boolean | null;
  }>(
    exec,
    `SELECT eda.employee_id, eda.department_id, sr.code AS role_code, sr.is_admin
       FROM employee_department_access eda
       JOIN employees e ON e.id = eda.employee_id
       JOIN user_profiles up ON up.employee_id = e.id AND up.is_approved = true
       JOIN system_roles sr ON sr.id = up.system_role_id
      WHERE eda.department_id = ANY($1::uuid[])
        AND ${departmentManagerConditionSql('eda')}
        AND e.is_archived = false
        AND e.employment_status = 'active'
      ORDER BY eda.employee_id`,
    [ids],
  );

  const editableByRole = new Map<string, boolean>();
  for (const row of rows) {
    const roleCode = row.role_code ?? '';
    if (!row.is_admin && !editableByRole.has(roleCode)) {
      editableByRole.set(roleCode, roleCode ? await hasPageEdit(roleCode, TIMESHEET_PAGE_KEY) : false);
    }
    if (!row.is_admin && editableByRole.get(roleCode) !== true) continue;

    const dept = String(row.department_id);
    const list = map.get(dept) ?? [];
    list.push(Number(row.employee_id));
    map.set(dept, list);
  }
  return map;
}
