/**
 * Разбивка таблицы «Текущие сотрудники» на ИТР / Рабочие / Остальные (плашка в шапке, решение 26.11.2026).
 *
 * Правило — по должности, на тех же источниках, что группы «Расчётов» (payroll-department-groups.ts):
 *  1. отдел в бригадах (раздел «Бригады», СУ-10 и СМ) — «Рабочие», какой бы ни была должность;
 *  2. иначе должность ИТР (isItrPositionName — тот же список, что в «Расчётах») — «ИТР»;
 *  3. иначе отдел СМ — «Рабочие» (как в «Расчётах»: в СМ вне бригад делят по должности);
 *  4. остальное — «Остальные»: коменданты, курьеры, операторы, без должности, подрядчики без ИТР-должности.
 *
 * Отдел уволенного — до увольнения (effectiveDepartmentSql), как у фильтра раздела. Должность — текущая в карточке.
 */
import { query } from '../config/postgres.js';
import {
  effectiveDepartmentSql,
  listSectionDepartmentIds,
  type IExportDepartmentRow,
} from './employees-export.service.js';
import { isItrPositionName } from './payroll/payroll-department-groups.js';

export type StaffCategory = 'itr' | 'worker' | 'other';

/** Группы плашки в порядке экрана; значение параметра category (клик по группе, решение 27.11.2026). */
export const STAFF_CATEGORIES: readonly StaffCategory[] = ['itr', 'worker', 'other'];

export const isStaffCategory = (value: unknown): value is StaffCategory =>
  typeof value === 'string' && (STAFF_CATEGORIES as readonly string[]).includes(value);

export interface IStaffCategorySources {
  /** Отделы раздела «Бригады» (СУ-10 и СМ). */
  brigadeDepartmentIds: string[];
  /** Отделы СМ вне бригад. */
  smDepartmentIds: string[];
  /** Должности справочника с ИТР-названием. */
  itrPositionIds: string[];
}

export function buildStaffCategorySources(
  departments: IExportDepartmentRow[],
  positions: ReadonlyArray<{ id: string; name: string | null }>,
): IStaffCategorySources {
  return {
    brigadeDepartmentIds: listSectionDepartmentIds(departments, 'brigades'),
    smDepartmentIds: listSectionDepartmentIds(departments, 'sm'),
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
 * не считался дважды.
 */
export function staffCategoryCaseSql(
  alias: string,
  departmentExpr: string,
  params: unknown[],
  sources: IStaffCategorySources,
): string {
  params.push(sources.brigadeDepartmentIds);
  const brigadeIdx = params.length;
  params.push(sources.itrPositionIds);
  const itrIdx = params.length;
  params.push(sources.smDepartmentIds);
  const smIdx = params.length;
  return `(CASE
            WHEN ${departmentExpr} = ANY($${brigadeIdx}::uuid[]) THEN 'worker'
            WHEN ${alias}.position_id = ANY($${itrIdx}::uuid[]) THEN 'itr'
            WHEN ${departmentExpr} = ANY($${smIdx}::uuid[]) THEN 'worker'
            ELSE 'other'
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
  other: number;
}

/**
 * Счётчики по готовому WHERE фильтра кадров (таблица employees без алиаса — как в списке). Сумма трёх категорий
 * равна total: CASE даёт ровно одну категорию на строку.
 */
export async function countStaffCategories(
  whereParts: string[],
  params: unknown[],
  sources: IStaffCategorySources,
): Promise<IStaffCategoryCounts> {
  const categoryParams = [...params];
  const categorySql = staffCategoryRowSql('employees', categoryParams, sources);
  const where = whereParts.length > 0 ? whereParts.join(' AND ') : 'TRUE';
  const rows = await query<{ total: number | string; itr: number | string; worker: number | string; other: number | string }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE c.category = 'itr')::int AS itr,
            count(*) FILTER (WHERE c.category = 'worker')::int AS worker,
            count(*) FILTER (WHERE c.category = 'other')::int AS other
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
    other: Number(row?.other ?? 0),
  };
}
