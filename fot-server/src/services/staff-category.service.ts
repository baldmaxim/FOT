/**
 * Разбивка таблицы «Текущие сотрудники» на ИТР / Рабочие (плашка в шапке). Решение 27.11.2026: только две группы и
 * то же правило, что у групп «Расчётов» (payrollDepartmentGroupIds, payroll-department-groups.ts) — человек в одной
 * группе на обоих экранах:
 *  1. отдел-бригада (раздел «Бригады», СУ-10 и СМ) — «Рабочие», какой бы ни была должность;
 *  2. ЛИНИЯ и остальные отделы СУ-10 — «ИТР», какой бы ни была должность (курьеры, коменданты, операторы — тоже);
 *  3. иначе (СМ вне бригад, подрядные, прочие, без отдела) — по должности: isItrPositionName — «ИТР», иначе «Рабочие».
 *
 * Отдел уволенного — до увольнения (effectiveDepartmentSql), как у фильтра раздела. Должность — текущая в карточке.
 */
import { query } from '../config/postgres.js';
import { effectiveDepartmentSql, type IExportDepartmentRow } from './employees-export.service.js';
import { isItrPositionName, payrollDepartmentGroupIds } from './payroll/payroll-department-groups.js';

export type StaffCategory = 'itr' | 'worker';

/** Группы плашки в порядке экрана; значение параметра category (клик по группе). */
export const STAFF_CATEGORIES: readonly StaffCategory[] = ['itr', 'worker'];

export const isStaffCategory = (value: unknown): value is StaffCategory =>
  typeof value === 'string' && (STAFF_CATEGORIES as readonly string[]).includes(value);

export interface IStaffCategorySources {
  /** Бригады (раздел «Бригады», СУ-10 и СМ) — «Рабочие» при любой должности. */
  workerDepartmentIds: string[];
  /** ЛИНИЯ и остальные отделы СУ-10 — «ИТР» при любой должности. */
  itrDepartmentIds: string[];
  /** Должности справочника с ИТР-названием — для остальных отделов. */
  itrPositionIds: string[];
}

export function buildStaffCategorySources(
  departments: IExportDepartmentRow[],
  positions: ReadonlyArray<{ id: string; name: string | null }>,
): IStaffCategorySources {
  const groups = payrollDepartmentGroupIds(departments);
  return {
    workerDepartmentIds: groups.worker,
    itrDepartmentIds: groups.itr,
    itrPositionIds: positions.filter(position => isItrPositionName(position.name)).map(position => position.id),
  };
}

/** Отделы (включая неактивные: у уволенного отдел мог закрыться) и должности — на каждый запрос, без кэша. */
export async function loadStaffCategorySources(): Promise<IStaffCategorySources> {
  const [departments, positions] = await Promise.all([
    query<IExportDepartmentRow>('SELECT id, parent_id, name, kind FROM org_departments'),
    query<{ id: string; name: string | null }>('SELECT id, name FROM positions'),
  ]);
  return buildStaffCategorySources(departments, positions);
}

/**
 * Категория строки: CASE над отделом departmentExpr и должностью alias.position_id. Параметры дописываются в params.
 * departmentExpr — колонка с уже посчитанным отделом (см. staffCategoryRowSql), чтобы подзапрос отдела уволенного
 * не считался дважды. Без отдела (NULL) — по должности. Третьей группы нет: ELSE — «Рабочие».
 */
export function staffCategoryCaseSql(
  alias: string,
  departmentExpr: string,
  params: unknown[],
  sources: IStaffCategorySources,
): string {
  params.push(sources.workerDepartmentIds);
  const workerIdx = params.length;
  params.push(sources.itrDepartmentIds);
  const itrDeptIdx = params.length;
  params.push(sources.itrPositionIds);
  const itrPosIdx = params.length;
  return `(CASE
            WHEN ${departmentExpr} = ANY($${workerIdx}::uuid[]) THEN 'worker'
            WHEN ${departmentExpr} = ANY($${itrDeptIdx}::uuid[]) THEN 'itr'
            WHEN ${alias}.position_id = ANY($${itrPosIdx}::uuid[]) THEN 'itr'
            ELSE 'worker'
          END)`;
}

/**
 * Категория строки одним выражением: отдел (у уволенного — до увольнения, effectiveDepartmentSql) считается один раз
 * во вложенном SELECT, дальше — staffCategoryCaseSql. Одно выражение у разбивки и у фильтра таблицы по группе:
 * число на кнопке плашки равно числу строк таблицы.
 */
export function staffCategoryRowSql(alias: string, params: unknown[], sources: IStaffCategorySources): string {
  const caseSql = staffCategoryCaseSql(alias, 'category_dep.department_id', params, sources);
  return `(SELECT ${caseSql} FROM (SELECT ${effectiveDepartmentSql(alias)} AS department_id) category_dep)`;
}

/** Условие «строка в группе category» для WHERE; параметры дописываются в params. */
export function staffCategoryConditionSql(
  alias: string,
  params: unknown[],
  sources: IStaffCategorySources,
  category: StaffCategory,
): string {
  const rowSql = staffCategoryRowSql(alias, params, sources);
  params.push(category);
  return `${rowSql} = $${params.length}`;
}

export interface IStaffCategoryCounts {
  total: number;
  itr: number;
  worker: number;
  /**
   * Всегда 0: группы «Остальные» больше нет. Поле — для фронта прежней версии, пока выкатывается новый
   * (бэкенд → фронтенд); убрать после выкатки.
   */
  other: 0;
}

/**
 * Счётчики по готовому WHERE фильтра кадров (таблица employees без алиаса — как в списке). itr + worker = total:
 * CASE даёт ровно одну группу на строку.
 */
export async function countStaffCategories(
  whereParts: string[],
  params: unknown[],
  sources: IStaffCategorySources,
): Promise<IStaffCategoryCounts> {
  const categoryParams = [...params];
  const categorySql = staffCategoryRowSql('employees', categoryParams, sources);
  const where = whereParts.length > 0 ? whereParts.join(' AND ') : 'TRUE';
  const rows = await query<{ total: number | string; itr: number | string; worker: number | string }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE c.category = 'itr')::int AS itr,
            count(*) FILTER (WHERE c.category = 'worker')::int AS worker
       FROM (
         SELECT ${categorySql} AS category
           FROM employees
          WHERE ${where}
       ) c`,
    categoryParams,
  );
  const row = rows[0];
  return {
    total: Number(row?.total ?? 0),
    itr: Number(row?.itr ?? 0),
    worker: Number(row?.worker ?? 0),
    other: 0,
  };
}
