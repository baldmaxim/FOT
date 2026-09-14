/**
 * Резолв «каких сотрудников видит пользователь» БЕЗ фильтров экрана.
 *
 * Буквальный перенос ветвления из employees.controller.getAll (ветка, где
 * department_id в query не задан). Вынесено отдельно, чтобы выгрузка в xlsx
 * имела ровно тот же охват, что и список на «Управлении кадрами».
 *
 * ВАЖНО: getAll пока продолжает использовать собственную копию логики —
 * переключение его на этот сервис запланировано отдельным шагом.
 */
import { query } from '../config/postgres.js';
import {
  hasGlobalDepartmentReadScope,
  resolveManagedDepartmentIds,
  resolveRequestDataScopeWithDirectReports,
  resolveScopedDepartmentId,
} from './data-scope.service.js';
import { listExplicitDepartmentIdsForUser } from './department-access.service.js';
import { listDirectSubordinates } from './employee-direct-reports.service.js';
import { collectDeptIds } from './skud-shared.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

export type EmployeeScopeMode = 'all' | 'departments' | 'employees' | 'self' | 'none';

export interface IEmployeeScopeFilter {
  mode: EmployeeScopeMode;
  /** Отделы скоупа (уже раскрытое поддерево). Пусто для 'all' / 'employees' / 'self'. */
  departmentIds: string[];
  /**
   * Прямые подчинённые и — только если у пользователя есть explicit-назначения
   * ИЛИ прямые подчинённые — он сам. Безусловно себя не добавляем: это условие
   * из getAll, и без него табельщица/руководитель без назначений увидит лишнее.
   */
  directEmployeeIds: number[];
  /** Свой employee_id для mode='self'. */
  selfEmployeeId: number | null;
}

/** ID отдела + всё его поддерево (тело resolveDepartmentFilterIds из getAll). */
async function resolveDepartmentFilterIds(departmentId: string | null): Promise<string[] | null> {
  if (!departmentId) return null;
  const ids = await collectDeptIds(departmentId);
  return ids.length > 0 ? ids : [departmentId];
}

export async function resolveEmployeeListScopeFilter(
  req: AuthenticatedRequest,
): Promise<IEmployeeScopeFilter> {
  // resolveRequestDataScopeWithDirectReports по типу никогда не отдаёт null,
  // поэтому ветки «scope не настроен → 403» здесь нет (в getAll она мёртвая).
  const scope = await resolveRequestDataScopeWithDirectReports(req);
  const departmentId = await resolveScopedDepartmentId(req, null);

  const managedDepartmentIds = scope === 'department'
    ? await resolveManagedDepartmentIds(req)
    : [];
  const departmentFilterIds = managedDepartmentIds.length > 0
    ? managedDepartmentIds
    : await resolveDepartmentFilterIds(departmentId);

  let selfEmployeeIdToInclude: number | null = null;
  let directReportIds: number[] = [];
  if (scope === 'department' && req.user.employee_id) {
    const explicitDeptIds = await listExplicitDepartmentIdsForUser(
      req.user.id,
      req.user.employee_id,
    );
    directReportIds = await listDirectSubordinates(req.user.employee_id);
    if (explicitDeptIds.length > 0 || directReportIds.length > 0) {
      selfEmployeeIdToInclude = req.user.employee_id;
    }
  }
  const directEmployeeIds = [...new Set([
    ...directReportIds,
    ...(selfEmployeeIdToInclude != null ? [selfEmployeeIdToInclude] : []),
  ])];

  if (scope === 'self') {
    return req.user.employee_id
      ? { mode: 'self', departmentIds: [], directEmployeeIds: [], selfEmployeeId: req.user.employee_id }
      : { mode: 'none', departmentIds: [], directEmployeeIds: [], selfEmployeeId: null };
  }

  if (departmentFilterIds?.length) {
    return { mode: 'departments', departmentIds: departmentFilterIds, directEmployeeIds, selfEmployeeId: null };
  }

  if (directEmployeeIds.length > 0) {
    return { mode: 'employees', departmentIds: [], directEmployeeIds, selfEmployeeId: null };
  }

  if (scope === 'department') {
    // Нет ни отделов, ни назначений — НЕ отдаём всю таблицу (инвариант getAll).
    return { mode: 'none', departmentIds: [], directEmployeeIds: [], selfEmployeeId: null };
  }

  return { mode: 'all', departmentIds: [], directEmployeeIds: [], selfEmployeeId: null };
}

/**
 * Скоуп ЧТЕНИЯ списка сотрудников. Флаг роли view_all_departments («Просмотр всех
 * табелей и проходов») открывает всю организацию на чтение — только здесь, а не в
 * resolveAccessibleDepartmentIds: тот скоуп решает и запись (canAccessEmployeeInScope
 * в увольнении, правке карточки, документах). globalRead=true — фильтр отдела берётся
 * из запроса как есть, без сужения до назначенных отделов.
 */
export async function resolveEmployeeListReadScope(
  req: AuthenticatedRequest,
): Promise<{ scope: Awaited<ReturnType<typeof resolveRequestDataScopeWithDirectReports>>; globalRead: boolean }> {
  const scope = await resolveRequestDataScopeWithDirectReports(req);
  if (scope !== 'all' && await hasGlobalDepartmentReadScope(req)) {
    return { scope: 'all', globalRead: true };
  }
  return { scope, globalRead: false };
}

/**
 * Какие из переданных сотрудников пользователь ВИДИТ в «Управлении кадрами».
 * Тот же охват, что у списка (getAll): глобальное чтение по view_all_departments,
 * иначе отделы скоупа + прямые подчинённые. Несуществующие id не возвращаются.
 *
 * ТОЛЬКО для чтения. Права на запись решает canAccessEmployeeInScope — флаг
 * view_all_departments запись не расширяет.
 */
export async function filterEmployeeIdsByReadScope(
  req: AuthenticatedRequest,
  employeeIds: readonly number[],
): Promise<number[]> {
  const ids = [...new Set(employeeIds.filter(id => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return [];

  const { globalRead } = await resolveEmployeeListReadScope(req);
  const filter: IEmployeeScopeFilter = globalRead
    ? { mode: 'all', departmentIds: [], directEmployeeIds: [], selfEmployeeId: null }
    : await resolveEmployeeListScopeFilter(req);
  if (filter.mode === 'none') return [];

  const params: unknown[] = [ids];
  let condition = 'TRUE';
  if (filter.mode === 'self') {
    params.push(filter.selfEmployeeId);
    condition = `id = $${params.length}::int`;
  } else if (filter.mode === 'departments') {
    params.push(filter.departmentIds);
    const deptIdx = params.length;
    params.push(filter.directEmployeeIds);
    condition = `(org_department_id = ANY($${deptIdx}::uuid[]) OR id = ANY($${params.length}::int[]))`;
  } else if (filter.mode === 'employees') {
    params.push(filter.directEmployeeIds);
    condition = `id = ANY($${params.length}::int[])`;
  }

  const rows = await query<{ id: number | string }>(
    `SELECT id FROM employees WHERE id = ANY($1::int[]) AND (${condition})`,
    params,
  );
  return rows.map(row => Number(row.id)).filter(id => Number.isInteger(id));
}
