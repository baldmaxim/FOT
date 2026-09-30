import type { QueryResultRow } from 'pg';
import { query, type DbExecutor } from '../config/postgres.js';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Роль «Заместитель» (миграция 292): сотрудник ведёт табель СВОЕГО отдела
 * (employees.org_department_id) без ручного назначения, а дополнительные отделы получает
 * ручными назначениями уровня 'deputy' (миграция 283).
 *
 * Листовой модуль: импортирует только config/postgres. Его зовут data-scope,
 * department-managers и контроллеры — обратного импорта быть не должно, иначе
 * появляются циклы data-scope ↔ access-control.
 *
 * Правило А — какой отдел засчитывается заместителю:
 *  - отдел активен и не лежит в папке «Уволенные»;
 *  - у отдела нет подотделов ВООБЩЕ (включая неактивные: collectDeptIds и цепочка
 *    loadOwnershipIntervals их не отбрасывают);
 *  - ни у одного отдела выше по дереву нет владельца табеля (ручной full или deputy).
 *
 * Почему так. Подача отдела забирает людей всех его подотделов, а покрытие личной подачи
 * (direct-report-coverage) ищет владельца только в ТОЧНОМ отделе сотрудника. Вложенное
 * владение дало бы пару (сотрудник, дата) сразу в двух подачах. Правило не даёт роли
 * вложенности создать: отдел-лист без владельца выше подаётся ровно одной подачей.
 */

export const DEPUTY_ROLE_CODE = 'deputy_head';

export const isDeputyRole = (roleCode: string | null | undefined): boolean => roleCode === DEPUTY_ROLE_CODE;

/** Защита от циклов в org_departments.parent_id — та же глубина, что у покрытия и замка. */
const MAX_DEPARTMENT_DEPTH = 32;

const UUID_SETTING_PATTERN = '^[0-9a-fA-F-]{8}-[0-9a-fA-F-]{4}-[0-9a-fA-F-]{4}-[0-9a-fA-F-]{4}-[0-9a-fA-F]{12}$';

/** Папка «Уволенные» со всеми потомками — те же CTE, что в direct-report-coverage. */
const ARCHIVE_TREE_CTE = `
  archive_root AS (
    SELECT NULLIF(s.value, '')::uuid AS dept_id
      FROM system_settings s
     WHERE s.key = 'employees_archive_department_id'
       AND s.value ~ '${UUID_SETTING_PATTERN}'
     LIMIT 1
  ),
  archive_tree AS (
    SELECT ar.dept_id AS id, 1 AS depth FROM archive_root ar WHERE ar.dept_id IS NOT NULL
    UNION ALL
    SELECT d.id, t.depth + 1
      FROM archive_tree t
      JOIN org_departments d ON d.parent_id = t.id
     WHERE t.depth < ${MAX_DEPARTMENT_DEPTH}
  )`;

/** Действующий владелец табеля отдела `deptExpr` среди ручных назначений (full/deputy). */
const manualOwnerExistsSql = (deptExpr: string, extraCondition = ''): string => `
  EXISTS (
    SELECT 1
      FROM employee_department_access o
      JOIN employees oe ON oe.id = o.employee_id
       AND oe.is_archived = false AND oe.employment_status = 'active'
      JOIN user_profiles oup ON oup.employee_id = oe.id AND oup.is_approved = true
     WHERE o.department_id = ${deptExpr}
       AND o.is_active = true
       AND o.source <> 'sigur_sync'
       AND o.access_level IN ('full', 'deputy')
       ${extraCondition}
  )`;

export interface IDeputyHeadAssignmentsSqlParams {
  /** Плейсхолдер кода роли, например '$1'. */
  roleParam: string;
  /** Плейсхолдер employee_id (bigint) — отделы одного сотрудника. */
  employeeParam?: string;
  /** Плейсхолдер uuid[] — только эти отделы (владельцы табеля по набору отделов). */
  departmentsParam?: string;
}

/**
 * SELECT (employee_id, department_id) заместительских отделов роли по правилу А.
 *
 * Кандидаты — отдел сотрудника (org_department_id) и его активные ручные назначения
 * 'deputy'. Держатель роли — одобренный профиль активного неархивного сотрудника с
 * активной ролью и неотключённой учётной записью. Самодостаточный подзапрос (WITH внутри):
 * его можно вставить в UNION и в FROM (...) как есть.
 */
