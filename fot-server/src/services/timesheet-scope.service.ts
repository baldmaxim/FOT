import type { AuthenticatedRequest } from '../types/index.js';
import type { DataScope } from '../config/access-control.js';
import { hasPageEdit, hasPageView } from './access-control.service.js';
import {
  hasObjectViewScope,
  resolveAccessibleDepartmentIds,
  resolveAccessibleEmployeeIds,
  resolveEditableDepartmentIds,
  resolveEffectiveDirectSubordinates,
  resolveManagedDepartmentIds,
  resolveScopedDepartmentId,
} from './data-scope.service.js';
import { isTimekeeper, resolveTimekeeperEditableLiIds, LI_OBSHESTROY_DEPARTMENT_ID } from './timekeeper-scope.service.js';
import { listEmployeeIdsAssignedToDepartmentPeriod } from './timesheet-department-assignments.service.js';

/**
 * Скоуп табеля. Вынесено из timesheet.controller.ts, чтобы экспортные контроллеры
 * не импортировали контроллер (циклы ESM). Контроллер реэкспортирует эти функции.
 */

export const MANAGED_TIMESHEET_PAGE_KEYS = ['/timesheet', '/timesheet-hr'] as const;

export async function hasManagedTimesheetAccess(
  req: AuthenticatedRequest,
  action: 'view' | 'edit',
): Promise<boolean> {
  const checker = action === 'edit' ? hasPageEdit : hasPageView;
  const checks = await Promise.all(MANAGED_TIMESHEET_PAGE_KEYS.map(pageKey => checker(req.user.role_code, pageKey)));
  return checks.some(Boolean);
}

export async function resolveTimesheetScope(req: AuthenticatedRequest): Promise<DataScope | null> {
  if (req.user.is_admin) {
    const accessible = await resolveAccessibleDepartmentIds(req);
    if (accessible === 'all') return 'all';
    if (accessible.length > 0) return 'department';
    // is_admin со scope=[] (теоретически не возникает: company_scope=[] только если не is_admin)
  }

  // hr (role_code='hr', is_admin=false): полный ПРОСМОТР организации в табеле.
  // Именно 'department' (не 'all') — иначе canAccessEmployeeForTimesheet* (scope==='all')
  // откроет и запись. При 'department' getAll грузит всех сотрудников выбранного отдела
  // (resolveTimesheetScopedDepartmentId → requested id, т.к. accessible='all'), а правка
  // остаётся закрытой (editable-скоуп hr пуст + page can_edit=false → edit-роуты 403).
  if (req.user.role_code === 'hr') return 'department';

  if (await hasManagedTimesheetAccess(req, 'view')) {
    const managedDepartmentIds = await resolveManagedDepartmentIds(req);
    if (managedDepartmentIds.length > 0) {
      return 'department';
    }
  }

  // Псевдо-ячейка: прямые подчинённые (employee_direct_reports) или явные сотрудники
  // табельщицы (employee_object_assignment) — ведёт их табель без managed-отделов.
  // getAll и canAccessEmployeeForTimesheet* ограничивают выборку строго этим набором.
  const directSubs = await resolveEffectiveDirectSubordinates(req);
  if (directSubs.length > 0) {
    return 'department';
  }

  if (req.user.employee_id) {
    return 'self';
  }

  return null;
}

export async function resolveTimesheetScopedDepartmentId(
  req: AuthenticatedRequest,
  requestedDepartmentId?: string | null,
): Promise<string | null> {
  const scope = await resolveTimesheetScope(req);
  if (!scope) {
    return null;
  }

  if (scope === 'all') {
    return requestedDepartmentId ?? null;
  }

  if (scope === 'department') {
    // Табельщица: разрешаем выбор «ЛИНИЯ-Общестрой» в «По отделу», хотя это не её
    // seed-бригада (соседняя ветка). Состав грида при этом сужается до её людей
    // (isTimekeeperLiDeptView в getAll), а правка — только по присутствие-набору
    // (edit-гейт, часть A). В editable-скоуп LI-отдел не входит → массовой правки
    // всего отдела нет.
    if (isTimekeeper(req) && requestedDepartmentId === LI_OBSHESTROY_DEPARTMENT_ID) {
      return LI_OBSHESTROY_DEPARTMENT_ID;
    }
    return resolveScopedDepartmentId(req, requestedDepartmentId);
  }

  return null;
}

