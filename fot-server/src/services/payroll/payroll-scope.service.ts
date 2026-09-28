/**
 * Охват раздела «Зарплата»: чьи условия оплаты пользователь видит и правит.
 *
 * Порядок веток важен:
 *  1. Администратор — как раньше, общими резолверами скоупа. Админ компании видит только
 *     свою компанию; оставшийся у него персональный грант охват не расширяет.
 *  2. Персональный доступ к «Зарплате» (миграция 288) у не-админа — весь штат: получатель
 *     (обычно бухгалтер) отделов не ведёт, и по ним список был бы пуст.
 *  3. Остальные — как раньше: отделы и подчинённые пользователя.
 *
 * Свои условия оплаты не-админ не правит ни при каком доступе: раньше canEditEmployeeInScope
 * пускал к себе всегда, но правка «Зарплаты» была только у администраторов. С персональным
 * грантом без этого запрета бухгалтер менял бы себе оклад.
 */
import type { AuthenticatedRequest } from '../../types/index.js';
import {
  canAccessEmployeeInScope,
  canEditEmployeeInScope,
  resolveAccessibleDepartmentIds,
  resolveEditableEmployeeIds,
} from '../data-scope.service.js';
import { getRequestPayrollAccessLevel } from './payroll-access.service.js';

const isSelf = (req: AuthenticatedRequest, employeeId: number): boolean => (
  req.user.employee_id != null && req.user.employee_id === employeeId
);

/** Отделы, чьих сотрудников видно в списке условий оплаты ('all' — весь штат). */
export async function resolvePayrollReadableDepartmentIds(
  req: AuthenticatedRequest,
): Promise<string[] | 'all'> {
  if (req.user.is_admin) return resolveAccessibleDepartmentIds(req);
  if (await getRequestPayrollAccessLevel(req)) return 'all';
  return resolveAccessibleDepartmentIds(req);
}

/** Можно ли смотреть условия оплаты, историю оклада и отпуск сотрудника. */
export async function canReadPayrollEmployee(
  req: AuthenticatedRequest,
  employeeId: number | null | undefined,
): Promise<boolean> {
  if (!employeeId) return false;
  if (req.user.is_admin) return canAccessEmployeeInScope(req, employeeId);
  if (await getRequestPayrollAccessLevel(req)) return true;
  return canAccessEmployeeInScope(req, employeeId);
}

/** Можно ли назначать и менять условия оплаты сотрудника (право страницы — отдельно, в гарде). */
export async function canEditPayrollEmployee(
  req: AuthenticatedRequest,
  employeeId: number | null | undefined,
): Promise<boolean> {
  if (!employeeId) return false;
  if (req.user.is_admin) return canEditEmployeeInScope(req, employeeId);
  if (isSelf(req, employeeId)) return false;
  if ((await getRequestPayrollAccessLevel(req)) === 'edit') return true;
  return canEditEmployeeInScope(req, employeeId);
}

/**
 * Батч-вариант canEditPayrollEmployee для признака can_edit строк списка: один расчёт
 * скоупа на запрос вместо проверки каждой строки.
 */
export async function resolvePayrollEditPredicate(
  req: AuthenticatedRequest,
): Promise<(employeeId: number) => boolean> {
  if (req.user.is_admin) {
    const editable = await resolveEditableEmployeeIds(req);
    return (employeeId) => editable === 'all' || editable.has(employeeId);
  }
  if ((await getRequestPayrollAccessLevel(req)) === 'edit') {
    return (employeeId) => !isSelf(req, employeeId);
  }
  const editable = await resolveEditableEmployeeIds(req);
  return (employeeId) => !isSelf(req, employeeId) && (editable === 'all' || editable.has(employeeId));
}