export function deputyHeadAssignmentsSql(params: IDeputyHeadAssignmentsSqlParams): string {
  const employeeFilter = params.employeeParam ? `AND e.id = ${params.employeeParam}::bigint` : '';
  const departmentFilter = params.departmentsParam
    ? `WHERE c.department_id = ANY(${params.departmentsParam}::uuid[])`
    : '';
  return `
    WITH RECURSIVE ${ARCHIVE_TREE_CTE},
    holders AS (
      SELECT e.id AS employee_id, e.org_department_id
        FROM employees e
        JOIN user_profiles up ON up.employee_id = e.id AND up.is_approved = true
        JOIN system_roles sr ON sr.id = up.system_role_id
         AND sr.code = ${params.roleParam} AND sr.is_active = true
        LEFT JOIN app_auth.users au ON au.id = up.id
       WHERE e.is_archived = false
         AND e.employment_status = 'active'
         AND COALESCE(au.is_disabled, false) = false
         ${employeeFilter}
    ),
    candidates AS (
      SELECT h.employee_id, h.org_department_id AS department_id
        FROM holders h
       WHERE h.org_department_id IS NOT NULL
      UNION
      SELECT eda.employee_id, eda.department_id
        FROM employee_department_access eda
        JOIN holders h ON h.employee_id = eda.employee_id
       WHERE eda.is_active = true
         AND eda.access_level = 'deputy'
         AND eda.source <> 'sigur_sync'
    ),
    filtered AS (
      SELECT c.employee_id, c.department_id FROM candidates c ${departmentFilter}
    ),
    chain AS (
      SELECT f.department_id AS start_id, d.parent_id AS anc_id, 1 AS depth
        FROM (SELECT DISTINCT department_id FROM filtered) f
        JOIN org_departments d ON d.id = f.department_id
      UNION ALL
      SELECT c.start_id, d.parent_id, c.depth + 1
        FROM chain c
        JOIN org_departments d ON d.id = c.anc_id
       WHERE c.anc_id IS NOT NULL AND c.depth < ${MAX_DEPARTMENT_DEPTH}
    )
    SELECT DISTINCT f.employee_id, f.department_id
      FROM filtered f
      JOIN org_departments d ON d.id = f.department_id AND d.is_active = true
     WHERE NOT EXISTS (SELECT 1 FROM org_departments k WHERE k.parent_id = f.department_id)
       AND NOT EXISTS (SELECT 1 FROM archive_tree t WHERE t.id = f.department_id)
       AND NOT EXISTS (
         SELECT 1 FROM chain c
          WHERE c.start_id = f.department_id
            AND c.anc_id IS NOT NULL
            AND ${manualOwnerExistsSql('c.anc_id')}
       )`;
}

/** SELECT через клиент транзакции, если он передан, иначе через пул. */
async function queryWith<T extends QueryResultRow = QueryResultRow>(
  exec: DbExecutor | undefined, sql: string, params?: readonly unknown[],
): Promise<T[]> {
  if (exec) return (await exec.query<T>(sql, params as unknown[] | undefined)).rows;
  return query<T>(sql, params);
}

/** Заместительские отделы сотрудника с ролью «Заместитель» (правило А). Без роли — []. */
export async function loadDeputyHeadDepartmentIds(employeeId: number, exec?: DbExecutor): Promise<string[]> {
  if (!Number.isInteger(employeeId) || employeeId <= 0) return [];
  const rows = await queryWith<{ department_id: string | null }>(
    exec,
    `SELECT DISTINCT r.department_id::text AS department_id
       FROM (${deputyHeadAssignmentsSql({ roleParam: '$1', employeeParam: '$2' })}) r`,
    [DEPUTY_ROLE_CODE, employeeId],
  );
  return [...new Set(rows.map(row => row.department_id).filter((id): id is string => typeof id === 'string' && id.length > 0))];
}

/**
 * Заместительские отделы текущего пользователя (кэш на время запроса).
 *
 * Роль берётся из токена: её смена поднимает token_version, так что устаревшей она не
 * бывает. Отдел — из БД на каждый запрос, а не из JWT: перевод в Sigur токен не
 * перевыпускает, и старый отдел жил бы до его истечения.
 */
export async function resolveDeputyHeadDepartmentIds(req: AuthenticatedRequest): Promise<string[]> {
  if (req.user.is_admin || !isDeputyRole(req.user.role_code)) return [];
  if (req.user.__deputy_head_department_ids) return req.user.__deputy_head_department_ids;
  const employeeId = req.user.employee_id;
  const ids = employeeId == null ? [] : await loadDeputyHeadDepartmentIds(employeeId);
  req.user.__deputy_head_department_ids = ids;
  return ids;
}

