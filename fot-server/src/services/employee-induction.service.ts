// Вводный инструктаж собственных сотрудников (вкладка «Управление кадрами → Вводный
// инструктаж»). Реестр — таблица employee_inductions (миграция 231): одна актуальная
// дата на сотрудника, снятие даты = DELETE.
//
// Скоуп вкладки фиксирован ветками своих компаний (СУ-10 + Служба Механизации) —
// подрядчики сюда не попадают, у них свой реестр (contractor_inducted_persons).

import type { PoolClient } from 'pg';
import { query, withTransaction } from '../config/postgres.js';
import { escapeLike } from '../utils/search.utils.js';
import { resolveAccessibleDepartmentIds } from './data-scope.service.js';
import { SU10_ROOT_ID } from './patent-missing-receipts.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

/** Корень «(СМ) Служба Механизации» в org_departments. */
export const SM_ROOT_ID = '6c4a3726-4ba9-4550-9978-c5ff50e4f77b';

/**
 * Компании, чьи сотрудники ведутся во вкладке. Добавить компанию = добавить id сюда.
 * Подрядные организации намеренно вне списка.
 */
export const INDUCTION_ROOT_IDS = [SU10_ROOT_ID, SM_ROOT_ID];

/**
 * Роли, которым вкладка отдаёт ВЕСЬ охват веток независимо от назначенных отделов.
 * Право на страницу (`role_page_access`) сюда сознательно не участвует: доступ к
 * странице не должен молча расширять область данных, иначе будущий грант
 * `/staff-control/induction` любой роли выдал бы ей всех сотрудников компаний.
 */
const INDUCTION_FULL_SCOPE_ROLES = new Set<string>(['otitb']);

export type InductionStatusFilter = 'all' | 'missing' | 'passed';

export interface IInductionRow {
  employee_id: number;
  full_name: string | null;
  department_name: string | null;
  position_name: string | null;
  inducted_on: string | null;
}

export interface IInductionDepartment {
  id: string;
  name: string;
}

export interface IInductionListParams {
  scopeIds: string[];
  departmentId?: string | null;
  search?: string | null;
  status?: InductionStatusFilter;
  page: number;
  pageSize: number;
}

export interface IInductionListResult {
  rows: IInductionRow[];
  total: number;
  passed: number;
}

export type SetInductionResult =
  | { found: false }
  | { found: true; changed: boolean; previous: string | null; current: string | null };

/** Плоский список id поддерева (включая сами корни). */
const descendantIds = async (rootIds: string[]): Promise<string[]> => {
  if (rootIds.length === 0) return [];
  const rows = await query<{ id: string }>(
    'SELECT id FROM public.get_descendant_department_ids($1::uuid[])',
    [rootIds],
  );
  return rows.map(r => r.id);
};

/**
 * Отделы, доступные пользователю во вкладке. Единственный источник скоупа —
 * список, селектор отделов и запись обязаны ходить через него.
 *
 * Полный охват веток получает только роль из INDUCTION_FULL_SCOPE_ROLES либо
 * пользователь с data-scope 'all' (системный админ, кадровая служба). Всем
 * остальным — пересечение веток с их отделами: админ компании со скоупом
 * (user_company_access) не должен видеть чужие ветки, а руководитель — чужие отделы.
 *
 * Проверять здесь page-access нельзя: resolveEffectivePageAccess возвращает true
 * любому is_admin, и админ компании получил бы обе ветки мимо своего скоупа.
 */
export const resolveInductionScopeIds = async (req: AuthenticatedRequest): Promise<string[]> => {
  const branch = await descendantIds(INDUCTION_ROOT_IDS);
  if (branch.length === 0) return [];

  const accessible = await resolveAccessibleDepartmentIds(req);
  if (accessible === 'all' || INDUCTION_FULL_SCOPE_ROLES.has(req.user.role_code)) {
    return branch;
  }

  const allowed = new Set(accessible);
  return branch.filter(id => allowed.has(id));
};

/** Отделы селектора — только из переданного скоупа, отсортированы по имени. */
export const listInductionDepartments = async (scopeIds: string[]): Promise<IInductionDepartment[]> => {
  if (scopeIds.length === 0) return [];
  return query<IInductionDepartment>(
    `SELECT od.id, od.name
       FROM org_departments od
      WHERE od.is_active = true
        AND od.id = ANY($1::uuid[])
        AND od.id <> ALL($2::uuid[])
      ORDER BY od.name`,
    [scopeIds, INDUCTION_ROOT_IDS],
  );
};

interface IWhereParts {
  sql: string;
  values: unknown[];
}

/**
 * Общий фильтр списка и счётчиков. Один построитель на оба запроса — иначе таблица
 * и «Пройдено X из Y» разъедутся при следующей правке фильтров. Статус применяется
 * отдельно (счётчики его не учитывают).
 */
