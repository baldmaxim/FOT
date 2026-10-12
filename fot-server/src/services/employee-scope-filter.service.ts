/**
 * Скоуп ЧТЕНИЯ «Управления кадрами»: каких сотрудников пользователь видит в списке и кого
 * может открыть «как в списке» (карточка табельщицы, «Реквизиты», HR-документы, столбцы
 * «Объект» и «График»).
 *
 * - resolveEmployeeListScopeFilter — базовый охват по назначенным отделам и прямым
 *   подчинённым (ветвление исторически взято из employees.controller.getAll; сам getAll
 *   в legacy-режиме держит собственную копию). Его напрямую берёт старая выгрузка
 *   /employees/export — она глобальным чтением не расширяется.
 * - resolveEmployeeListReadScope — тот же охват плюс глобальное чтение: флаг роли
 *   view_all_departments и точечное право «Управление кадрами — все сотрудники»
 *   (read-scope-grants.service, только роль «Табельщица»).
 *
 * Только чтение: запись решают canAccessEmployeeInScope / canWriteEmployeeInScope.
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
import { hasStaffAllEmployeesGrant } from './read-scope-grants.service.js';
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
 *
 * Так же действует право «Управление кадрами — все сотрудники» (табельщица). staffGrant: false
 * отключает его для вызовов вне экрана кадров — общий список GET /employees без page
 * (фильтр «Чеков за патент») остаётся в пределах бригад.
 */
export async function resolveEmployeeListReadScope(
  req: AuthenticatedRequest,
  options: { staffGrant?: boolean } = {},
): Promise<{ scope: Awaited<ReturnType<typeof resolveRequestDataScopeWithDirectReports>>; globalRead: boolean }> {
  const { staffGrant = true } = options;
  const scope = await resolveRequestDataScopeWithDirectReports(req);
  if (scope === 'all') return { scope, globalRead: false };
  if (await hasGlobalDepartmentReadScope(req) || (staffGrant && await hasStaffAllEmployeesGrant(req))) {
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

  const filter = await resolveStaffListFilter(req);
  if (filter.mode === 'none') return [];

  const params: unknown[] = [ids];
  const condition = buildStaffListCondition(filter, params);
  const rows = await query<{ id: number | string }>(
    `SELECT id FROM employees WHERE id = ANY($1::int[]) AND (${condition})`,
    params,
  );
  return rows.map(row => Number(row.id)).filter(id => Number.isInteger(id));
}

/** Фильтр списка «Управления кадрами» с учётом глобального чтения (флаг роли или право «все сотрудники»). */
async function resolveStaffListFilter(req: AuthenticatedRequest): Promise<IEmployeeScopeFilter> {
  const { globalRead } = await resolveEmployeeListReadScope(req);
  return globalRead
    ? { mode: 'all', departmentIds: [], directEmployeeIds: [], selfEmployeeId: null }
    : resolveEmployeeListScopeFilter(req);
}

/**
 * SQL-условие охвата списка. Одно на проверку «видит ли сотрудника» и на выборку всех
 * видимых — чтобы они не разошлись. Статус и архив не учитываются: это правило по отделу,
 * ровно то, что список отдаёт с фильтрами «Уволенные» и «Архив».
 */
function buildStaffListCondition(filter: IEmployeeScopeFilter, params: unknown[]): string {
  if (filter.mode === 'self') {
    params.push(filter.selfEmployeeId);
    return `id = $${params.length}::int`;
  }
  if (filter.mode === 'departments') {
    params.push(filter.departmentIds);
    const deptIdx = params.length;
    params.push(filter.directEmployeeIds);
    return `(org_department_id = ANY($${deptIdx}::uuid[]) OR id = ANY($${params.length}::int[]))`;
  }
  if (filter.mode === 'employees') {
    params.push(filter.directEmployeeIds);
    return `id = ANY($${params.length}::int[])`;
  }
  return 'TRUE';
}

/** Виден ли сотрудник в списке «Управления кадрами» этого пользователя. Только чтение. */
export async function canSeeEmployeeInStaffList(
  req: AuthenticatedRequest,
  employeeId: number,
): Promise<boolean> {
  return (await filterEmployeeIdsByReadScope(req, [employeeId])).length === 1;
}

/**
 * Все сотрудники, видимые в списке «Управления кадрами»; 'all' — без ограничений.
 * Нужен реестрам, где скоуп задаётся набором id (реквизиты, поиск): общий
 * resolveAccessibleEmployeeIds шире списка — табельщице он добавляет всех, кто проходит
 * на её объекты, включая людей вне её папок.
 */
export async function resolveStaffRosterEmployeeIds(
  req: AuthenticatedRequest,
): Promise<Set<number> | 'all'> {
  const filter = await resolveStaffListFilter(req);
  if (filter.mode === 'all') return 'all';
  if (filter.mode === 'none') return new Set();

  const params: unknown[] = [];
  const condition = buildStaffListCondition(filter, params);
  const rows = await query<{ id: number | string }>(
    `SELECT id FROM employees WHERE ${condition}`,
    params,
  );
  return new Set(rows.map(row => Number(row.id)).filter(id => Number.isInteger(id)));
}
