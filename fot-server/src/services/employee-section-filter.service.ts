/**
 * Фильтр «Раздел» в «Управлении кадрами» (СМ / СУ-10 / Бригады / Подрядчики / Все).
 *
 * Раздел сотрудника считается ровно как лист Excel-выгрузки: отдел для раздела — текущий,
 * у уволенного — из последнего события увольнения (effectiveDepartmentSql), классификация
 * отделов — createDepartmentPlacer, а прямой подчинённый вне отделов скоупа попадает в
 * «Прочие» (buildInDepartmentScopeOnlySql). Права доступа списка этот фильтр не расширяет:
 * он добавляется к существующим условиям через AND.
 */
import type { AuthenticatedRequest } from '../types/index.js';
import {
  buildInDepartmentScopeOnlySql,
  effectiveDepartmentSql,
  isFilterableSectionKey,
  listSectionDepartmentIds,
  loadExportDepartments,
  type ExportSectionKey,
} from './employees-export.service.js';
import { resolveEmployeeListScopeFilter, type IEmployeeScopeFilter } from './employee-scope-filter.service.js';

export const ALL_SECTIONS_VALUE = 'all';

export type SectionParamResult =
  | { ok: true; section: ExportSectionKey | null }
  | { ok: false };

/** Нет параметра или «all» — без фильтра; известный раздел — фильтр; иное — ошибка. */
export function parseSectionParam(value: unknown): SectionParamResult {
  if (value === undefined || value === '' || value === ALL_SECTIONS_VALUE) return { ok: true, section: null };
  if (isFilterableSectionKey(value)) return { ok: true, section: value };
  return { ok: false };
}

export interface ISectionFilterContext {
  departmentIds: string[];
  scope: IEmployeeScopeFilter;
}

const GLOBAL_SCOPE: IEmployeeScopeFilter = { mode: 'all', departmentIds: [], directEmployeeIds: [], selfEmployeeId: null };

/** Отделы раздела и скоуп пользователя (тот же, что у filterEmployeeIdsByReadScope). */
export async function resolveSectionFilterContext(
  req: AuthenticatedRequest,
  section: ExportSectionKey,
  globalRead: boolean,
): Promise<ISectionFilterContext> {
  const [departments, scope] = await Promise.all([
    loadExportDepartments(),
    globalRead ? Promise.resolve(GLOBAL_SCOPE) : resolveEmployeeListScopeFilter(req),
  ]);
  return { departmentIds: listSectionDepartmentIds(departments, section), scope };
}

/**
 * Условие раздела для WHERE. employeeAlias — алиас (или имя) таблицы employees.
 * Раздел без отделов — FALSE (пустой результат, а не «без фильтра»).
 */
export function buildSectionConditionSql(
  context: ISectionFilterContext,
  employeeAlias: string,
  params: unknown[],
): string {
  if (context.departmentIds.length === 0) return 'FALSE';
  const effectiveDepartment = effectiveDepartmentSql(employeeAlias);
  params.push(context.departmentIds);
  const inSection = `${effectiveDepartment} = ANY($${params.length}::uuid[])`;
  const inDepartmentScope = buildInDepartmentScopeOnlySql(context.scope, effectiveDepartment, params);
  return `(${inSection} AND ${inDepartmentScope})`;
}