const buildWhere = (
  params: Omit<IInductionListParams, 'page' | 'pageSize'>,
  opts: { withStatus: boolean },
): IWhereParts => {
  const values: unknown[] = [];
  const parts: string[] = [
    'e.is_archived = false',
    `e.employment_status <> 'fired'`,
  ];

  values.push(params.scopeIds);
  parts.push(`e.org_department_id = ANY($${values.length}::uuid[])`);

  if (params.departmentId) {
    values.push(params.departmentId);
    parts.push(
      `e.org_department_id IN (SELECT id FROM public.get_descendant_department_ids(ARRAY[$${values.length}]::uuid[]))`,
    );
  }

  const search = (params.search ?? '').trim();
  if (search) {
    values.push(`%${escapeLike(search)}%`);
    parts.push(`e.full_name ILIKE $${values.length}`);
  }

  if (opts.withStatus) {
    if (params.status === 'missing') parts.push('i.employee_id IS NULL');
    else if (params.status === 'passed') parts.push('i.employee_id IS NOT NULL');
  }

  return { sql: parts.join(' AND '), values };
};

export const listInduction = async (params: IInductionListParams): Promise<IInductionListResult> => {
  if (params.scopeIds.length === 0) {
    return { rows: [], total: 0, passed: 0 };
  }

  const listWhere = buildWhere(params, { withStatus: true });
  const listValues = [...listWhere.values, params.pageSize, (params.page - 1) * params.pageSize];

  // Дата отдаётся строкой YYYY-MM-DD (to_char не зависит от DateStyle).
  const rowsPromise = query<IInductionRow>(
    `SELECT e.id AS employee_id,
            e.full_name,
            od.name AS department_name,
            p.name  AS position_name,
            to_char(i.inducted_on, 'YYYY-MM-DD') AS inducted_on
       FROM employees e
       LEFT JOIN org_departments od ON od.id = e.org_department_id
       LEFT JOIN positions p ON p.id = e.position_id
       LEFT JOIN employee_inductions i ON i.employee_id = e.id
      WHERE ${listWhere.sql}
      ORDER BY od.name NULLS LAST, e.full_name
      LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`,
    listValues,
  );

  // Счётчики — те же условия без фильтра статуса. count(*) в PG это bigint,
  // приводим к int, иначе pg отдаёт строку и ломается арифметика пагинации.
  const countWhere = buildWhere(params, { withStatus: false });
  const countsPromise = query<{ total: number; passed: number }>(
    `SELECT count(*)::int AS total,
            count(i.employee_id)::int AS passed
       FROM employees e
       LEFT JOIN employee_inductions i ON i.employee_id = e.id
      WHERE ${countWhere.sql}`,
    countWhere.values,
  );

  const [rows, counts] = await Promise.all([rowsPromise, countsPromise]);
  return {
    rows,
    total: Number(counts[0]?.total ?? 0),
    passed: Number(counts[0]?.passed ?? 0),
  };
};

/**
 * Установка/снятие даты. Атомарно: сотрудник блокируется FOR UPDATE, поэтому два
 * одновременных PATCH не запишут в аудит неверный previous.
 *
 * Условия выборки сотрудника совпадают со списком (не архивный, не уволенный,
 * в скоупе) — иначе прямым запросом к API можно было бы проставить инструктаж
 * тому, кого во вкладке не видно.
 */
export const setInduction = async (input: {
  employeeId: number;
  inductedOn: string | null;
  userId: string;
  scopeIds: string[];
}): Promise<SetInductionResult> => {
  const { employeeId, inductedOn, userId, scopeIds } = input;
  if (scopeIds.length === 0) return { found: false };

  return withTransaction(async (client: PoolClient) => {
    const target = await client.query<{ id: number }>(
      `SELECT e.id
         FROM employees e
        WHERE e.id = $1
          AND e.org_department_id = ANY($2::uuid[])
          AND e.is_archived = false
          AND e.employment_status <> 'fired'
        FOR UPDATE`,
      [employeeId, scopeIds],
    );
    if (target.rows.length === 0) return { found: false };

    const prev = await client.query<{ inducted_on: string }>(
      `SELECT to_char(inducted_on, 'YYYY-MM-DD') AS inducted_on
         FROM employee_inductions
        WHERE employee_id = $1
        FOR UPDATE`,
      [employeeId],
    );
    const previous = prev.rows[0]?.inducted_on ?? null;

    // Значение не меняется — ничего не пишем: иначе повтор той же даты перетирал бы
    // updated_by/updated_at «правкой», которой не было. Покрывает и очистку пустого.
    if (previous === inductedOn) {
      return { found: true, changed: false, previous, current: previous };
    }

    if (inductedOn === null) {
      await client.query('DELETE FROM employee_inductions WHERE employee_id = $1', [employeeId]);
    } else {
      await client.query(
        `INSERT INTO employee_inductions (employee_id, inducted_on, updated_by, updated_at)
         VALUES ($1, $2::date, $3::uuid, now())
         ON CONFLICT (employee_id) DO UPDATE
            SET inducted_on = EXCLUDED.inducted_on,
                updated_by  = EXCLUDED.updated_by,
                updated_at  = now()`,
        [employeeId, inductedOn, userId],
      );
    }

    return { found: true, changed: true, previous, current: inductedOn };
  });
};