export type TDeputyTopologyReason = 'inactive' | 'has_children' | 'owner_above';

export interface IDeputyTopologyViolation {
  department_id: string;
  department_name: string | null;
  reason: TDeputyTopologyReason;
  /** Для owner_above — ближайший отдел выше, у которого есть владелец табеля. */
  owner_department_name: string | null;
}

interface ITopologyRow extends QueryResultRow {
  department_id: string;
  department_name: string | null;
  is_active: boolean | null;
  in_archive: boolean;
  has_children: boolean;
  owner_department_name: string | null;
}

/**
 * Проверка правила А для НОВЫХ ручных назначений «Заместитель» (для любой роли).
 *
 * finalOwnedDepartmentIds — итоговые full ∪ deputy этого сотрудника после сохранения:
 * «Начальник» родителя и «Заместитель» ребёнка в одном сохранении — тоже вложенность.
 * Собственные текущие строки сотрудника в расчёт «чужих владельцев» не берутся — итоговое
 * состояние их заменяет.
 */
export async function findDeputyTopologyViolations(params: {
  employeeId: number;
  checkDepartmentIds: readonly string[];
  finalOwnedDepartmentIds: readonly string[];
}): Promise<IDeputyTopologyViolation[]> {
  const check = [...new Set(params.checkDepartmentIds.filter(id => typeof id === 'string' && id.length > 0))];
  if (check.length === 0) return [];
  const finalOwned = [...new Set(params.finalOwnedDepartmentIds.filter(id => typeof id === 'string' && id.length > 0))];

  const rows = await query<ITopologyRow>(
    `WITH RECURSIVE ${ARCHIVE_TREE_CTE},
     chk AS (SELECT unnest($1::uuid[]) AS department_id),
     chain AS (
       SELECT c.department_id AS start_id, d.parent_id AS anc_id, 1 AS depth
         FROM chk c
         JOIN org_departments d ON d.id = c.department_id
       UNION ALL
       SELECT ch.start_id, d.parent_id, ch.depth + 1
         FROM chain ch
         JOIN org_departments d ON d.id = ch.anc_id
        WHERE ch.anc_id IS NOT NULL AND ch.depth < ${MAX_DEPARTMENT_DEPTH}
     )
     SELECT c.department_id::text AS department_id,
            d.name AS department_name,
            d.is_active,
            EXISTS (SELECT 1 FROM archive_tree t WHERE t.id = c.department_id) AS in_archive,
            EXISTS (SELECT 1 FROM org_departments k WHERE k.parent_id = c.department_id) AS has_children,
            (SELECT a.name
               FROM chain ch
               JOIN org_departments a ON a.id = ch.anc_id
              WHERE ch.start_id = c.department_id
                AND ch.anc_id IS NOT NULL
                AND (
                  ${manualOwnerExistsSql('ch.anc_id', 'AND o.employee_id <> $2::bigint')}
                  OR ch.anc_id = ANY($3::uuid[])
                )
              ORDER BY ch.depth
              LIMIT 1) AS owner_department_name
       FROM chk c
       LEFT JOIN org_departments d ON d.id = c.department_id`,
    [check, params.employeeId, finalOwned],
  );

  const violations: IDeputyTopologyViolation[] = [];
  for (const row of rows) {
    const base = {
      department_id: String(row.department_id),
      department_name: row.department_name ?? null,
      owner_department_name: null,
    };
    if (row.is_active !== true || row.in_archive) {
      violations.push({ ...base, reason: 'inactive' });
    } else if (row.has_children) {
      violations.push({ ...base, reason: 'has_children' });
    } else if (row.owner_department_name) {
      violations.push({ ...base, reason: 'owner_above', owner_department_name: row.owner_department_name });
    }
  }
  return violations;
}

/** Понятный текст 409 для админки: тост показывает поле error как есть. */
export function formatDeputyTopologyError(violations: readonly IDeputyTopologyViolation[]): string {
  const parts = violations.map((v) => {
    const name = v.department_name ? `«${v.department_name}»` : v.department_id;
    if (v.reason === 'has_children') return `${name} — есть подотделы`;
    if (v.reason === 'owner_above') {
      return `${name} — выше уже есть владелец табеля${v.owner_department_name ? ` («${v.owner_department_name}»)` : ''}`;
    }
    return `${name} — отдел неактивен`;
  });
  return `Заместителем можно назначить только на отдел без подотделов и без начальника или заместителя выше по дереву: ${parts.join('; ')}`;
}