export async function canAccessEmployeeForTimesheetPeriod(
  req: AuthenticatedRequest,
  employeeId: number | null | undefined,
  startDate: string,
  endDate: string,
  requireEdit = false,
): Promise<boolean> {
  if (!employeeId) {
    return false;
  }

  const scope = await resolveTimesheetScope(req);
  if (!scope) {
    return false;
  }

  if (scope === 'all') {
    return true;
  }

  if (scope === 'self') {
    return req.user.employee_id === employeeId;
  }

  if (scope === 'department' && req.user.employee_id === employeeId) {
    return true;
  }

  // Объектный view-скоуп (отделы ∩ объекты) ИЛИ hr: для ПРОСМОТРА авторитетен видимый набор.
  if (!requireEdit && (req.user.role_code === 'hr' || await hasObjectViewScope(req))) {
    const acc = await resolveAccessibleEmployeeIds(req);
    return acc === 'all' || acc.has(employeeId);
  }

  const managedDepartmentIds = requireEdit
    ? await resolveEditableDepartmentIds(req)
    : await resolveManagedDepartmentIds(req);
  if (managedDepartmentIds !== 'all' && managedDepartmentIds.length > 0) {
    const employeeIdsByDepartment = await Promise.all(
      managedDepartmentIds.map(departmentId => listEmployeeIdsAssignedToDepartmentPeriod(departmentId, startDate, endDate)),
    );
    if (employeeIdsByDepartment.flat().includes(employeeId)) {
      return true;
    }
  }

  // Табельщица: правка сотрудников ЛИНИЯ-Общестрой, работающих на её объектах
  // («По отделу → ЛИНИЯ-Общестрой»). Бригады правятся веткой editable-seeds выше.
  // Строго LI ∩ её объекты — чужих ИТР/подрядных, прошедших через объект, не пускаем.
  // Read-only не затрагивается: ветка под requireEdit.
  if (requireEdit && isTimekeeper(req)) {
    const editableLi = await resolveTimekeeperEditableLiIds(req);
    if (editableLi.has(employeeId)) {
      return true;
    }
  }

  // Прямые подчинённые руководителя (employee_direct_reports). Для табельщицы пусто —
  // её объектные сотрудники обработаны веткой выше.
  const directSubs = await resolveEffectiveDirectSubordinates(req);
  if (directSubs.includes(employeeId)) {
    return true;
  }

  return false;
}

/**
 * Сужает состав до видимого пользователю — зеркало объектного view-фильтра грида
 * (timesheet.controller.ts, getAll). Применяется ТОЛЬКО для hr и hasObjectViewScope:
 * при обычном полном department-скоупе пересечение с accessible-набором порезало бы
 * исторический состав (переведённые/уволенные в accessible уже не попадают).
 * Начальники участков (supervisorIds) не срезаются — они и в гриде отдельной строкой.
 */
export async function filterEmployeeIdsByTimesheetScope(
  req: AuthenticatedRequest,
  ids: number[],
  supervisorIds?: Set<number>,
): Promise<number[]> {
  if (ids.length === 0) return ids;
  if (req.user.role_code !== 'hr' && !(await hasObjectViewScope(req))) return ids;

  const acc = await resolveAccessibleEmployeeIds(req);
  if (acc === 'all') return ids;
  return ids.filter(id => acc.has(id) || Boolean(supervisorIds?.has(id)));
}

/**
 * Проверка доступа для сотрудников, добавляемых СВЕРХ доступных подразделений
 * (прямые подчинённые выбранного начальника участка). Вызывается ВСЕГДА, для любой
 * роли — иначе прямой подчинённый вне бригад/объектов вызывающего утёк бы в файл.
 * Семантика совпадает с canAccessEmployeeForTimesheetPeriod(requireEdit=false),
 * но наборы резолвятся один раз на весь список, а не на каждого сотрудника.
 */
export async function filterAdditionalEmployeeIdsForTimesheetPeriod(
  req: AuthenticatedRequest,
  ids: number[],
  startDate: string,
  endDate: string,
): Promise<number[]> {
  if (ids.length === 0) return ids;

  const scope = await resolveTimesheetScope(req);
  if (!scope) return [];
  if (scope === 'all') return ids;
  if (scope === 'self') return ids.filter(id => id === req.user.employee_id);

  const allowed = new Set<number>();
  if (req.user.employee_id) allowed.add(req.user.employee_id);

  if (req.user.role_code === 'hr' || await hasObjectViewScope(req)) {
    const acc = await resolveAccessibleEmployeeIds(req);
    if (acc === 'all') return ids;
    for (const id of acc) allowed.add(id);
  } else {
    const managedDepartmentIds = await resolveManagedDepartmentIds(req);
    if (managedDepartmentIds.length > 0) {
      const perDepartment = await Promise.all(
        managedDepartmentIds.map(departmentId => listEmployeeIdsAssignedToDepartmentPeriod(departmentId, startDate, endDate)),
      );
      for (const id of perDepartment.flat()) allowed.add(id);
    }
  }

  for (const id of await resolveEffectiveDirectSubordinates(req)) allowed.add(id);

  return ids.filter(id => allowed.has(id));
}
