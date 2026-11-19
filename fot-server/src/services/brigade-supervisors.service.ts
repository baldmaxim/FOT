/**
 * Начальники участка бригад (site_supervisor): ручная full-привязка employee_department_access к бригаде
 * (source <> 'sigur_sync'). Одно правило для строки «Начальник участка» в табеле, исключения из дележа бригады,
 * 1С-экспортов и доступа начальника к «Зарплате по объектам» своих бригад. Истории связей нет — текущее состояние.
 */
import { query, type DbExecutor } from '../config/postgres.js';
import { departmentManagerConditionSql } from './department-managers.service.js';

/**
 * Активные начальники участка (site_supervisor), закреплённые за бригадой через
 * ручную привязку employee_department_access (source <> 'sigur_sync'). Упорядочены
 * по ФИО. Вызывающий гарантирует, что departmentId — бригада (kind не проверяется).
 */
export async function queryBrigadeSupervisorRows(
  departmentId: string,
): Promise<Array<{ id: number; full_name: string }>> {
  const rows = await query<{ id: number; full_name: string | null }>(
    `SELECT DISTINCT e.id, e.full_name
       FROM employee_department_access eda
       INNER JOIN employees e        ON e.id = eda.employee_id
       INNER JOIN org_departments od ON od.id = eda.department_id
       INNER JOIN user_profiles up   ON up.employee_id = e.id
       INNER JOIN system_roles sr    ON sr.id = up.system_role_id
      WHERE eda.department_id = $1
        AND ${departmentManagerConditionSql('eda')}
        AND e.employment_status = 'active'
        AND e.is_archived = false
        AND od.is_active = true
        AND sr.code = 'site_supervisor'
      ORDER BY e.full_name`,
    [departmentId],
  );
  return rows
    .filter(row => Number.isFinite(Number(row.id)))
    .map(row => ({ id: Number(row.id), full_name: String(row.full_name ?? '').trim() }));
}

/**
 * ID начальников участка бригады для строки «Начальник участка» в сетке табеля.
 * Для не-бригад (и несуществующих отделов) возвращает []. Единый источник правды
 * с шапкой табеля (getDepartmentSupervisor).
 */
export async function listBrigadeSupervisorEmployeeIds(departmentId: string): Promise<number[]> {
  const dept = await query<{ kind: string | null }>(
    `SELECT kind FROM org_departments WHERE id = $1`,
    [departmentId],
  );
  if (dept.length === 0 || (dept[0].kind ?? 'department') !== 'brigade') return [];
  const rows = await queryBrigadeSupervisorRows(departmentId);
  return rows.map(row => row.id);
}

/**
 * Bulk-версия listBrigadeSupervisorEmployeeIds: начальники участков всех бригад
 * списка одним запросом (не-бригады отсекаются по od.kind). Для 1С-экспортов —
 * exemptEmployeeIds фильтра «пустых»: строка начальника не должна выпадать,
 * даже если сам он не проходил по СКУДу.
 */
export async function listBrigadeSupervisorEmployeeIdsForDepartments(
  departmentIds: string[],
  exec?: DbExecutor,
): Promise<Set<number>> {
  if (departmentIds.length === 0) return new Set();
  const rows: Array<{ id: number }> = exec
    ? (await exec.query<{ id: number }>(SUPERVISOR_IDS_SQL, [departmentIds])).rows
    : await query<{ id: number }>(SUPERVISOR_IDS_SQL, [departmentIds]);
  return new Set(rows.map(row => Number(row.id)).filter(Number.isFinite));
}

/**
 * Начальники участка по бригадам ($1 — бригады): одна раскладка на много бригад («Свод», «Расчёты» — состав бригад
 * месяца). Пустой Set у каждой запрошенной бригады без начальника; начальник двух бригад — в обеих. Условие —
 * общее с listBrigadeSupervisorEmployeeIdsForDepartments (SUPERVISOR_FROM_WHERE_SQL).
 */
export async function listBrigadeSupervisorsByDepartment(
  departmentIds: readonly string[],
  exec?: DbExecutor,
): Promise<Map<string, Set<number>>> {
  const ids = [...new Set(departmentIds)];
  const result = new Map<string, Set<number>>(ids.map(id => [id, new Set()]));
  if (ids.length === 0) return result;
  const sql = `SELECT DISTINCT eda.department_id::text AS department_id, e.id ${SUPERVISOR_FROM_WHERE_SQL}`;
  const rows: Array<{ department_id: string; id: number }> = exec
    ? (await exec.query<{ department_id: string; id: number }>(sql, [ids])).rows
    : await query<{ department_id: string; id: number }>(sql, [ids]);
  // БД отдаёт uuid в нижнем регистре — ключ результата всё равно переданный id, как бы он ни был записан.
  const requested = new Map(ids.map(id => [id.toLowerCase(), id]));
  for (const row of rows) {
    const id = Number(row.id);
    const key = requested.get(row.department_id.toLowerCase());
    if (Number.isFinite(id) && key !== undefined) result.get(key)!.add(id);
  }
  return result;
}

/** Экспортируется только для теста инварианта «начальник участка = full-назначение». */
export const SUPERVISOR_IDS_SQL_FOR_TESTS = (): string => SUPERVISOR_IDS_SQL;

/** Кто начальник участка бригад $1 — общее условие union-списка и раскладки по бригадам. */
const SUPERVISOR_FROM_WHERE_SQL = `FROM employee_department_access eda
       INNER JOIN employees e        ON e.id = eda.employee_id
       INNER JOIN org_departments od ON od.id = eda.department_id
       INNER JOIN user_profiles up   ON up.employee_id = e.id
       INNER JOIN system_roles sr    ON sr.id = up.system_role_id
      WHERE eda.department_id = ANY($1::uuid[])
        AND od.kind = 'brigade'
        AND ${departmentManagerConditionSql('eda')}
        AND e.employment_status = 'active'
        AND e.is_archived = false
        AND od.is_active = true
        AND sr.code = 'site_supervisor'`;

const SUPERVISOR_IDS_SQL = `SELECT DISTINCT e.id
       ${SUPERVISOR_FROM_WHERE_SQL}`;

/**
 * Бригады, где сотрудник сейчас начальник участка (то же правило, что SUPERVISOR_FROM_WHERE_SQL, с другой стороны):
 * для доступа начальника к «Зарплате по объектам» своих бригад.
 */
export async function listSupervisedBrigadeIds(employeeId: number, exec?: DbExecutor): Promise<string[]> {
  const rows: Array<{ department_id: string }> = exec
    ? (await exec.query<{ department_id: string }>(SUPERVISED_BRIGADES_SQL, [employeeId])).rows
    : await query<{ department_id: string }>(SUPERVISED_BRIGADES_SQL, [employeeId]);
  return rows.map(row => String(row.department_id));
}

const SUPERVISED_BRIGADES_SQL = `SELECT DISTINCT eda.department_id::text AS department_id
       FROM employee_department_access eda
       INNER JOIN employees e        ON e.id = eda.employee_id
       INNER JOIN org_departments od ON od.id = eda.department_id
       INNER JOIN user_profiles up   ON up.employee_id = e.id
       INNER JOIN system_roles sr    ON sr.id = up.system_role_id
      WHERE eda.employee_id = $1
        AND od.kind = 'brigade'
        AND ${departmentManagerConditionSql('eda')}
        AND e.employment_status = 'active'
        AND e.is_archived = false
        AND od.is_active = true
        AND sr.code = 'site_supervisor'
      ORDER BY 1`;
